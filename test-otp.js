// اختبار منطق OTP (otp.js) بدون قاعدة بيانات أو مكتبات: جدول وهمي في الذاكرة + مزوّد SMS وهمي + ساعة يتحكم فيها الاختبار.
// التشغيل: npm run test:otp   (التوقيع JWT هنا بديل اختباري بسيط؛ الخادم الحقيقي يستخدم jsonwebtoken)
const assert = require('assert'), crypto = require('crypto'), Module = require('module');
const b64 = b => Buffer.from(b).toString('base64url');
const jwtShim = {
  sign: (pl, sec, o) => { const ex = Math.floor(Date.now() / 1000) + (o && o.expiresIn === '15m' ? 900 : 60), h = b64('{"alg":"HS256"}') + '.' + b64(JSON.stringify({ ...pl, exp: ex })); return h + '.' + crypto.createHmac('sha256', sec).update(h).digest('base64url'); },
  verify: (t, sec) => { const [h, p, s] = t.split('.'); if (!s || crypto.createHmac('sha256', sec).update(h + '.' + p).digest('base64url') !== s) throw new Error('bad'); const pl = JSON.parse(Buffer.from(p, 'base64url')); if (pl.exp < Date.now() / 1000) throw new Error('exp'); return pl; }
};
const load = Module._load; Module._load = (r, ...a) => r === 'jsonwebtoken' ? jwtShim : load(r, ...a);
process.env.JWT_SECRET = 'test-secret'; process.env.ENC_KEY = 'enc-key';

const sms = require('./sms');
let enabled = true, sent = [], failNext = false;
sms.enabled = () => enabled;
sms.send = async (phone, text) => { if (failNext) { failNext = false; throw new Error('provider down'); } sent.push({ phone, text }); };

let now = 1e12, rows = [], seq = 0, users = new Set();
const db = { async query(sql, p = []) {
  if (sql.startsWith('SELECT 1 FROM users')) return { rowCount: users.has(p[0]) ? 1 : 0 };
  if (sql.includes('EXTRACT(EPOCH')) { const l = rows.filter(r => r.phone === p[0]).sort((a, b) => b.at - a.at)[0]; return { rows: l ? [{ age: (now - l.at) / 1000 }] : [] }; }
  if (sql.includes('COUNT(*)')) return { rows: [{ n: rows.filter(r => r.phone === p[0] && now - r.at < 3600000).length }] };
  if (sql.startsWith('DELETE FROM phone_otps WHERE created_at')) return { rowCount: 0 };
  if (sql.startsWith('INSERT INTO phone_otps')) { const r = { id: 'id' + ++seq, phone: p[0], hash: p[1], exp: now + p[2] * 60000, at: now, attempts: 0, ver: null, con: null }; rows.push(r); return { rows: [{ id: r.id }] }; }
  if (sql.startsWith('DELETE FROM phone_otps WHERE id')) { rows = rows.filter(r => r.id !== p[0]); return { rowCount: 1 }; }
  if (sql.includes('(expires_at < now())')) { const r = rows.filter(r => r.phone === p[0] && !r.ver && !r.con).sort((a, b) => b.at - a.at)[0]; return { rows: r ? [{ id: r.id, code_hash: r.hash, attempts: r.attempts, expired: r.exp < now }] : [] }; }
  if (sql.includes('attempts=attempts+1')) { const r = rows.find(r => r.id === p[0]); r.attempts++; return { rows: [{ attempts: r.attempts }] }; }
  if (sql.includes('SET verified_at=now()')) { const r = rows.find(r => r.id === p[0] && !r.ver); if (r) r.ver = now; return { rowCount: r ? 1 : 0 }; }
  if (sql.includes('SET consumed_at=now()')) { const r = rows.find(r => r.id === p[0] && r.phone === p[1] && r.ver && !r.con); if (r) r.con = now; return { rowCount: r ? 1 : 0 }; }
  if (sql.includes('SET consumed_at=NULL')) { const r = rows.find(r => r.id === p[0]); if (r) r.con = null; return { rowCount: 1 }; }
  throw new Error('استعلام غير متوقع: ' + sql.slice(0, 70));
} };
Date.now = () => now;

const routes = {}, app = { post: (path, h) => routes[path] = h };
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'خطأ' }); });
const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); return /^01[0125]\d{8}$/.test(d) ? d : null; };
const otp = require('./otp')({ app, db, wrap, normPhone });
const call = async (path, body, ip = '1.1.1.1') => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await routes[path]({ body, ip }, res); return res; };
const lastCode = () => /(\d{6})/.exec(sent[sent.length - 1].text)[1];
const wrong = c => String((+c + 1) % 1000000).padStart(6, '0');
const PH = '01123456709', PH2 = '01234567801';
let n = 0; const ok = async (name, fn) => { try { await fn(); n++; console.log('✔', name); } catch (e) { console.log('✖', name, '\n   ', e.message); process.exitCode = 1; } };

