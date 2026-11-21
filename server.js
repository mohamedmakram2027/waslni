require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const app = express();
app.set('trust proxy', 1);   // خلف Render/Railway: عشان req.ip يطلع IP العميل الحقيقي

// ---------- الإشعارات (Firebase Cloud Messaging) – اختياري ----------
let fcm = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    fcm = admin.messaging();
  } else console.log('الإشعارات غير مفعّلة (FIREBASE_SERVICE_ACCOUNT ناقص)');
} catch (e) { console.log('FCM error:', e.message); }
async function pushTo(sql, params, title, body) {
  if (!fcm) return;
  try {
    const { rows } = await db.query(sql, params);
    rows.forEach(r => fcm.send({ token: r.push_token, notification: { title, body } }).catch(() => {}));
  } catch (e) { console.error('push', e.message); }
}
async function notify(ids, title, body, orderId) {            // يخزّن الإشعار في قاعدة البيانات + يبعت Push لو متفعّل
  try { await db.query('INSERT INTO notifications(user_id,title,body,order_id) SELECT unnest($1::uuid[]),$2::text,$3::text,$4::uuid', [ids, title, body, orderId || null]); } catch (e) { console.error('notif', e.message); }
  return pushTo('SELECT push_token FROM users WHERE id=ANY($1::uuid[]) AND push_token IS NOT NULL', [ids], title, body);
}
const audit = (req, action, target, details) => db.query('INSERT INTO audit_log(admin_id,action,target,details) VALUES($1,$2,$3,$4)', [req.user.id, action, target || null, details || null]).catch(e => console.error('audit', e.message));
async function notifyCouriers(title, body, exceptId) {          // exceptId: صاحب الطلب (لو عنده صفة مندوب كمان ما يتبلّغش بطلبه)
  const ex = exceptId || null;
  try { await db.query("INSERT INTO notifications(user_id,title,body) SELECT u.id,$1::text,$2::text FROM users u JOIN verifications v ON v.user_id=u.id WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role='courier') AND v.status='approved' AND NOT u.is_blocked AND u.id IS DISTINCT FROM $3::uuid LIMIT 500", [title, body, ex]); } catch (e) { console.error('notif', e.message); }
  return pushTo("SELECT push_token FROM users u WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role='courier') AND NOT is_blocked AND push_token IS NOT NULL AND u.id IS DISTINCT FROM $1::uuid LIMIT 500", [ex], title, body);
}
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(require('path').join(__dirname, 'www'))); // يقدّم الواجهة للتجربة

const wrap = fn => (req, res) => fn(req, res).catch(e => { if (e.status) return res.status(e.status).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); });
const sign = (u, roles) => jwt.sign({ id: u.id, role: u.role, ...(roles ? { roles } : {}) }, process.env.JWT_SECRET, { expiresIn: '30d' });   // role = الدور النشط

