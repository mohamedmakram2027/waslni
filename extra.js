// مسارات إضافية: بروفايل، عناوين محفوظة، إشعارات، إلغاء، بلاغات، أرباح المندوب، ولوحة الإدارة الكاملة.
const bcrypt = require('bcryptjs');

module.exports = function ({ app, db, auth, wrap, notify, audit, forget }) {
  const UUID = /^[0-9a-f-]{36}$/i;
  const fail = (res, msg, s = 400) => res.status(s).json({ error: msg });
  const like = q => '%' + String(q || '').trim().replace(/[\\%_]/g, m => '\\' + m).slice(0, 60) + '%';
  const qOrNull = q => (String(q || '').trim() ? like(q) : null);
  const DAYS = v => ([7, 30, 90, 0].includes(+v) ? +v : 30);
  const page = req => [Math.min(Math.max(+req.query.limit || 20, 1), 50), Math.max(+req.query.offset || 0, 0)];
  const STATUSES = ['bidding', 'accepted', 'picked_up', 'delivered', 'cancelled'];

  // ---------- الحساب ----------
  app.patch('/me', auth(), wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 60) return fail(res, 'الاسم لازم يكون من حرفين لـ 60 حرف');
    await db.query('UPDATE users SET name=$1 WHERE id=$2', [name, req.user.id]);
    res.json({ ok: true, name });
  }));

  app.post('/me/password', auth(), wrap(async (req, res) => {
    const { old_password: o, new_password: n } = req.body;
    if (!n || String(n).length < 6) return fail(res, 'كلمة المرور الجديدة 6 أحرف على الأقل');
    const { rows: [u] } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!u || !(await bcrypt.compare(String(o || ''), u.password_hash))) return fail(res, 'كلمة المرور الحالية غلط', 403);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(n), 10), req.user.id]);
    res.json({ ok: true });
  }));

  // ---------- العناوين المحفوظة ----------
  app.get('/addresses', auth(), wrap(async (req, res) => {
    const { rows } = await db.query('SELECT id,label,address,lat,lng FROM saved_addresses WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  }));
  app.post('/addresses', auth(), wrap(async (req, res) => {
    const label = String(req.body.label || '').trim().slice(0, 30), address = String(req.body.address || '').trim().slice(0, 200);
    if (!label || !address) return fail(res, 'اكتب اسم العنوان والعنوان');
    const { rows: [c] } = await db.query('SELECT COUNT(*)::int AS n FROM saved_addresses WHERE user_id=$1', [req.user.id]);
    if (c.n >= 10) return fail(res, 'أقصى عدد عناوين محفوظة 10', 409);
    const lat = Number.isFinite(+req.body.lat) && req.body.lat !== null ? +req.body.lat : null, lng = lat !== null && Number.isFinite(+req.body.lng) ? +req.body.lng : null;
    const { rows: [a] } = await db.query('INSERT INTO saved_addresses(user_id,label,address,lat,lng) VALUES($1,$2,$3,$4,$5) RETURNING id,label,address,lat,lng', [req.user.id, label, address, lat, lng]);
    res.json(a);
  }));
  app.delete('/addresses/:id', auth(), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    await db.query('DELETE FROM saved_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  }));

  // ---------- الإشعارات (مخزّنة في قاعدة البيانات) ----------
  app.get('/notifications', auth(), wrap(async (req, res) => {
    const { rows } = await db.query('SELECT id,title,body,order_id,is_read,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40', [req.user.id]);
    res.json(rows);
  }));
  app.post('/notifications/read', auth(), wrap(async (req, res) => {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND NOT is_read', [req.user.id]);
    res.json({ ok: true });
  }));

  // ---------- الطلبات: تفاصيل / إلغاء / بلاغ ----------
  app.get('/orders/:id', auth(), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const { rows: [o] } = await db.query(
      `SELECT o.*, c.name AS courier_name, c.rating_avg AS courier_rating, cu.name AS customer_name, c.phone AS cph, cu.phone AS cuph
       FROM orders o JOIN users cu ON cu.id=o.customer_id LEFT JOIN users c ON c.id=o.courier_id WHERE o.id=$1`, [req.params.id]);
    const me = req.user;
    if (!o || (me.role !== 'admin' && me.id !== o.customer_id && me.id !== o.courier_id)) return fail(res, 'غير موجود', 404);
    const live = ['accepted', 'picked_up'].includes(o.status);
    const out = { ...o, courier_phone: live ? o.cph : null, customer_phone: live ? o.cuph : null };
    delete out.cph; delete out.cuph;
    if (me.id !== o.customer_id) delete out.delivery_code;           // الكود لصاحب الطلب فقط (حتى لو دوره النشط مندوب)
    res.json(out);
  }));

  app.post('/orders/:id/cancel', auth('customer'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const reason = String(req.body.reason || '').trim().slice(0, 200) || 'بدون سبب';
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const { rows: [o] } = await c.query('SELECT id,title,status,courier_id FROM orders WHERE id=$1 AND customer_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
      if (!o) { await c.query('ROLLBACK'); return fail(res, 'الطلب مش موجود', 404); }
      if (!['bidding', 'accepted'].includes(o.status)) { await c.query('ROLLBACK'); return fail(res, 'مينفعش تلغي الطلب بعد الاستلام', 409); }
      await c.query("UPDATE orders SET status='cancelled',cancel_reason=$2,cancelled_at=now() WHERE id=$1", [o.id, reason]);
      await c.query("UPDATE bids SET status='rejected' WHERE order_id=$1 AND status IN ('pending','accepted')", [o.id]);
      await c.query('COMMIT');
      if (o.courier_id) notify([o.courier_id], 'العميل ألغى الطلب', `${o.title} — السبب: ${reason}`, o.id);
      res.json({ ok: true });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  const CTYPES = ['delay', 'behavior', 'damaged', 'payment', 'other'];
  app.post('/orders/:id/complaint', auth('customer', 'courier'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const type = CTYPES.includes(req.body.type) ? req.body.type : 'other', message = String(req.body.message || '').trim().slice(0, 500);
    if (message.length < 5) return fail(res, 'اكتب تفاصيل المشكلة');
    const { rows: [o] } = await db.query('SELECT id,title,customer_id,courier_id FROM orders WHERE id=$1 AND (customer_id=$2 OR courier_id=$2)', [req.params.id, req.user.id]);
    if (!o) return fail(res, 'الطلب مش موجود', 404);
    const against = o.customer_id === req.user.id ? o.courier_id : o.customer_id;
    const { rows: [c] } = await db.query('INSERT INTO complaints(order_id,user_id,against_user_id,type,message) VALUES($1,$2,$3,$4,$5) RETURNING id', [o.id, req.user.id, against, type, message]);
    const { rows: admins } = await db.query("SELECT id FROM users WHERE role='admin'");
    if (admins.length) notify(admins.map(a => a.id), 'بلاغ جديد ⚠️', `${o.title}: ${message.slice(0, 80)}`, o.id);
    res.json({ id: c.id });
  }));

  app.get('/complaints/mine', auth('customer', 'courier'), wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id,c.type,c.message,c.status,c.admin_note,c.created_at,o.title AS order_title
       FROM complaints c JOIN orders o ON o.id=c.order_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [req.user.id]);
    res.json(rows);
  }));

  // ---------- أرباح المندوب ----------
  app.get('/courier/earnings', auth('courier'), wrap(async (req, res) => {
    const { rows: [t] } = await db.query(
      `SELECT COALESCE(SUM(courier_earning) FILTER (WHERE delivered_at::date=current_date),0) AS today,
              COALESCE(SUM(courier_earning) FILTER (WHERE delivered_at >= now() - interval '7 days'),0) AS week,
              COALESCE(SUM(courier_earning) FILTER (WHERE delivered_at >= now() - interval '30 days'),0) AS month,
              COALESCE(SUM(courier_earning),0) AS total, COUNT(*)::int AS count
       FROM orders WHERE courier_id=$1 AND status='delivered'`, [req.user.id]);
    const { rows: recent } = await db.query(
      `SELECT id,title,final_price,commission_amount,courier_earning,delivered_at FROM orders
       WHERE courier_id=$1 AND status='delivered' ORDER BY delivered_at DESC LIMIT 10`, [req.user.id]);
    res.json({ ...t, recent });
  }));

  // ---------- الإدارة ----------
  app.get('/admin/badges', auth('admin'), wrap(async (req, res) => {
    const { rows: [b] } = await db.query("SELECT (SELECT COUNT(*)::int FROM verifications WHERE status='pending') AS ver, (SELECT COUNT(*)::int FROM complaints WHERE status='open') AS complaints");
    res.json(b);
  }));

  app.get('/admin/dashboard', auth('admin'), wrap(async (req, res) => {
    const days = DAYS(req.query.days), span = days || 30;
    const OF = '($1::int=0 OR o.created_at >= now() - make_interval(days => $1::int))';
    const [k, b, u, st, top, recent, series] = await Promise.all([
      db.query(`SELECT (COUNT(*) FILTER (WHERE o.status='delivered'))::int AS completed,
                       (COUNT(*) FILTER (WHERE o.status IN ('bidding','accepted','picked_up')))::int AS active,
                       (COUNT(*) FILTER (WHERE o.status='cancelled'))::int AS cancelled, COUNT(*)::int AS total,
                       COALESCE(SUM(o.final_price) FILTER (WHERE o.status='delivered'),0) AS gmv,
                       COALESCE(SUM(o.commission_amount) FILTER (WHERE o.status='delivered'),0) AS commission,
                       COALESCE(AVG(o.final_price) FILTER (WHERE o.status='delivered'),0) AS avg_order,
                       COALESCE(AVG(EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))/60) FILTER (WHERE o.accepted_at IS NOT NULL),0) AS avg_accept_min,
                       COALESCE(AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at))/60) FILTER (WHERE o.status='delivered'),0) AS avg_delivery_min
                FROM orders o WHERE ${OF}`, [days]),
      db.query(`SELECT COALESCE(AVG(n),0) AS avg_bids FROM (SELECT COUNT(b.id) AS n FROM orders o LEFT JOIN bids b ON b.order_id=o.id WHERE ${OF} GROUP BY o.id) x`, [days]),
      db.query(`SELECT (COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id AND ur.role='customer')))::int AS customers, (COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id AND ur.role='courier')))::int AS couriers,
                       (COUNT(*) FILTER (WHERE is_verified AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id AND ur.role='courier')))::int AS verified_couriers, (COUNT(*) FILTER (WHERE is_blocked))::int AS blocked,
                       (COUNT(*) FILTER (WHERE $1::int=0 OR created_at >= now() - make_interval(days => $1::int)))::int AS new_users,
                       COALESCE(AVG(rating_avg) FILTER (WHERE rating_count>0 AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id AND ur.role='courier')),0) AS avg_rating FROM users`, [days]),
      db.query(`SELECT o.status::text AS status, COUNT(*)::int AS n FROM orders o WHERE ${OF} GROUP BY o.status ORDER BY o.status`, [days]),
      db.query(`SELECT u.id,u.name,u.rating_avg,COUNT(o.id)::int AS deliveries,COALESCE(SUM(o.final_price),0) AS gmv,COALESCE(SUM(o.courier_earning),0) AS earnings
                FROM orders o JOIN users u ON u.id=o.courier_id
                WHERE o.status='delivered' AND ($1::int=0 OR o.delivered_at >= now() - make_interval(days => $1::int))
                GROUP BY u.id ORDER BY deliveries DESC, gmv DESC LIMIT 5`, [days]),
      db.query(`SELECT o.id,o.title,o.status::text AS status,o.final_price,o.suggested_price,o.created_at,cu.name AS customer_name,c.name AS courier_name
                FROM orders o JOIN users cu ON cu.id=o.customer_id LEFT JOIN users c ON c.id=o.courier_id ORDER BY o.created_at DESC LIMIT 8`),
      db.query(`WITH d AS (SELECT generate_series((current_date - ($1::int - 1))::timestamp, current_date::timestamp, interval '1 day')::date AS day)
                SELECT to_char(d.day,'YYYY-MM-DD') AS day,
                  (SELECT COUNT(*)::int FROM orders WHERE created_at::date=d.day) AS created,
                  (SELECT COUNT(*)::int FROM orders WHERE delivered_at::date=d.day) AS delivered,
                  (SELECT COALESCE(SUM(final_price),0) FROM orders WHERE delivered_at::date=d.day) AS gmv,
                  (SELECT COALESCE(SUM(commission_amount),0) FROM orders WHERE delivered_at::date=d.day) AS commission
                FROM d ORDER BY d.day`, [span])
    ]);
    res.json({ days, kpis: { ...k.rows[0], avg_bids: b.rows[0].avg_bids }, users: u.rows[0], status: st.rows, top: top.rows, recent: recent.rows, series: series.rows });
  }));

  app.get('/admin/orders', auth('admin'), wrap(async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null, [lim, off] = page(req);
    const { rows } = await db.query(
      `SELECT o.id,o.title,o.status::text AS status,o.pickup_address,o.dropoff_address,o.suggested_price,o.final_price,o.commission_amount,o.distance_km,o.cancel_reason,o.created_at,o.delivered_at,
              cu.name AS customer_name,cu.phone AS customer_phone,c.name AS courier_name,c.phone AS courier_phone
       FROM orders o JOIN users cu ON cu.id=o.customer_id LEFT JOIN users c ON c.id=o.courier_id
       WHERE ($1::text IS NULL OR o.status::text=$1::text)
         AND ($2::text IS NULL OR o.title ILIKE $2::text OR cu.name ILIKE $2::text OR cu.phone LIKE $2::text OR c.name ILIKE $2::text)
       ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, [status, qOrNull(req.query.q), lim, off]);
    res.json(rows);
  }));

  app.post('/admin/orders/:id/cancel', auth('admin'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return fail(res, 'اكتب سبب الإلغاء');
    const { rows: [o] } = await db.query("UPDATE orders SET status='cancelled',cancel_reason=$2,cancelled_at=now() WHERE id=$1 AND status IN ('bidding','accepted','picked_up') RETURNING id,title,customer_id,courier_id", [req.params.id, 'إدارة: ' + reason]);
    if (!o) return fail(res, 'الطلب مش قابل للإلغاء', 409);
    await db.query("UPDATE bids SET status='rejected' WHERE order_id=$1 AND status IN ('pending','accepted')", [o.id]);
    notify([o.customer_id, o.courier_id].filter(Boolean), 'تم إلغاء الطلب من الإدارة', `${o.title} — ${reason}`, o.id);
    audit(req, 'cancel_order', o.id, `${o.title}: ${reason}`);
    res.json({ ok: true });
  }));

  app.get('/admin/users', auth('admin'), wrap(async (req, res) => {
    const f = String(req.query.f || 'all'), role = ['customer', 'courier', 'admin'].includes(f) ? f : null, blocked = f === 'blocked' ? true : null, [lim, off] = page(req);
    const { rows } = await db.query(
      `SELECT u.id,u.name,u.phone,u.role::text AS role,COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM user_roles ur WHERE ur.user_id=u.id), ARRAY[u.role::text]) AS roles,u.is_verified,u.is_blocked,u.blocked_reason,u.rating_avg,u.rating_count,u.created_at,v.status::text AS v_status,
              (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id=u.id OR o.courier_id=u.id) AS orders_count
       FROM users u LEFT JOIN verifications v ON v.user_id=u.id
       WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role=$1::text)) AND ($2::boolean IS NULL OR u.is_blocked=$2::boolean)
         AND ($3::text IS NULL OR u.name ILIKE $3::text OR u.phone LIKE $3::text)
       ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`, [role, blocked, qOrNull(req.query.q), lim, off]);
    res.json(rows);
  }));

  app.post('/admin/users/:id/block', auth('admin'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return fail(res, 'اكتب سبب الإيقاف');
    if (req.params.id === req.user.id) return fail(res, 'مينفعش توقف حسابك', 409);
    const { rows: [u] } = await db.query("UPDATE users SET is_blocked=TRUE,blocked_reason=$2 WHERE id=$1 AND role<>'admin' RETURNING name", [req.params.id, reason]);
    if (!u) return fail(res, 'المستخدم مش موجود أو حساب إدارة', 404);
    forget(req.params.id);
    audit(req, 'block', req.params.id, `${u.name}: ${reason}`);
    res.json({ ok: true });
  }));
  app.post('/admin/users/:id/unblock', auth('admin'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const { rows: [u] } = await db.query('UPDATE users SET is_blocked=FALSE,blocked_reason=NULL WHERE id=$1 RETURNING name', [req.params.id]);
    if (!u) return fail(res, 'المستخدم مش موجود', 404);
    forget(req.params.id);
    audit(req, 'unblock', req.params.id, u.name);
    res.json({ ok: true });
  }));

  app.get('/admin/complaints', auth('admin'), wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id,c.type,c.message,c.created_at,c.order_id,o.title AS order_title,u.name AS user_name,u.role::text AS user_role,a.name AS against_name
       FROM complaints c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=c.user_id LEFT JOIN users a ON a.id=c.against_user_id
       WHERE c.status='open' ORDER BY c.created_at LIMIT 50`);
    res.json(rows);
  }));
  app.post('/admin/complaints/:id/resolve', auth('admin'), wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 'غير موجود', 404);
    const note = String(req.body.note || '').trim().slice(0, 300);
    const { rows: [c] } = await db.query("UPDATE complaints SET status='resolved',admin_note=$2,resolved_at=now(),resolved_by=$3 WHERE id=$1 AND status='open' RETURNING user_id,order_id", [req.params.id, note || null, req.user.id]);
    if (!c) return fail(res, 'البلاغ اتعالج قبل كده', 409);
    notify([c.user_id], 'تمت معالجة بلاغك ✅', note || 'راجعنا بلاغك وتم اتخاذ اللازم', c.order_id);
    audit(req, 'resolve_complaint', req.params.id, note);
    res.json({ ok: true });
  }));

  app.get('/admin/audit', auth('admin'), wrap(async (req, res) => {
    const lim = Math.min(Math.max(+req.query.limit || 20, 1), 100);
    const { rows } = await db.query('SELECT a.action,a.target,a.details,a.created_at,u.name AS admin_name FROM audit_log a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT $1', [lim]);
    res.json(rows);
  }));

  app.get('/admin/export/orders.csv', auth('admin'), wrap(async (req, res) => {
    const days = DAYS(req.query.days);
    const { rows } = await db.query(
      `SELECT o.id,o.title,o.status::text AS status,cu.name AS customer,c.name AS courier,o.pickup_address,o.dropoff_address,o.distance_km,o.suggested_price,o.final_price,o.commission_amount,o.courier_earning,o.created_at,o.delivered_at
       FROM orders o JOIN users cu ON cu.id=o.customer_id LEFT JOIN users c ON c.id=o.courier_id
       WHERE ($1::int=0 OR o.created_at >= now() - make_interval(days => $1::int)) ORDER BY o.created_at DESC LIMIT 20000`, [days]);
    const cell = v => { let s = v instanceof Date ? v.toISOString() : String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const cols = ['id', 'title', 'status', 'customer', 'courier', 'pickup_address', 'dropoff_address', 'distance_km', 'suggested_price', 'final_price', 'commission_amount', 'courier_earning', 'created_at', 'delivered_at'];
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
    audit(req, 'export', 'orders.csv', `days=${days}`);
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="orders.csv"').send('\ufeff' + csv);
  }));
};
