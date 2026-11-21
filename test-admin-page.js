// اختبار لوحة الإدارة المنفصلة (www/admin.html) بمحاكاة متصفح وخادم وهمي: دخول الإدارة فقط + تولّد كل الشاشات. التشغيل: npm run test:admin
const fs = require('fs'), assert = require('assert'), vm = require('vm');
const code = fs.readFileSync(__dirname + '/www/admin.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const store = {}; let html = '', toastMsg = '';
const nodes = {}; const el = id => nodes[id] || (nodes[id] = { style: {}, set textContent(v) { toastMsg = v }, get textContent() { return toastMsg }, set innerHTML(v) { if (id === '#root') html = v }, get innerHTML() { return html }, querySelector: () => el('x'), focus() {} });
let account = { role: 'admin', roles: ['admin'] };
const D = { kpis: { gmv: 100, commission: 10, completed: 3, active: 1, avg_order: 33, total: 5, cancelled: 1, avg_accept_min: 2, avg_delivery_min: 20, avg_bids: 2 }, users: { customers: 4, couriers: 2, verified_couriers: 1, new_users: 1, blocked: 0, avg_rating: 4.5 }, series: [{ day: '2026-11-20', created: 2, delivered: 1, commission: 5 }], status: [{ status: 'delivered', n: 3 }], top: [{ id: 'c1', name: 'مندوب <b>x</b>', rating_avg: 4.8, deliveries: 3, gmv: 99 }], recent: [{ title: 'طرد', customer_name: 'سارة', courier_name: null, status: 'bidding', created_at: new Date() }] };
const R = {
  '/health': () => ({ ok: true }),
  '/auth/login': () => ({ token: 'AT', user: { id: 'a1', name: 'مدير', phone: '0100', ...account } }), '/admin/badges': () => ({ ver: 2, complaints: 1 }), '/admin/dashboard': () => D,
  '/admin/orders': () => [{ id: 'o1', title: 'طلب', status: 'bidding', pickup_address: 'أ', dropoff_address: 'ب', customer_name: 'سارة', customer_phone: '0101', suggested_price: 30, created_at: new Date() }],
  '/admin/users': () => [{ id: 'u1', name: 'سارة', phone: '0101', role: 'customer', roles: ['courier', 'customer'], is_verified: true, orders_count: 2, rating_count: 0, created_at: new Date(), v_status: 'approved' }],
  '/admin/verifications': () => [{ user_id: 'u1', name: 'سارة', phone: '0101', role: 'courier', national_id: '29503121201234', birth_date: '1995-03-12', governorate_name: 'القاهرة', gender: 'female', vehicle_type: 'bike', plate: null, status: 'pending' }],
  '/admin/complaints': () => [{ id: 'c1', type: 'delay', message: 'متأخر', created_at: new Date(), order_title: 'طلب', user_name: 'سارة', user_role: 'customer' }], '/config': () => ({ commission_rate: 10 }), '/admin/audit': () => [{ action: 'block', admin_name: 'مدير', details: '', created_at: new Date() }], '/me': () => ({ role: 'admin', roles: ['admin'] }) };
const ctx = { AbortController, location: { protocol: 'https:', origin: 'x' }, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] }, URL: { createObjectURL: () => 'blob:x' },
  fetch: async (u, o = {}) => { const p = u.split('?')[0]; const f = R[p]; if (!f) return { ok: false, status: 404, json: async () => ({ error: 'no ' + p }) }; return { ok: true, status: 200, json: async () => f(), blob: async () => ({}) } },
  document: { querySelector: s => el(s), querySelectorAll: () => [], createElement: () => el('n' + Math.random()), body: { appendChild() {} }, addEventListener() {}, activeElement: null } };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(code + '\n;globalThis.T={doLogin,go,get U(){return U},get tok(){return tok},get tab(){return tab},LF,logout}', ctx);
const T = ctx.T, wait = () => new Promise(r => setImmediate(r)); let n = 0;
const ok = async (name, fn) => { try { await fn(); n++; console.log('✔', name); } catch (e) { console.log('✖', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n')); process.exitCode = 1; } };
(async () => {
  await wait();
  await ok('بدون جلسة: تظهر شاشة الدخول', async () => assert(html.includes('لوحة الإدارة') && html.includes('id="lw"')));
  await ok('حساب غير إدارة يُرفض ولا تُحفظ جلسة', async () => { account = { role: 'customer', roles: ['customer'] }; T.LF.ph = '01012345678'; T.LF.pw = 'secret1'; await T.doLogin(); assert.strictEqual(T.U, null); assert.strictEqual(store.atok, undefined); assert(toastMsg.includes('مش حساب إدارة')); });
  await ok('حساب عميل+مندوب (بدون admin) يُرفض أيضًا', async () => { account = { role: 'courier', roles: ['courier', 'customer'] }; await T.doLogin(); assert.strictEqual(T.U, null); });
  await ok('رقم غلط يُرفض قبل الإرسال', async () => { T.LF.ph = '123'; await T.doLogin(); assert(toastMsg.includes('01')); });
  await ok('حساب إدارة: دخول + جلسة بمفاتيح خاصة (atok) + عرض اللوحة', async () => { account = { role: 'admin', roles: ['admin'] }; T.LF.ph = '01012345678'; await T.doLogin(); await wait(); assert.strictEqual(T.tok, 'AT'); assert.strictEqual(store.atok, 'AT'); assert.strictEqual(store.tok, undefined); assert(html.includes('إجمالي المعاملات')); assert(html.includes('<i>2</i>')); });
  await ok('XSS: الأسماء بتتهرّب في اللوحة', async () => assert(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;')));
  for (const [t, needle] of [['orders', 'سارة'], ['users', 'مندوب'], ['ver', '29503121201234'], ['comp', 'متأخر'], ['set', 'نسبة العمولة']]) await ok('شاشة ' + t + ' تتولّد', async () => { T.go(t); await wait(); await wait(); assert(html.includes(needle), t); });
  await ok('شاشة الأعضاء تعرض كل صفات العضو (عميل + مندوب)', async () => { T.go('users'); await wait(); await wait(); assert(html.includes('مندوب') && html.includes('عميل')); });
  await ok('تسجيل الخروج يمسح الجلسة', async () => { T.logout(); assert.strictEqual(store.atok, undefined); assert(html.includes('id="lw"')); });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔')); process.exit(process.exitCode || 0);
})();