// ===HELPERS_START
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const KEY = crypto.createHash('sha256').update(process.env.ENC_KEY || process.env.JWT_SECRET || 'dev').digest();
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
const dec = b => { const x = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, x.subarray(0, 12)); d.setAuthTag(x.subarray(12, 28)); return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8'); };
const hmac = t => crypto.createHmac('sha256', KEY).update(t).digest('hex');
const UP = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'); fs.mkdirSync(UP, { recursive: true });   // خاص: غير متاح للعامة
const digits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
function normPhone(p) { let d = digits(p); if (d.startsWith('20') && d.length === 12) d = '0' + d.slice(2); return /^01[0125]\d{8}$/.test(d) ? d : null; }
const GOV = { '01':'القاهرة','02':'الإسكندرية','03':'بورسعيد','04':'السويس','11':'دمياط','12':'الدقهلية','13':'الشرقية','14':'القليوبية','15':'كفر الشيخ','16':'الغربية','17':'المنوفية','18':'البحيرة','19':'الإسماعيلية','21':'الجيزة','22':'بني سويف','23':'الفيوم','24':'المنيا','25':'أسيوط','26':'سوهاج','27':'قنا','28':'أسوان','29':'الأقصر','31':'البحر الأحمر','32':'الوادي الجديد','33':'مطروح','34':'شمال سيناء','35':'جنوب سيناء','88':'خارج الجمهورية' };
function parseNid(raw) {
  const n = digits(raw); if (!/^[23]\d{13}$/.test(n)) return null;
  const y = (n[0] === '2' ? 1900 : 2000) + +n.slice(1, 3), m = +n.slice(3, 5), d = +n.slice(5, 7), dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || !GOV[n.slice(7, 9)]) return null;
  const age = (Date.now() - dt) / 31557600000; if (age < 18 || age > 75) return null;
  return { n, birth: dt.toISOString().slice(0, 10), gender: (+n[12]) % 2 ? 'male' : 'female', gov: n.slice(7, 9) };
}
function saveImg(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length < 5000 || buf.length > 3 * 1024 * 1024 || buf[0] !== 0xFF || buf[1] !== 0xD8) throw Object.assign(new Error('إحدى الصور غير صالحة، صوّرها تاني'), { status: 400 });
  const f = crypto.randomUUID() + '.jpg'; fs.writeFileSync(path.join(UP, f), buf); return f;
}
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a || '')).digest(), y = crypto.createHash('sha256').update(String(b || '')).digest(); return crypto.timingSafeEqual(x, y); };
const adminTries = new Map();                                   // 5 محاولات كل 15 دقيقة لكل IP
function adminCodeCheck(req) {
  const now = Date.now(), t = (adminTries.get(req.ip) || []).filter(x => now - x < 900000);
  if (t.length >= 5) return 'blocked';
  t.push(now); adminTries.set(req.ip, t);
  return !!process.env.ADMIN_CODE && safeEq(req.body.admin_code, process.env.ADMIN_CODE);
}
// ===HELPERS_END
const otp = require('./otp')({ app, db, wrap, normPhone });   // المرحلة 2: OTP (يسجّل /auth/otp/send و /auth/otp/verify)

const blockCache = new Map();                                    // كاش 30 ثانية لفحص الإيقاف
const forget = id => blockCache.delete(id);
async function isBlocked(id) {
  const c = blockCache.get(id); if (c && Date.now() - c.t < 30000) return c.v;
  const { rows: [u] } = await db.query('SELECT is_blocked FROM users WHERE id=$1', [id]);
  const v = !u || u.is_blocked; blockCache.set(id, { v, t: Date.now() }); return v;
}
function auth(...roles) {
  return async (req, res, next) => {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(t, process.env.JWT_SECRET);
    } catch { return res.status(401).json({ error: 'سجّل الدخول' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'غير مسموح' });
    try { if (await isBlocked(req.user.id)) return res.status(401).json({ error: 'الحساب موقوف أو غير موجود' }); next(); }
    catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
  };
}

// ---------- حسابات ----------
app.post('/auth/register', wrap(async (req, res) => {
  const { name, password, role } = req.body, phone = normPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'رقم الموبايل غير صحيح' });
  if (!name || name.trim().length < 2 || !password || password.length < 6) return res.status(400).json({ error: 'بيانات ناقصة' });
  let r = role === 'courier' ? 'courier' : 'customer';
  if (role === 'admin') {                                       // التسجيل كإدارة بالكود السري (ADMIN_CODE)
    const ok = adminCodeCheck(req);
    if (ok === 'blocked') return res.status(429).json({ error: 'محاولات كتير، جرّب بعد 15 دقيقة' });
    if (!ok) return res.status(403).json({ error: 'كود الإدارة غير صحيح' });
    r = 'admin';
  }
  let otpId = null;                                             // غير الإدارة: لازم إثبات ملكية الرقم بـ OTP قبل إنشاء الحساب
  if (r !== 'admin') {
    otpId = await otp.take(req.body.otp_token, phone);
    if (!otpId) return res.status(403).json({ error: 'لازم تتحقق من رقم موبايلك الأول', code: 'PHONE_NOT_VERIFIED' });
  }
  try {
    const { rows } = await db.query(
      `WITH u AS (INSERT INTO users(name,phone,password_hash,role,last_role) VALUES($1,$2,$3,$4::text::user_role,$4::text) RETURNING id,name,phone,role),
            r AS (INSERT INTO user_roles(user_id,role) SELECT id,role::text FROM u)
       SELECT id,name,phone,role FROM u`,
      [name, phone, await bcrypt.hash(password, 10), r]);
    if (otpId) await otp.markVerified(rows[0].id);
    res.json({ user: { ...rows[0], roles: [r] }, token: sign(rows[0], [r]) });
  } catch (e) {
    if (otpId) await otp.release(otpId);
    if (e.code === '23505') return res.status(409).json({ error: 'الرقم مسجل قبل كده' });
    throw e;
  }
}));

