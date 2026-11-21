// اختبار منطق مسارات تعدد الأدوار (roles.js) بدون قاعدة بيانات ولا تثبيت مكتبات: قاعدة بيانات وهمية تحاكي user_roles و verifications.
// التشغيل: npm run test:roles
const assert = require('assert');
const ME = '11111111-1111-1111-1111-111111111111';
const st = { roles: new Set(['customer']), last: null, ver: null };       // ver: null | {status, vehicle_type, plate}
const db = { async query(sql, p = []) {
  if (sql.includes('SELECT role FROM user_roles')) return { rows: [...st.roles].sort().map(role => ({ role })) };
  if (sql.includes('INSERT INTO user_roles')) { if (st.roles.has(p[1])) return { rowCount: 0 }; st.roles.add(p[1]); return { rowCount: 1 }; }
  if (sql.includes('SELECT status,vehicle_type FROM verifications')) return { rows: st.ver ? [{ status: st.ver.status, vehicle_type: st.ver.vehicle_type }] : [] };
  if (sql.includes('UPDATE users SET last_role')) { st.last = p[0]; return { rows: [{ id: ME, name: 'سارة', phone: '01012345678' }] }; }
  if (sql.includes('UPDATE verifications SET vehicle_type=$1')) { if (st.ver && !st.ver.vehicle_type) { st.ver.vehicle_type = p[0]; st.ver.plate = p[1]; return { rowCount: 1 }; } return { rowCount: 0 }; }
  if (sql.includes('SELECT vehicle_type FROM verifications')) return { rows: st.ver ? [{ vehicle_type: st.ver.vehicle_type }] : [] };
  throw new Error('استعلام غير متوقع: ' + sql.slice(0, 60));
} };
const routes = {}, app = {}; ['get', 'post'].forEach(m => app[m] = (p, ...h) => routes[m.toUpperCase() + ' ' + p] = h);
const authCalls = {}; const auth = (...r) => { const f = (req, res, next) => next(); f.roles = r; return f; };
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); });
const sign = (u, roles) => JSON.stringify({ id: u.id, role: u.role, roles });
require('./roles')({ app, db, auth, wrap, sign });
async function call(key, user, body = {}) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const h = routes[key]; await h[h.length - 1]({ user, body }, res); return res;
}
const cust = { id: ME, role: 'customer' }, cour = { id: ME, role: 'courier' };
let n = 0; const ok = (name, fn) => fn().then(() => { n++; console.log('✔', name); }, e => { console.log('✖', name, '\n   ', e.message); process.exitCode = 1; });

(async () => {
  await ok('المسارات الأربعة متسجّلة، والإدارة مستبعدة من إضافة/تبديل الأدوار', async () => {
    ['GET /me/roles', 'POST /me/roles', 'POST /me/switch-role', 'POST /verification/vehicle'].forEach(k => assert(routes[k], k));
    assert(!routes['POST /me/roles'][0].roles.includes('admin')); assert(!routes['POST /me/switch-role'][0].roles.includes('admin'));
  });
  await ok('GET /me/roles يرجّع الدور النشط وكل الأدوار', async () => { const r = await call('GET /me/roles', cust); assert.deepStrictEqual(r.body, { active: 'customer', roles: ['customer'] }); });
  await ok('صفة غير صالحة أو admin تُرفض (400) ولا تُضاف', async () => {
    for (const role of ['admin', 'business', '', undefined]) assert.strictEqual((await call('POST /me/roles', cust, { role })).code, 400);
    assert.deepStrictEqual([...st.roles], ['customer']);
  });
  await ok('عميل يضيف صفة مندوب: تتضاف وnext=verify (لسه ما وثّقش)', async () => { const r = await call('POST /me/roles', cust, { role: 'courier' }); assert.strictEqual(r.code, 200); assert.deepStrictEqual(r.body.roles, ['courier', 'customer']); assert.strictEqual(r.body.next, 'verify'); });
  await ok('إضافة نفس الصفة مرتين = 409', async () => assert.strictEqual((await call('POST /me/roles', cust, { role: 'courier' })).code, 409));
  await ok('التبديل لصفة مش على الحساب = 403 (ومفيش توكن)', async () => { st.roles = new Set(['customer']); const r = await call('POST /me/switch-role', cust, { role: 'courier' }); assert.strictEqual(r.code, 403); assert.strictEqual(r.body.token, undefined); st.roles.add('courier'); });
  await ok('تبديل لصفة مسموحة: توكن جديد بالدور النشط والأدوار + حفظ آخر دور', async () => {
    const r = await call('POST /me/switch-role', cust, { role: 'courier' }); assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(JSON.parse(r.body.token), { id: ME, role: 'courier', roles: ['courier', 'customer'] });
    assert.strictEqual(r.body.user.role, 'courier'); assert.strictEqual(st.last, 'courier');
  });
  await ok('تبديل لصفة غير معروفة/admin = 400', async () => { for (const role of ['admin', 'x']) assert.strictEqual((await call('POST /me/switch-role', cust, { role })).code, 400); });
  await ok('next: موثّق كعميل بلا مركبة → vehicle', async () => { st.ver = { status: 'approved', vehicle_type: null }; assert.strictEqual((await call('POST /me/switch-role', cust, { role: 'courier' })).body.next, 'vehicle'); });
  await ok('next: قيد المراجعة ومعاه مركبة → wait / موثّق ومعاه مركبة → null / مرفوض → verify', async () => {
    st.ver = { status: 'pending', vehicle_type: 'car' }; assert.strictEqual((await call('POST /me/switch-role', cust, { role: 'courier' })).body.next, 'wait');
    st.ver = { status: 'approved', vehicle_type: 'car' }; assert.strictEqual((await call('POST /me/switch-role', cust, { role: 'courier' })).body.next, null);
    st.ver = { status: 'rejected', vehicle_type: 'car' }; assert.strictEqual((await call('POST /me/switch-role', cust, { role: 'courier' })).body.next, 'verify');
  });
  await ok('التبديل لدور العميل: next=null', async () => assert.strictEqual((await call('POST /me/switch-role', cour, { role: 'customer' })).body.next, null));
  await ok('نوع المركبة: قيمة غلط = 400', async () => assert.strictEqual((await call('POST /verification/vehicle', cour, { vehicle_type: 'rocket' })).code, 400));
  await ok('نوع المركبة: بدون توثيق = 409 NOT_VERIFIED', async () => { st.ver = null; const r = await call('POST /verification/vehicle', cour, { vehicle_type: 'bike' }); assert.strictEqual(r.code, 409); assert.strictEqual(r.body.code, 'NOT_VERIFIED'); });
  await ok('نوع المركبة: يتسجّل لو فاضي، وتاني مرة 409 (مش بيتغيّر من هنا)', async () => {
    st.ver = { status: 'approved', vehicle_type: null }; const r = await call('POST /verification/vehicle', cour, { vehicle_type: 'bike', plate: ' ABC 123 ' });
    assert.strictEqual(r.code, 200); assert.strictEqual(st.ver.vehicle_type, 'bike'); assert.strictEqual(st.ver.plate, 'ABC 123');
    assert.strictEqual((await call('POST /verification/vehicle', cour, { vehicle_type: 'car' })).code, 409); assert.strictEqual(st.ver.vehicle_type, 'bike');
  });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔'));
})();
