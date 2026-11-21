// اختبار منطق مسارات الملف الشخصي (profile.js) بدون قاعدة بيانات ولا تثبيت مكتبات:
// قاعدة بيانات وهمية + saveImg الحقيقية المستخرجة من server.js.  التشغيل: npm run test:profile
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'waslni-up-'));
const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
const helpers = src.slice(src.indexOf('// ===HELPERS_START'), src.indexOf('// ===HELPERS_END'));
const { saveImg, UP } = new Function('require', 'process', '__dirname', helpers + '\nreturn { saveImg, UP };')(require, process, __dirname);

const ME = '11111111-1111-1111-1111-111111111111', OTHER = '22222222-2222-2222-2222-222222222222';
const st = { bio: null, avatar: null, related: false, selfie: null };
const db = { async query(sql, p = []) {
  if (sql.includes('UNION ALL')) return { rowCount: st.related ? 1 : 0, rows: [] };
  if (sql.includes('SELECT avatar FROM users')) return { rows: [{ avatar: st.avatar }] };
  if (sql.includes('UPDATE users SET avatar=NULL')) { st.avatar = null; return { rowCount: 1 }; }
  if (sql.includes('UPDATE users SET avatar=$1')) { st.avatar = p[0]; return { rowCount: 1 }; }
  if (sql.includes('UPDATE users SET bio=$1')) { st.bio = p[0]; return { rowCount: 1 }; }
  if (sql.includes('FROM users u WHERE u.id=$1') && sql.includes('u.bio')) return { rows: [{ id: p[0], name: 'سارة', phone: '01012345678', role: 'courier', bio: st.bio, avatar: st.avatar, is_verified: true, rating_avg: 4.8, rating_count: 5, created_at: new Date(), completed: 3, vehicle_type: 'scooter' }] };
  if (sql.includes('SELECT u.avatar, (SELECT v.selfie')) return { rows: [{ avatar: st.avatar, selfie: st.selfie }] };
  throw new Error('استعلام غير متوقع: ' + sql.slice(0, 60));
} };

const routes = {};
const app = {}; ['get', 'post', 'patch', 'delete'].forEach(m => app[m] = (p, ...h) => routes[m.toUpperCase() + ' ' + p] = h);
const auth = () => (req, res, next) => next();
const wrap = fn => (req, res) => fn(req, res).catch(e => { if (e.status) return res.status(e.status).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); });
require('./profile')({ app, db, auth, wrap, saveImg, UP });

async function call(key, user, { params = {}, body = {} } = {}) {
  const res = { code: 200, body: null, file: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, type() { return this; }, sendFile(f) { this.file = f; return this; }, end() { return this; } };
  const h = routes[key]; const req = { user, params, body };
  await h[h.length - 1](req, res); return res;
}
const me = { id: ME, role: 'customer' }, other = { id: OTHER, role: 'courier' }, admin = { id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), role: 'admin' };
const jpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8]), require('crypto').randomBytes(6000)]).toString('base64');
const tick = () => new Promise(r => setTimeout(r, 60));
let n = 0; const ok = (name, fn) => fn().then(() => { n++; console.log('✔', name); }, e => { console.log('✖', name, '\n   ', e.message); process.exitCode = 1; });

(async () => {
  await ok('نبذة أطول من 300 حرف تُرفض', async () => assert.strictEqual((await call('PATCH /me/profile', me, { body: { bio: 'ا'.repeat(301) } })).code, 400));
  await ok('النبذة تُنظَّف من المحارف الخفية وتُحفظ', async () => { const r = await call('PATCH /me/profile', me, { body: { bio: '  مرحبا\u0000 بيك  ' } }); assert.strictEqual(r.body.bio, 'مرحبا بيك'); assert.strictEqual(st.bio, 'مرحبا بيك'); });
  await ok('نبذة فارغة تُخزَّن NULL', async () => { await call('PATCH /me/profile', me, { body: { bio: '   ' } }); assert.strictEqual(st.bio, null); });
  await ok('صورة غير صالحة تُرفض (400)', async () => { const r = await call('POST /me/avatar', me, { body: { image: 'data:image/png;base64,AAAA' } }); assert.strictEqual(r.code, 400); assert.strictEqual(st.avatar, null); });
  let f1;
  await ok('رفع صورة JPEG صالحة يحفظ الملف ويسجّله', async () => { const r = await call('POST /me/avatar', me, { body: { image: jpeg() } }); assert.strictEqual(r.code, 200); f1 = st.avatar; assert(fs.existsSync(path.join(UP, f1))); assert.strictEqual(r.body.avatar_v, f1.slice(0, 8)); });
  await ok('رفع صورة جديدة يحذف القديمة', async () => { await call('POST /me/avatar', me, { body: { image: jpeg() } }); await tick(); assert.notStrictEqual(st.avatar, f1); assert(!fs.existsSync(path.join(UP, f1))); assert(fs.existsSync(path.join(UP, st.avatar))); });
  await ok('عرض ملف شخص بلا علاقة تعامل = 403', async () => { st.related = false; assert.strictEqual((await call('GET /profile/:id', me, { params: { id: OTHER } })).code, 403); });
  await ok('عرض ملف طرف تعامل معه: بدون رقم الهاتف', async () => { st.related = true; const r = await call('GET /profile/:id', me, { params: { id: OTHER } }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.phone, undefined); assert.strictEqual(r.body.has_avatar, true); assert.strictEqual(r.body.is_self, false); });
  await ok('الملف الشخصي لصاحبه (me) يشمل الهاتف', async () => { st.related = false; const r = await call('GET /profile/:id', me, { params: { id: 'me' } }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.phone, '01012345678'); assert.strictEqual(r.body.is_self, true); });
  await ok('الإدارة تشوف أي ملف مع الهاتف', async () => { st.related = false; const r = await call('GET /profile/:id', admin, { params: { id: OTHER } }); assert.strictEqual(r.code, 200); assert(r.body.phone); });
  await ok('معرّف غير صالح = 404', async () => assert.strictEqual((await call('GET /profile/:id', me, { params: { id: 'abc' } })).code, 404));
  await ok('صورة العرض: ممنوعة بلا علاقة (404)', async () => { st.related = false; assert.strictEqual((await call('GET /photo/face/:uid', me, { params: { uid: OTHER } })).code, 404); });
  await ok('صورة العرض: تُخدَّم الصورة الشخصية داخل مجلد uploads', async () => { st.related = true; const r = await call('GET /photo/face/:uid', me, { params: { uid: OTHER } }); assert.strictEqual(r.file, path.join(UP, st.avatar)); });
  await ok('صورة العرض: بدون صورة شخصية تُستخدم سيلفي التوثيق المعتمد', async () => { st.avatar = null; st.selfie = 's.jpg'; const r = await call('GET /photo/face/:uid', me, { params: { uid: OTHER } }); assert.strictEqual(r.file, path.join(UP, 's.jpg')); });
  await ok('صورة العرض: لا صورة ولا سيلفي = 404', async () => { st.selfie = null; assert.strictEqual((await call('GET /photo/face/:uid', me, { params: { uid: OTHER } })).code, 404); });
  await ok('حذف الصورة يمسح الملف ويفرّغ الحقل', async () => { const r0 = await call('POST /me/avatar', me, { body: { image: jpeg() } }); const f = st.avatar; await call('DELETE /me/avatar', me); await tick(); assert.strictEqual(st.avatar, null); assert(!fs.existsSync(path.join(UP, f))); });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔'));
  fs.rmSync(UP, { recursive: true, force: true });
})();