app.post('/auth/login', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE phone=$1', [normPhone(req.body.phone)]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(401).json({ error: 'بيانات غلط' });
  if (u.is_blocked) return res.status(403).json({ error: 'حسابك موقوف' + (u.blocked_reason ? ': ' + u.blocked_reason : '') });
  const { rows: rr } = await db.query('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [u.id]);
  const roles = rr.length ? rr.map(x => x.role) : [u.role];
  const active = roles.includes(u.last_role) ? u.last_role : (roles.includes(u.role) ? u.role : roles[0]);
  res.json({ user: { id: u.id, name: u.name, phone: u.phone, role: active, roles }, token: sign({ id: u.id, role: active }, roles) });
}));

// ---------- العميل ----------
app.post('/orders', auth('customer'), wrap(async (req, res) => {
  const o = req.body;
  if (!o.title || !o.pickup_address || !o.dropoff_address || !(o.suggested_price > 0)) return res.status(400).json({ error: 'بيانات ناقصة' });
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const { rows } = await db.query(
    `INSERT INTO orders(customer_id,title,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,distance_km,suggested_price,delivery_code)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.user.id, o.title, o.pickup_address, o.pickup_lat, o.pickup_lng, o.dropoff_address, o.dropoff_lat, o.dropoff_lng, o.distance_km, o.suggested_price, code]);
  notifyCouriers('طلب توصيل جديد 🏍️', rows[0].title + ' – قدّم عرضك الآن', req.user.id);
  res.json(rows[0]);
}));

app.get('/orders/mine', auth(), wrap(async (req, res) => {
  const col = req.user.role === 'courier' ? 'o.courier_id' : 'o.customer_id';
  const { rows } = await db.query(
    `SELECT o.*, c.name AS courier_name, c.rating_avg AS courier_rating, cu.name AS customer_name,
            CASE WHEN o.status IN ('accepted','picked_up') THEN c.phone END AS courier_phone,
            CASE WHEN o.status IN ('accepted','picked_up') THEN cu.phone END AS customer_phone
     FROM orders o LEFT JOIN users c ON c.id=o.courier_id JOIN users cu ON cu.id=o.customer_id
     WHERE ${col}=$1 ORDER BY o.created_at DESC`, [req.user.id]);
  if (req.user.role === 'courier') rows.forEach(r => delete r.delivery_code); // المندوب ما يشوفش الكود
  res.json(rows);
}));

app.get('/orders/:id/bids', auth('customer'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id,b.price,b.eta_minutes,b.status,b.courier_id,u.name,u.rating_avg,u.rating_count,u.is_verified,(SELECT vehicle_type FROM verifications v WHERE v.user_id=u.id) AS vehicle_type
     FROM bids b JOIN users u ON u.id=b.courier_id JOIN orders o ON o.id=b.order_id
     WHERE b.order_id=$1 AND o.customer_id=$2 AND b.status<>'withdrawn' ORDER BY b.price`, [req.params.id, req.user.id]);
  res.json(rows);
}));

