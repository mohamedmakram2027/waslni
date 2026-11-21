// المرحلة 1: الملف الشخصي — نبذة + صورة شخصية + عرض ملف مستخدم آخر وفق الخصوصية.
// الخصوصية: الملف يظهر لصاحبه وللإدارة ولمن بينهم تعامل فعلي (طلب أو عرض مشترك) فقط. رقم الهاتف لا يظهر إلا لصاحب الحساب والإدارة.
const fs = require('fs'), path = require('path');

module.exports = function ({ app, db, auth, wrap, saveImg, UP }) {
  const UUID = /^[0-9a-f-]{36}$/i;
  const fail = (res, msg, s = 400) => res.status(s).json({ error: msg });
  const clean = s => String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

  // هل يحق لـ viewer رؤية ملف targetId؟
  async function canView(viewer, targetId) {
    if (viewer.id === targetId || viewer.role === 'admin') return true;
    const { rowCount } = await db.query(
      `SELECT 1 FROM orders o WHERE (o.customer_id=$1 AND o.courier_id=$2) OR (o.customer_id=$2 AND o.courier_id=$1)
       UNION ALL
       SELECT 1 FROM bids b JOIN orders o ON o.id=b.order_id
        WHERE b.status<>'withdrawn' AND ((b.courier_id=$2 AND o.customer_id=$1) OR (b.courier_id=$1 AND o.customer_id=$2))
       LIMIT 1`, [viewer.id, targetId]);
    return rowCount > 0;
  }

  app.get('/profile/:id', auth(), wrap(async (req, res) => {
    const id = req.params.id === 'me' ? req.user.id : req.params.id;
    if (!UUID.test(id)) return fail(res, 'مش موجود', 404);
    if (!(await canView(req.user, id))) return fail(res, 'مش مسموح تشوف الملف ده', 403);
    const { rows: [u] } = await db.query(
      `SELECT u.id,u.name,u.phone,u.role,u.bio,u.avatar,u.is_verified,u.rating_avg,u.rating_count,u.created_at,
              (SELECT COUNT(*)::int FROM orders o WHERE o.status='delivered' AND (o.courier_id=u.id OR o.customer_id=u.id)) AS completed,
              (SELECT v.vehicle_type FROM verifications v WHERE v.user_id=u.id AND v.status='approved') AS vehicle_type,
              COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM user_roles ur WHERE ur.user_id=u.id), ARRAY[u.role::text]) AS roles
       FROM users u WHERE u.id=$1`, [id]);
    if (!u) return fail(res, 'مش موجود', 404);
    const self = id === req.user.id;
    res.json({
      id: u.id, name: u.name, role: u.role, roles: u.roles || [u.role], bio: u.bio || '',
      has_avatar: !!u.avatar, avatar_v: u.avatar ? u.avatar.slice(0, 8) : null,
      is_verified: u.is_verified, rating_avg: u.rating_avg, rating_count: u.rating_count,
      member_since: u.created_at, completed: u.completed,
      vehicle_type: (u.roles || [u.role]).includes('courier') ? u.vehicle_type : null,
      is_self: self, ...(self || req.user.role === 'admin' ? { phone: u.phone } : {})
    });
  }));

  app.patch('/me/profile', auth(), wrap(async (req, res) => {
    const bio = clean(req.body.bio);
    if (bio.length > 300) return fail(res, 'النبذة 300 حرف بحد أقصى');
    await db.query('UPDATE users SET bio=$1 WHERE id=$2', [bio || null, req.user.id]);
    res.json({ ok: true, bio });
  }));

  app.post('/me/avatar', auth(), wrap(async (req, res) => {
    const f = saveImg(req.body.image);                       // JPEG فقط وبحجم محدود (نفس فحوصات صور التوثيق)
    const { rows: [old] } = await db.query('SELECT avatar FROM users WHERE id=$1', [req.user.id]);
    try { await db.query('UPDATE users SET avatar=$1 WHERE id=$2', [f, req.user.id]); }
    catch (e) { fs.unlink(path.join(UP, f), () => {}); throw e; }
    if (old && old.avatar) fs.unlink(path.join(UP, old.avatar), () => {});
    res.json({ ok: true, avatar_v: f.slice(0, 8) });
  }));

  app.delete('/me/avatar', auth(), wrap(async (req, res) => {
    const { rows: [old] } = await db.query('SELECT avatar FROM users WHERE id=$1', [req.user.id]);
    await db.query('UPDATE users SET avatar=NULL WHERE id=$1', [req.user.id]);
    if (old && old.avatar) fs.unlink(path.join(UP, old.avatar), () => {});
    res.json({ ok: true });
  }));

  // صورة العرض: الصورة الشخصية لو موجودة، وإلا سيلفي التوثيق (لو معتمد) — بنفس صلاحيات الملف الشخصي
  app.get('/photo/face/:uid', auth(), wrap(async (req, res) => {
    const uid = req.params.uid;
    if (!UUID.test(uid) || !(await canView(req.user, uid))) return res.status(404).end();
    const { rows: [r] } = await db.query(
      `SELECT u.avatar, (SELECT v.selfie FROM verifications v WHERE v.user_id=u.id AND v.status='approved') AS selfie FROM users u WHERE u.id=$1`, [uid]);
    const f = r && (r.avatar || r.selfie);
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600').type('jpeg').sendFile(path.join(UP, f));
  }));
};
