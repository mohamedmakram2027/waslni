// فحص الربط: بيتأكد إن كل طلب API في الواجهة ليه مسار مطابق في الخادم (نفس الطريقة والمسار)، وبيكشف أي تعارض في ترتيب المسارات.
// التشغيل: npm run check
const fs = require('fs');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8') + '\n' + fs.readFileSync(__dirname + '/extra.js', 'utf8') + '\n' + fs.readFileSync(__dirname + '/profile.js', 'utf8') + '\n' + fs.readFileSync(__dirname + '/otp.js', 'utf8') + '\n' + fs.readFileSync(__dirname + '/roles.js', 'utf8');
const front = fs.readFileSync(__dirname + '/www/index.html', 'utf8') + '\n' + fs.readFileSync(__dirname + '/www/admin.html', 'utf8');   // التطبيق + لوحة الإدارة المنفصلة

const routes = [...server.matchAll(/app\.(get|post|patch|delete|put)\(\s*'([^']+)'/g)].map(m => ({ method: m[1].toUpperCase(), path: m[2], seg: m[2].split('/') }));
const calls = new Map();
const add = (method, raw, where) => {
  const path = raw.replace(/\$\{[^}]*\}/g, ':p').split('?')[0];
  calls.set(method + ' ' + path, where);
};
for (const m of front.matchAll(/\bapi\(\s*([`"'])((?:\\.|(?!\1)[^\\])*?)\1\s*(?:,\s*(["'])(GET|POST|PATCH|DELETE|PUT)\3)?/g)) add(m[4] || 'GET', m[2], 'api()');
for (const m of front.matchAll(/\bfetch\(\s*API\s*\+\s*([`"'])((?:\\.|(?!\1)[^\\])*?)\1/g)) add('GET', m[2], 'fetch()');
for (const m of front.matchAll(/\bim\(\s*([`"'])((?:\\.|(?!\1)[^\\])*?)\1/g)) add('GET', m[2].replace(/^\/admin\/verifications\/:p\/(front|back|selfie)$/, '/admin/verifications/:p/$1'), 'image');
// صور التوثيق: u+"front" → /admin/verifications/:uid/front
for (const k of ['front', 'back', 'selfie']) if (front.includes(`im(u+"${k}"`)) add('GET', `/admin/verifications/:p/${k}`, 'image');

const matches = (r, p) => { const s = p.split('/'); return r.seg.length === s.length && r.seg.every((x, i) => x.startsWith(':') || x === s[i]); };
let bad = 0;
for (const [k, where] of calls) {
  const [method, path] = k.split(' ');
  if (!routes.some(r => r.method === method && matches(r, path))) { console.log('❌ الواجهة بتطلب مسار مش موجود في الخادم:', k, `(${where})`); bad++; }
}
// ترتيب المسارات: مسار ثابت لازم يتسجّل قبل مسار فيه متغيّر بنفس الشكل
routes.forEach((r, i) => routes.slice(0, i).forEach(prev => {
  if (prev.method === r.method && prev.seg.length === r.seg.length && prev.seg.some(x => x.startsWith(':')) && !r.seg.some(x => x.startsWith(':')) && matches(prev, r.path)) { console.log('⚠️ ترتيب مسارات: ' + r.method + ' ' + r.path + ' متسجّل بعد ' + prev.path + ' فهيتبلع'); bad++; }
}));
const used = new Set([...calls.keys()].map(k => k.split(' ')[0] + ' ' + k.split(' ')[1]));
const unused = routes.filter(r => ![...calls.keys()].some(k => { const [m, p] = k.split(' '); return m === r.method && matches(r, p); }));
console.log(`المسارات في الخادم: ${routes.length} | طلبات الواجهة: ${calls.size}`);
if (unused.length) console.log('ℹ️ مسارات جاهزة وغير مستخدمة في الواجهة (للتكامل المستقبلي): ' + unused.map(r => r.method + ' ' + r.path).join(' ، '));
console.log(bad ? `\n✖ في ${bad} مشكلة ربط` : '\n✔ الربط سليم: كل طلب في الواجهة ليه مسار مطابق في الخادم');
process.exit(bad ? 1 : 0);