// قبول عرض + حساب العمولة (داخل transaction)
app.post('/orders/:id/accept/:bidId', auth('customer'), wrap(async (req, res) => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND customer_id=$2 AND status='bidding' FOR UPDATE", [req.params.id, req.user.id]);
    if (!o) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'الطلب مش متاح' }); }
    const { rows: [b] } = await c.query("SELECT * FROM bids WHERE id=$1 AND order_id=$2 AND status='pending'", [req.params.bidId, o.id]);
    if (!b) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'العرض مش موجود' }); }
    const { rows: [s] } = await c.query("SELECT value FROM settings WHERE key='commission_rate'");
    const rate = Number(s.value), com = +(b.price * rate / 100).toFixed(2);
    await c.query("UPDATE bids SET status = CASE WHEN id=$1 THEN 'accepted'::bid_status ELSE 'rejected'::bid_status END WHERE order_id=$2", [b.id, o.id]);
    const { rows: [u] } = await c.query(
      `UPDATE orders SET status='accepted',courier_id=$1,accepted_bid_id=$2,final_price=$3,commission_rate=$4,commission_amount=$5,courier_earning=$6,accepted_at=now()
       WHERE id=$7 RETURNING *`, [b.courier_id, b.id, b.price, rate, com, +(b.price - com).toFixed(2), o.id]);
    await c.query('COMMIT');
    notify([b.courier_id], 'تم قبول عرضك ✅', 'روح استلم الطلب: ' + o.title);
    res.json(u);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.post('/orders/:id/rate', auth('customer'), wrap(async (req, res) => {
  const stars = +req.body.stars;
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'تقييم من 1 لـ 5' });
  const { rows: [o] } = await db.query("SELECT * FROM orders WHERE id=$1 AND customer_id=$2 AND status='delivered'", [req.params.id, req.user.id]);
  if (!o) return res.status(409).json({ error: 'مينفعش تقيّم دلوقتي' });
  await db.query('INSERT INTO ratings(order_id,courier_id,stars,comment) VALUES($1,$2,$3,$4)', [o.id, o.courier_id, stars, req.body.comment || null]);
  await db.query('UPDATE users SET rating_avg=(rating_avg*rating_count+$1)/(rating_count+1), rating_count=rating_count+1 WHERE id=$2', [stars, o.courier_id]);
  res.json({ ok: true });
}));

