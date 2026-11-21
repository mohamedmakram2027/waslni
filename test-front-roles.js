// اختبار منطق تبديل الأدوار في الواجهة (www/index.html) بمحاكاة بسيطة للمتصفح وخادم وهمي. التشغيل: npm run test:front
const fs = require('fs'), assert = require('assert'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/www/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
const store = {}, calls = [];
const el = () => new Proxy(function () {}, { get: (t, k) => k === 'style' ? {} : k === 'querySelector' ? () => el() : k === 'classList' ? { add() {}, remove() {} } : (k === 'innerHTML' || k === 'textContent' || k === 'value') ? '' : el(), set: () => true, apply: () => el() });
let serverRoles = ['customer'], ver = null;
const fetchMock = async (url, o = {}) => {
  const path = url.replace(/^.*?(\/[a-z].*)$/, '$1'), body = o.body ? JSON.parse(o.body) : {}; calls.push(o.method + ' ' + path);
  const J = (j, ok = true, status = 200) => ({ ok, status, json: async () => j });
  if (path === '/health') return J({ ok: true });
  if (path === '/config') return J({ commission_rate: 10 });
  if (path === '/me') return J({ id: 'u1', name: 'سارة', phone: '0101', role: 'customer', roles: serverRoles, v_status: ver && ver.status, vehicle_type: ver && ver.vehicle_type, unread: 0 });
  if (path === '/orders/mine') return J([]);
  if (path === '/orders/open') return J([]);
  if (path === '/courier/earnings') return J({ today: 0, week: 0, month: 0, total: 0, count: 0, recent: [] });
  if (path === '/me/roles') { serverRoles = [...new Set([...serverRoles, body.role])].sort(); return J({ roles: serverRoles, next: 'verify' }); }
  if (path === '/me/switch-role') return J({ token: 'T-' + body.role, user: { id: 'u1', name: 'سارة', phone: '0101', role: body.role, roles: serverRoles }, next: body.role === 'courier' ? (ver ? (ver.vehicle_type ? null : 'vehicle') : 'verify') : null });
  return J({});
};
const ctx = { AbortController, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, fetch: fetchMock, navigator: {}, location: { protocol: 'https:', origin: 'x' },
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] },
  document: { querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(), body: { appendChild() {} }, addEventListener() {}, activeElement: null }, window: {}, L: undefined, Notification: undefined };
ctx.window = ctx; vm.createContext(ctx);
store.tok = 'OLD'; store.usr = JSON.stringify({ id: 'u1', name: 'سارة', phone: '0101', role: 'customer' });   // جلسة قديمة بدون roles (توافق عكسي)
vm.runInContext(code + '\n;globalThis.__t={get U(){return U},get tab(){return tab},get tok(){return tok},get V(){return V},view:()=>view(),roleBar:()=>roleBar(),roleCard:()=>roleCard(),switchRole,addRole,get ME(){return ME}}', ctx);
const t = ctx.__t, wait = () => new Promise(r => setImmediate(r));
let n = 0; const ok = async (name, fn) => { try { await fn(); n++; console.log('✔', name); } catch (e) { console.log('✖', name, '\n   ', e.message); process.exitCode = 1; } };
(async () => {
  await wait();
  await ok('جلسة قديمة بدون roles: الواجهة تشتغل وتحمّل الأدوار من /me', async () => { await vm.runInContext('refresh()', ctx); assert.deepStrictEqual([...t.U.roles], ['customer']); assert.strictEqual(t.roleBar(), ''); assert(t.roleCard().includes('أضف صفة مندوب')); assert(!t.roleCard().includes('أضف صفة عميل')); });
  await ok('الشاشة الرئيسية للعميل تتولّد بدون أخطاء', async () => assert(t.view().length > 100));
  await ok('تبديل لصفة مش مضافة: السيرفر يرفض ولا يتغيّر الدور', async () => { const f = ctx.fetch; ctx.fetch = async (u, o) => u.includes('switch-role') ? { ok: false, status: 403, json: async () => ({ error: 'الصفة دي مش مضافة على حسابك' }) } : f(u, o); await t.switchRole('courier'); ctx.fetch = f; assert.strictEqual(t.U.role, 'customer'); assert.strictEqual(t.tok, 'OLD'); });
  await ok('إضافة صفة مندوب (بعد ما التأكيد يتنفّذ): توكن جديد + الدور النشط مندوب + فتح التوثيق', async () => {
    let okFn; ctx.sheet = undefined; vm.runInContext('sheet=(t,b,ok)=>{globalThis.__ok=ok}', ctx); t.addRole('courier'); await ctx.__ok({});
    assert.strictEqual(t.tok, 'T-courier'); assert.strictEqual(t.U.role, 'courier'); assert.deepStrictEqual([...t.U.roles], ['courier', 'customer']);
    assert.strictEqual(t.tab, 'me'); assert.strictEqual(t.V.open, true); assert.strictEqual(JSON.parse(store.usr).role, 'courier'); assert.strictEqual(store.tok, 'T-courier');
  });
  await ok('بعد الإضافة: شريط التبديل بيظهر بالصفتين', async () => { const b = t.roleBar(); assert(b.includes('عميل') && b.includes('مندوب')); });
  await ok('التبديل رجوعًا لعميل: توكن جديد وتاب «طلباتي»', async () => { await t.switchRole('customer'); assert.strictEqual(t.U.role, 'customer'); assert.strictEqual(t.tab, 'mine'); assert.strictEqual(t.tok, 'T-customer'); });
  await ok('موثّق بلا مركبة: التبديل لمندوب يفتح تنبيه المركبة (مش نموذج التوثيق)', async () => { ver = { status: 'approved', vehicle_type: null }; await t.switchRole('courier'); assert.strictEqual(t.tab, 'me'); assert.strictEqual(t.V.open, false); let v; try { v = t.view(); } catch (e) { console.log(e.stack.split('\n').slice(0,4).join('\n')); throw e; } assert(v.includes('حدّد نوع مركبتك')); });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔')); process.exit(process.exitCode || 0);
})();
