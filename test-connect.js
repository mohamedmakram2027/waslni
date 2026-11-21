// اختبار الاتصال التلقائي بالخادم (index.html و admin.html): الملف مفتوح مباشرة من الجهاز (file://) وبدون أي رابط،
// والتأكد إن مفيش أي رسالة عن الخادم بتظهر للمستخدم، وإن الاتصال بيرجع لوحده. التشغيل: npm run test:connect
const fs = require('fs'), assert = require('assert'), vm = require('vm');
const SRVWORDS = /الخادم|السيرفر|server|localhost|رابط الموقع|اتأكد إنه شغال/i;
function boot(file, { protocol = 'file:', up = [], apiUrl = '' } = {}) {
  let code = fs.readFileSync(__dirname + '/www/' + file, 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
  code = code.replace(/const API_URL="[^"]*";/, `const API_URL="${apiUrl}";`);   // الاختبار يتحكّم في العنوان بنفسه
  const store = {}, log = { toasts: [], calls: [], html: '' }, state = { up: new Set(up), fail: 0, gw: 0 };
  const el = id => ({ style: {}, set textContent(v) { if (id === '#toast') log.toasts.push(v) }, set innerHTML(v) { log.html = v }, querySelector: () => el('x'), focus() {} });
  const J = (j, ok = true, status = 200) => ({ ok, status, json: async () => j, blob: async () => ({}) });
  const ctx = { AbortController, console, setInterval: () => 0, setTimeout, clearTimeout, URL: { createObjectURL: () => 'b' }, navigator: {}, Notification: undefined, L: undefined,
    location: { protocol, origin: protocol === 'file:' ? 'null' : 'https://app.test' },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] },
    document: { querySelector: s => el(s), querySelectorAll: () => [], createElement: () => el('n'), body: { appendChild() {} }, addEventListener() {}, activeElement: null },
    fetch: async (url, o = {}) => {
      const m = String(url).match(/^(https?:\/\/[^/]+)?(\/.*)$/), base = m[1] || (protocol === 'file:' ? null : ''), path = m[2].split('?')[0];
      if (base === null || (base !== '' && !state.up.has(base)) || (base === '' && !state.up.has(''))) throw new (vm.runInContext('TypeError', ctx))('Failed to fetch');
      log.calls.push((o.method || 'GET') + ' ' + base + path);
      if (path === '/health') return J({ ok: true });
      if (state.fail > 0 && path !== '/health') { state.fail--; throw new (vm.runInContext('TypeError', ctx))('dropped'); }
      if (state.gw > 0 && path !== '/health') { state.gw--; return { ok: false, status: 503, json: async () => ({}) }; }
      if (path === '/auth/login') return J({ token: 'T', user: { id: 'u1', name: 'سارة', phone: '0101', role: 'customer', roles: ['customer'] } });
      if (path === '/boom') return { ok: false, status: 500, json: async () => ({ error: 'خطأ في الخادم' }) };
      if (path === '/orders') return J({ id: 'o1' });
      return J({});
    } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(code + '\n;globalThis.T={api,connect,get API(){return API},get SRV(){return SRV}}', ctx);
  return { ctx, store, log, state, T: ctx.T };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = async (name, fn) => { try { await fn(); n++; console.log('✔', name); } catch (e) { console.log('✖', name, '\n   ', e.message); process.exitCode = 1; } };
(async () => {
  for (const file of ['index.html', 'admin.html']) {
    await ok(`[${file}] ملف مفتوح من الجهاز + خادم على نفس الجهاز: يتوصّل لوحده بدون أي رسالة`, async () => {
      const b = boot(file, { up: ['http://localhost:3000'] }); await wait(80);
      assert.strictEqual(b.T.API, 'http://localhost:3000'); assert.strictEqual(b.T.SRV, true); assert.strictEqual(b.store.srv, 'http://localhost:3000');
      assert.deepStrictEqual(b.log.toasts, []); assert(!SRVWORDS.test(b.log.html), 'ظهر نص عن الخادم');
    });
    await ok(`[${file}] الخادم واقع وقت التشغيل: لا رسائل، ولما يرجع الطلب يتنفّذ لوحده`, async () => {
      const b = boot(file); const p = b.T.api('/auth/login', 'POST', { phone: '1', password: '2' }); await wait(300);
      assert.deepStrictEqual(b.log.toasts, []); assert(!SRVWORDS.test(b.log.html));
      b.state.up.add('http://localhost:3000'); const j = await p;
      assert.strictEqual(j.token, 'T'); assert.strictEqual(b.log.calls.filter(c => c.includes('/auth/login')).length, 1); assert.deepStrictEqual(b.log.toasts, []);
    });
    await ok(`[${file}] انقطاع لحظي في طلب قراءة: بيتعاد لوحده بصمت`, async () => {
      const b = boot(file, { up: ['http://localhost:3000'] }); await wait(80); b.state.fail = 1;
      const j = await b.T.api('/me'); assert.deepStrictEqual(j, {}); assert.deepStrictEqual(b.log.toasts, []);
    });
    await ok(`[${file}] خادم بيصحى (503): القراءة بتتعاد، وعمليات الكتابة ما بتتكررش عند الانقطاع`, async () => {
      const b = boot(file, { up: ['http://localhost:3000'] }); await wait(80); b.state.gw = 1; await b.T.api('/me');
      b.state.fail = 1; let err; try { await b.T.api('/orders', 'POST', { title: 'x' }) } catch (e) { err = e }
      assert(err && err.net, 'لازم يرجع خطأ مؤقت'); assert(!SRVWORDS.test(err.message), err.message);
      assert.strictEqual(b.log.calls.filter(c => c.startsWith('POST') && c.includes('/orders')).length, 1);   // اتبعت مرة واحدة بس ومااتكرّرتش (منع تكرار طلب/دفع)
    });
  }
  await ok('خطأ 500 من الخادم يظهر للمستخدم بصياغة محايدة (بدون كلمة الخادم)', async () => { const b = boot('index.html', { up: ['http://localhost:3000'] }); await wait(80); let err; try { await b.T.api('/boom') } catch (e) { err = e } assert(err && !SRVWORDS.test(err.message), err && err.message); });
  await ok('عنوان الخادم المستضاف (API_URL) له الأولوية حتى لو الجهاز عليه localhost', async () => { const b = boot('index.html', { up: ['https://api.example.com', 'http://localhost:3000'], apiUrl: 'https://api.example.com' }); await wait(80); assert.strictEqual(b.T.API, 'https://api.example.com'); });
  await ok('الصفحة مفتوحة من نفس دومين الخادم: بيستخدم نفس الدومين (API فاضي)', async () => { const b = boot('index.html', { protocol: 'https:', up: [''] }); await wait(80); assert.strictEqual(b.T.API, ''); assert.strictEqual(b.T.SRV, true); });
  await ok('لا يوجد في الملفين أي نص جاهز يتكلم عن الخادم للمستخدم', async () => {
    for (const f of ['index.html', 'admin.html']) { const s = fs.readFileSync(__dirname + '/www/' + f, 'utf8'); const bad = s.split('\n').filter(l => /للخادم|رابط الموقع|اتأكد إنه شغال/.test(l)); assert.deepStrictEqual(bad, [], f); }
  });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔')); process.exit(process.exitCode || 0);
})();