// ---------- المندوب ----------
app.get('/orders/open', auth('courier'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.id,o.title,o.pickup_address,o.dropoff_address,o.distance_km,o.suggested_price,
            (SELECT MIN(price) FROM bids WHERE order_id=o.id AND status='pending') AS lowest_bid,
            (SELECT is_verified FROM users WHERE id=o.customer_id) AS customer_verified
     FROM orders o WHERE o.status='bidding' AND o.customer_id<>$1 ORDER BY o.created_at DESC LIMIT 50`, [req.user.id]);
  res.json(rows);
}));

app.post('/orders/:id/bids', auth('courier'), wrap(async (req, res) => {
  const price = +req.body.price;
  if (!(price > 0)) return res.status(400).json({ error: 'سعر غلط' });
  const { rows: [vv] } = await db.query('SELECT status,vehicle_type FROM verifications WHERE user_id=$1', [req.user.id]);
  if (!vv || vv.status !== 'approved') return res.status(403).json({ error: 'لازم يتم توثيق حسابك الأول', code: 'NOT_VERIFIED' });
  if (!vv.vehicle_type) return res.status(403).json({ error: 'حدّد نوع مركبتك الأول من حسابي', code: 'NO_VEHICLE' });   // حساب موثّق كعميل ثم أضاف صفة مندوب
  const { rows: [o] } = await db.query("SELECT id,customer_id,title FROM orders WHERE id=$1 AND status='bidding'", [req.params.id]);
  if (!o) return res.status(409).json({ error: 'الطلب مقفول' });
  if (o.customer_id === req.user.id) return res.status(409).json({ error: 'مينفعش تقدّم عرض على طلبك أنت', code: 'OWN_ORDER' });
  const { rows } = await db.query(
    `INSERT INTO bids(order_id,courier_id,price,eta_minutes) VALUES($1,$2,$3,$4)
     ON CONFLICT (order_id,courier_id) DO UPDATE SET price=EXCLUDED.price, eta_minutes=EXCLUDED.eta_minutes, status='pending' RETURNING *`,
    [o.id, req.user.id, price, +req.body.eta_minutes || 15]);
  notify([o.customer_id], 'وصلك عرض جديد 💬', `${price} ج.م على طلب: ${o.title}`);
  res.json(rows[0]);
}));

app.post('/orders/:id/picked-up', auth('courier'), wrap(async (req, res) => {
  const { rows: pu } = await db.query("UPDATE orders SET status='picked_up',picked_up_at=now() WHERE id=$1 AND courier_id=$2 AND status='accepted' RETURNING customer_id", [req.params.id, req.user.id]);
  if (pu[0]) notify([pu[0].customer_id], 'المندوب استلم طلبك 🛵', 'في الطريق إليك الآن');
  pu[0] ? res.json({ ok: true }) : res.status(409).json({ error: 'حالة غير صالحة' });
}));

// التسليم بكود المستلم + تسجيل العمولة في سجل المنصة
app.post('/orders/:id/deliver', auth('courier'), wrap(async (req, res) => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND courier_id=$2 AND status='picked_up' FOR UPDATE", [req.params.id, req.user.id]);
    if (!o) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'حالة غير صالحة' }); }
    if (o.delivery_code !== String(req.body.code)) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'كود التسليم غلط' }); }
    await c.query("UPDATE orders SET status='delivered',delivered_at=now() WHERE id=$1", [o.id]);
    await c.query("INSERT INTO wallet_transactions(user_id,order_id,type,amount) VALUES(NULL,$1,'commission',$2)", [o.id, o.commission_amount]);
    await c.query("INSERT INTO wallet_transactions(user_id,order_id,type,amount) VALUES($1,$2,'payout',$3)", [o.courier_id, o.id, o.courier_earning]);
    await c.query('COMMIT');
    notify([o.customer_id], 'تم تسليم طلبك ✅', 'لا تنسَ تقييم المندوب ⭐');
    res.json({ ok: true, earning: o.courier_earning });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.post('/orders/:id/location', auth('courier'), wrap(async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'إحداثيات غلط' });
  const { rows: [o] } = await db.query("SELECT id FROM orders WHERE id=$1 AND courier_id=$2 AND status IN ('accepted','picked_up')", [req.params.id, req.user.id]);
  if (!o) return res.status(409).json({ error: 'مش مشوارك' });
  await db.query('INSERT INTO tracking_points(order_id,courier_id,lat,lng) VALUES($1,$2,$3,$4)', [o.id, req.user.id, lat, lng]);
  res.json({ ok: true });
}));

// ---------- التتبع (العميل بيسأل كل 3-5 ثواني) ----------
app.get('/orders/:id/track', auth(), wrap(async (req, res) => {
  const { rows: [o] } = await db.query('SELECT id,status,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,customer_id,courier_id FROM orders WHERE id=$1', [req.params.id]);
  if (!o || ![o.customer_id, o.courier_id].includes(req.user.id)) return res.status(404).json({ error: 'مش موجود' });
  const { rows: [p] } = await db.query('SELECT lat,lng,created_at FROM tracking_points WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [o.id]);
  res.json({ status: o.status, courier_location: p || null, pickup: [o.pickup_lat, o.pickup_lng], dropoff: [o.dropoff_lat, o.dropoff_lng] });
}));

// ---------- الإدارة ----------
app.get('/admin/stats', auth('admin'), wrap(async (req, res) => {
  const { rows: [s] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='delivered') AS completed,
            COUNT(*) FILTER (WHERE status IN ('bidding','accepted','picked_up')) AS active,
            COALESCE(SUM(final_price) FILTER (WHERE status='delivered'),0) AS gmv,
            COALESCE(SUM(commission_amount) FILTER (WHERE status='delivered'),0) AS commission FROM orders`);
  res.json(s);
}));