(async () => {
  await ok('بدون مزوّد SMS مفعّل: 503 ولا يُنشأ كود', async () => { enabled = false; const r = await call('/auth/otp/send', { phone: PH }); assert.strictEqual(r.code, 503); assert.strictEqual(rows.length, 0); enabled = true; });
  await ok('رقم غير صحيح = 400', async () => assert.strictEqual((await call('/auth/otp/send', { phone: '123' })).code, 400));
  await ok('أرقام وهمية واضحة تُرفض', async () => { for (const p of ['01000000000', '01012345678', '01098765432']) assert.strictEqual((await call('/auth/otp/send', { phone: p })).code, 400, p); });
  await ok('رقم مسجل مسبقًا = 409 بدون إرسال', async () => { users.add(PH2); assert.strictEqual((await call('/auth/otp/send', { phone: PH2 })).code, 409); assert.strictEqual(sent.length, 0); });
  await ok('الإرسال ينجح، والكود لا يُخزَّن (بصمة فقط)', async () => { const r = await call('/auth/otp/send', { phone: PH }); assert.strictEqual(r.code, 200); assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].phone, PH); assert(!JSON.stringify(rows).includes(lastCode())); assert.strictEqual(rows[0].hash.length, 64); });
  await ok('إعادة الإرسال قبل 60 ثانية = 429 مع retry_after', async () => { now += 20000; const r = await call('/auth/otp/send', { phone: PH }); assert.strictEqual(r.code, 429); assert.strictEqual(r.body.retry_after, 40); });
  await ok('كود غلط يقلّل المحاولات المتبقية', async () => { const r = await call('/auth/otp/verify', { phone: PH, code: wrong(lastCode()) }); assert.strictEqual(r.code, 400); assert(r.body.error.includes('4')); });
  await ok('الكود الصحيح (بأرقام عربية) يرجّع otp_token', async () => { const ar = lastCode().replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]); const r = await call('/auth/otp/verify', { phone: PH, code: ar }); assert.strictEqual(r.code, 200); assert(r.body.otp_token); global.TOK = r.body.otp_token; });
  await ok('take: يُستهلك مرة واحدة فقط', async () => { const id = await otp.take(global.TOK, PH); assert(id); assert.strictEqual(await otp.take(global.TOK, PH), null); global.OID = id; });
  await ok('release يتيح إعادة المحاولة لو فشل إنشاء الحساب', async () => { await otp.release(global.OID); assert(await otp.take(global.TOK, PH)); });
  await ok('التوكن لا يصلح لرقم آخر ولا لتوكن مزوّر', async () => { await otp.release(global.OID); assert.strictEqual(await otp.take(global.TOK, '01011112223'), null); assert.strictEqual(await otp.take(global.TOK + 'x', PH), null); assert.strictEqual(await otp.take('', PH), null); });
  await ok('بعد 5 محاولات غلط يُقفل الكود حتى لو الكود صحيح', async () => { now += 61000; await call('/auth/otp/send', { phone: PH2 + '' === PH2 ? '01155566677' : PH }); const P = '01155566677', c = lastCode(); let r; for (let i = 0; i < 5; i++) r = await call('/auth/otp/verify', { phone: P, code: wrong(c) }); assert.strictEqual(r.code, 400); r = await call('/auth/otp/verify', { phone: P, code: c }); assert.strictEqual(r.code, 429); assert.strictEqual(r.body.code, 'OTP_LOCKED'); });
  await ok('الكود المنتهي (بعد 5 دقائق) يُرفض', async () => { now += 61000; const P = '01066677788'; await call('/auth/otp/send', { phone: P }); const c = lastCode(); now += 5 * 60000 + 1000; const r = await call('/auth/otp/verify', { phone: P, code: c }); assert.strictEqual(r.body.code, 'OTP_EXPIRED'); });
  await ok('فشل مزوّد SMS = 502 ويُحذف الكود (بدون استهلاك مهلة الانتظار)', async () => { now += 61000; const P = '01277788899'; failNext = true; const r = await call('/auth/otp/send', { phone: P }); assert.strictEqual(r.code, 502); assert(!rows.some(x => x.phone === P)); assert.strictEqual((await call('/auth/otp/send', { phone: P })).code, 200); });
  await ok('حد 5 رسائل/ساعة لكل رقم', async () => { const P = '01588899900'; let last, c = 0; for (let i = 0; i < 6; i++) { now += 61000; last = await call('/auth/otp/send', { phone: P }, '9.9.9.' + i); if (last.code === 200) c++; } assert.strictEqual(c, 5); assert.strictEqual(last.code, 429); assert(last.body.error.includes('للحد الأقصى'), last.body.error); });
  await ok('حد 10 طلبات/ساعة لكل IP', async () => { now += 4000000; const res = []; for (let i = 0; i < 11; i++) res.push((await call('/auth/otp/send', { phone: '0102' + String(3140000 + i * 7919).padStart(7, '0') }, '8.8.8.8')).code); assert.deepStrictEqual(res.slice(0, 10), Array(10).fill(200)); assert.strictEqual(res[10], 429); });
  console.log(`\n${n} اختبار نجح` + (process.exitCode ? ' — وفي إخفاقات' : ' ✔'));
})();
