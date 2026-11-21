// المرحلة 3: تعدد الأدوار — حساب واحد يقدر يبقى عميل و/أو مندوب، ويبدّل بينهم من غير حساب جديد.
// الدور النشط هو اللي في التوكن (role)، فكل auth('courier') / auth('customer') الحالية تفضل شغالة كما هي.
// الإدارة حساب منفصل: ما تتضافش ولا بتُضاف لها أدوار تانية.
const VEHICLES = ['scooter', 'bike', 'car', 'walk'];

module.exports = function ({ app, db, auth, wrap, sign }) {
  const fail = (res, msg, s = 400, extra = {}) => res.status(s).json({ error: msg, ...extra });
  const SELF_ROLES = ['customer', 'courier'];          // الأدوار اللي المستخدم يقدر يضيفها لنفسه

  async function rolesOf(id) {
    const { rows } = await db.query('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [id]);
    return rows.map(r => r.role);
  }

  // إيه الناقص عشان صفة المندوب تشتغل؟ (التوثيق إجباري قبل أي عرض، ونوع المركبة مطلوب للمندوب)
  async function courierNeeds(id) {
    const { rows: [v] } = await db.query('SELECT status,vehicle_type FROM verifications WHERE user_id=$1', [id]);
    if (!v || v.status === 'rejected') return 'verify';        // لسه ما قدّمش توثيق (أو اترفض)
    if (v.status === 'pending') return v.vehicle_type ? 'wait' : 'vehicle';
    return v.vehicle_type ? null : 'vehicle';                  // موثّق كعميل بدون نوع مركبة
  }

  app.get('/me/roles', auth(), wrap(async (req, res) => {
    res.json({ active: req.user.role, roles: await rolesOf(req.user.id) });
  }));

  // إضافة صفة جديدة لنفس الحساب
  app.post('/me/roles', auth('customer', 'courier'), wrap(async (req, res) => {
    const role = String(req.body.role || '');
    if (!SELF_ROLES.includes(role)) return fail(res, 'صفة غير صالحة');
    const ins = await db.query('INSERT INTO user_roles(user_id,role) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, role]);
    if (!ins.rowCount) return fail(res, 'عندك الصفة دي بالفعل', 409);
    res.json({ roles: await rolesOf(req.user.id), next: role === 'courier' ? await courierNeeds(req.user.id) : null });
  }));

  // تبديل الدور النشط: بيرجّع توكن جديد بالدور المطلوب (بعد التأكد إنه من أدوار الحساب فعلًا)
  app.post('/me/switch-role', auth('customer', 'courier'), wrap(async (req, res) => {
    const role = String(req.body.role || '');
    if (!SELF_ROLES.includes(role)) return fail(res, 'صفة غير صالحة');
    const roles = await rolesOf(req.user.id);
    if (!roles.includes(role)) return fail(res, 'الصفة دي مش مضافة على حسابك', 403);
    const { rows: [u] } = await db.query('UPDATE users SET last_role=$1 WHERE id=$2 RETURNING id,name,phone', [role, req.user.id]);
    if (!u) return fail(res, 'الحساب غير موجود', 404);
    res.json({ token: sign({ id: u.id, role }, roles), user: { id: u.id, name: u.name, phone: u.phone, role, roles }, next: role === 'courier' ? await courierNeeds(u.id) : null });
  }));

  // نوع المركبة لحساب موثّق كعميل ثم أضاف صفة مندوب. بيتحدد مرة واحدة فقط (لو فاضي) — تغييره بعد كده بيمر على الإدارة.
  app.post('/verification/vehicle', auth('courier'), wrap(async (req, res) => {
    const vt = VEHICLES.includes(req.body.vehicle_type) ? req.body.vehicle_type : null;
    if (!vt) return fail(res, 'اختار نوع المركبة');
    const plate = String(req.body.plate || '').trim().slice(0, 20) || null;
    const { rowCount } = await db.query('UPDATE verifications SET vehicle_type=$1, plate=$2 WHERE user_id=$3 AND vehicle_type IS NULL', [vt, plate, req.user.id]);
    if (rowCount) return res.json({ ok: true });
    const { rows: [v] } = await db.query('SELECT vehicle_type FROM verifications WHERE user_id=$1', [req.user.id]);
    return v ? fail(res, 'نوع المركبة متسجّل بالفعل', 409) : fail(res, 'وثّق هويتك الأول', 409, { code: 'NOT_VERIFIED' });
  }));
};