app.post('/admin/commission', auth('admin'), wrap(async (req, res) => {
  const r = +req.body.rate;
  if (!(r >= 0 && r <= 30)) return res.status(400).json({ error: 'نسبة من 0 لـ 30' });
  await db.query("UPDATE settings SET value=$1 WHERE key='commission_rate'", [String(r)]);
  audit(req, 'commission', String(r), `${r}%`);
  res.json({ rate: r });
}));

app.post('/admin/couriers/:id/verify', auth('admin'), wrap(async (req, res) => {
  await db.query("UPDATE users SET is_verified=TRUE WHERE id=$1 AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=users.id AND ur.role='courier')", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- توثيق الهوية ----------
app.get('/config', wrap(async (req, res) => {
  const { rows } = await db.query("SELECT value FROM settings WHERE key='commission_rate'");
  res.json({ commission_rate: Number(rows[0].value) });
}));

app.get('/me', auth(), wrap(async (req, res) => {
  const { rows: [u] } = await db.query(
    `SELECT u.id,u.name,u.phone,u.role,u.is_verified,u.rating_avg,u.rating_count,v.status AS v_status,v.reject_reason,v.vehicle_type,
            (SELECT COUNT(*)::int FROM notifications n WHERE n.user_id=u.id AND NOT n.is_read) AS unread,
            COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM user_roles ur WHERE ur.user_id=u.id), ARRAY[u.role::text]) AS roles
     FROM users u LEFT JOIN verifications v ON v.user_id=u.id WHERE u.id=$1`, [req.user.id]);
  if (u) u.role = req.user.role;                                  // الدور النشط (من التوكن) مش الدور الأصلي
  res.json(u);
}));

app.post('/verification', auth('customer', 'courier'), wrap(async (req, res) => {
  const b = req.body, id = parseNid(b.national_id);
  if (!id) return res.status(400).json({ error: 'الرقم القومي غير صحيح (أو السن خارج 18–75)' });
  const vt = ['scooter', 'bike', 'car', 'walk'].includes(b.vehicle_type) ? b.vehicle_type : null;
  if (req.user.role === 'courier' && !vt) return res.status(400).json({ error: 'اختار نوع المركبة' });
  const { rows: [cur] } = await db.query('SELECT status FROM verifications WHERE user_id=$1', [req.user.id]);
  if (cur && cur.status !== 'rejected') return res.status(409).json({ error: cur.status === 'approved' ? 'حسابك موثّق بالفعل' : 'طلبك قيد المراجعة' });
  const files = [b.id_front, b.id_back, b.selfie].map(saveImg);
  try {
    await db.query(
      `INSERT INTO verifications(user_id,national_id_enc,national_id_hash,birth_date,gender,governorate,id_front,id_back,selfie,vehicle_type,plate)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id) DO UPDATE SET national_id_enc=EXCLUDED.national_id_enc,national_id_hash=EXCLUDED.national_id_hash,birth_date=EXCLUDED.birth_date,
         gender=EXCLUDED.gender,governorate=EXCLUDED.governorate,id_front=EXCLUDED.id_front,id_back=EXCLUDED.id_back,selfie=EXCLUDED.selfie,
         vehicle_type=EXCLUDED.vehicle_type,plate=EXCLUDED.plate,status='pending',reject_reason=NULL,submitted_at=now(),reviewed_at=NULL`,
      [req.user.id, enc(id.n), hmac(id.n), id.birth, id.gender, id.gov, ...files, vt, String(b.plate || '').slice(0, 20) || null]);
  } catch (e) {
    files.forEach(f => fs.unlink(path.join(UP, f), () => {}));
    if (e.code === '23505') return res.status(409).json({ error: 'الرقم القومي ده مسجل على حساب تاني' });
    throw e;
  }
  res.json({ status: 'pending' });
}));

const KINDS = { front: 'id_front', back: 'id_back', selfie: 'selfie' };
async function sendPhoto(res, uid, kind, onlyApproved) {
  if (!/^[0-9a-f-]{36}$/i.test(uid) || !KINDS[kind]) return res.status(404).end();
  const { rows: [v] } = await db.query(`SELECT ${KINDS[kind]} AS f FROM verifications WHERE user_id=$1 ${onlyApproved ? "AND status='approved'" : ''}`, [uid]);
  if (!v) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600').type('jpeg').sendFile(path.join(UP, v.f));
}
app.get('/photo/selfie/:uid', auth(), wrap(async (req, res) => {
  const uid = req.params.uid;
  if (req.user.role === 'admin' || req.user.id === uid) return sendPhoto(res, uid, 'selfie', false);
  // العميل يشوف صورة المندوب اللي قدّم له عرض فقط (وموثّق)
  const { rowCount } = await db.query('SELECT 1 FROM bids b JOIN orders o ON o.id=b.order_id WHERE b.courier_id=$1 AND o.customer_id=$2 LIMIT 1', [uid, req.user.id]);
  if (!rowCount) return res.status(403).end();
  sendPhoto(res, uid, 'selfie', true);
}));

app.get('/admin/verifications', auth('admin'), wrap(async (req, res) => {
  const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await db.query(
    `SELECT v.user_id,u.name,u.phone,u.role,v.national_id_enc,v.birth_date,v.gender,v.governorate,v.vehicle_type,v.plate,v.status,v.submitted_at
     FROM verifications v JOIN users u ON u.id=v.user_id WHERE v.status=$1 ORDER BY v.submitted_at LIMIT 50`, [st]);
  res.json(rows.map(({ national_id_enc, ...x }) => ({ ...x, national_id: dec(national_id_enc), governorate_name: GOV[x.governorate] })));
}));
app.get('/admin/verifications/:uid/:kind', auth('admin'), wrap(async (req, res) => sendPhoto(res, req.params.uid, req.params.kind, false)));
app.post('/admin/verifications/:uid/approve', auth('admin'), wrap(async (req, res) => {
  const { rowCount } = await db.query("UPDATE verifications SET status='approved',reviewed_at=now(),reviewed_by=$2,reject_reason=NULL WHERE user_id=$1 AND status='pending'", [req.params.uid, req.user.id]);
  if (!rowCount) return res.status(409).json({ error: 'الطلب مش قيد المراجعة' });
  await db.query('UPDATE users SET is_verified=TRUE WHERE id=$1', [req.params.uid]);
  notify([req.params.uid], 'تم توثيق حسابك ✅', 'تقدر دلوقتي تستخدم التطبيق بالكامل');
  audit(req, 'verify_approve', req.params.uid);
  res.json({ ok: true });
}));
app.post('/admin/verifications/:uid/reject', auth('admin'), wrap(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!reason) return res.status(400).json({ error: 'اكتب سبب الرفض' });
  const { rowCount } = await db.query("UPDATE verifications SET status='rejected',reviewed_at=now(),reviewed_by=$2,reject_reason=$3 WHERE user_id=$1 AND status='pending'", [req.params.uid, req.user.id, reason]);
  if (!rowCount) return res.status(409).json({ error: 'الطلب مش قيد المراجعة' });
  await db.query('UPDATE users SET is_verified=FALSE WHERE id=$1', [req.params.uid]);
  notify([req.params.uid], 'تعذّر توثيق حسابك', reason);
  audit(req, 'verify_reject', req.params.uid, reason);
  res.json({ ok: true });
}));

app.post('/me/push-token', auth(), wrap(async (req, res) => {
  await db.query('UPDATE users SET push_token=$1 WHERE id=$2', [String(req.body.token || ''), req.user.id]);
  res.json({ ok: true });
}));

require('./extra')({ app, db, auth, wrap, notify, audit, forget });   // مسارات الإدارة والتخزين الإضافية
require('./profile')({ app, db, auth, wrap, saveImg, UP });          // المرحلة 1: الملف الشخصي (نبذة + صورة)
require('./roles')({ app, db, auth, wrap, sign });                   // المرحلة 3: تعدد الأدوار (إضافة صفة / تبديل)

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log('وصّلني API شغال'));
