// المرحلة 2: التحقق من ملكية رقم الهاتف بكود OTP عبر SMS (منفصل تمامًا عن توثيق الهوية).
// التدفق: /auth/otp/send → /auth/otp/verify (يرجّع otp_token) → /auth/register بالـ otp_token (يُستخدم مرة واحدة).
const crypto = require('crypto'), jwt = require('jsonwebtoken');
const sms = require('./sms');

const CFG = { TTL_MIN: 5, COOLDOWN_S: 60, MAX_ATTEMPTS: 5, MAX_PER_HOUR_PHONE: 5, MAX_PER_HOUR_IP: 10 };

module.exports = function ({ app, db, wrap, normPhone }) {
  const fail = (res, s, msg, extra) => res.status(s).json({ error: msg, ...extra });
  const secret = () => process.env.OTP_SECRET || process.env.ENC_KEY || process.env.JWT_SECRET || 'dev';
  const tokSecret = () => process.env.JWT_SECRET + ':phone-otp';           // مفتاح مختلف عن توكن الدخول: التوكنان غير قابلين للتبادل
  const hash = (phone, code) => crypto.createHmac('sha256', secret()).update(phone + ':' + code).digest('hex');
  const same = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
  const digits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');

  // أرقام وهمية واضحة: كل الأرقام متشابهة أو متتالية (01000000000 / 01012345678). الحماية الحقيقية هي إثبات الملكية بالرسالة.
  function looksFake(phone) {
    const t = phone.slice(3);
    if (/^(\d)\1+$/.test(t)) return true;
    const d = [...t].map(Number); let up = true, down = true;
    for (let i = 1; i < d.length; i++) { if ((d[i] - d[i - 1] + 10) % 10 !== 1) up = false; if ((d[i - 1] - d[i] + 10) % 10 !== 1) down = false; }
    return up || down;
  }

  const ipHits = new Map();                                              // حد لكل IP في الساعة (داخل الذاكرة)
  function ipLimited(ip) {
    const now = Date.now(), t = (ipHits.get(ip) || []).filter(x => now - x < 3600000);
    if (t.length >= CFG.MAX_PER_HOUR_IP) { ipHits.set(ip, t); return true; }
    t.push(now); ipHits.set(ip, t); return false;
  }

  app.post('/auth/otp/send', wrap(async (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!phone) return fail(res, 400, 'رقم الموبايل غير صحيح');
    if (looksFake(phone)) return fail(res, 400, 'رقم الموبايل غير صالح');
    if (!sms.enabled()) return fail(res, 503, 'خدمة الرسائل غير متاحة حاليًا، جرّب لاحقًا', { code: 'SMS_DISABLED' });
    if (ipLimited(req.ip)) return fail(res, 429, 'محاولات كتير، جرّب بعد ساعة');
    if ((await db.query('SELECT 1 FROM users WHERE phone=$1', [phone])).rowCount) return fail(res, 409, 'الرقم مسجل قبل كده');

    const { rows: [last] } = await db.query('SELECT EXTRACT(EPOCH FROM (now()-created_at))::float AS age FROM phone_otps WHERE phone=$1 ORDER BY created_at DESC LIMIT 1', [phone]);
    if (last && last.age < CFG.COOLDOWN_S) { const w = Math.ceil(CFG.COOLDOWN_S - last.age); return fail(res, 429, `استنى ${w} ثانية قبل إعادة الإرسال`, { retry_after: w }); }
    const { rows: [c] } = await db.query("SELECT COUNT(*)::int AS n FROM phone_otps WHERE phone=$1 AND created_at > now() - interval '1 hour'", [phone]);
    if (c.n >= CFG.MAX_PER_HOUR_PHONE) return fail(res, 429, 'وصلت للحد الأقصى من الرسائل، جرّب بعد ساعة');

    db.query("DELETE FROM phone_otps WHERE created_at < now() - interval '1 day'").catch(() => {});
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const { rows: [o] } = await db.query('INSERT INTO phone_otps(phone,code_hash,expires_at,ip) VALUES($1,$2,now() + make_interval(mins => $3),$4) RETURNING id', [phone, hash(phone, code), CFG.TTL_MIN, req.ip]);
    try { await sms.send(phone, `كود التحقق في وصّلني: ${code}\nصالح ${CFG.TTL_MIN} دقائق. لا تشاركه مع أي حد.`); }
    catch (e) { console.error('sms', e.message); await db.query('DELETE FROM phone_otps WHERE id=$1', [o.id]); return fail(res, 502, 'تعذّر إرسال الرسالة، جرّب تاني'); }
    res.json({ ok: true, resend_in: CFG.COOLDOWN_S, expires_in: CFG.TTL_MIN * 60 });
  }));

  app.post('/auth/otp/verify', wrap(async (req, res) => {
    const phone = normPhone(req.body.phone), code = digits(req.body.code);
    if (!phone || !/^\d{6}$/.test(code)) return fail(res, 400, 'الكود لازم يكون 6 أرقام');
    const { rows: [o] } = await db.query('SELECT id,code_hash,attempts,(expires_at < now()) AS expired FROM phone_otps WHERE phone=$1 AND verified_at IS NULL AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1', [phone]);
    if (!o) return fail(res, 400, 'اطلب كود جديد', { code: 'OTP_NONE' });
    if (o.expired) return fail(res, 400, 'الكود انتهت صلاحيته، اطلب كود جديد', { code: 'OTP_EXPIRED' });
    const { rows: [a] } = await db.query('UPDATE phone_otps SET attempts=attempts+1 WHERE id=$1 RETURNING attempts', [o.id]);
    if (a.attempts > CFG.MAX_ATTEMPTS) return fail(res, 429, 'محاولات كتير غلط، اطلب كود جديد', { code: 'OTP_LOCKED' });
    if (!same(hash(phone, code), o.code_hash)) {
      const left = CFG.MAX_ATTEMPTS - a.attempts;
      return fail(res, 400, left > 0 ? `الكود غلط (باقي ${left} محاولات)` : 'الكود غلط، اطلب كود جديد', { code: 'OTP_WRONG' });
    }
    await db.query('UPDATE phone_otps SET verified_at=now() WHERE id=$1 AND verified_at IS NULL', [o.id]);
    res.json({ ok: true, otp_token: jwt.sign({ otp: o.id, phone }, tokSecret(), { expiresIn: '15m' }) });
  }));

  return {
    // يستهلك إثبات الملكية مرة واحدة (ذريًا). يرجّع معرّفه أو null لو غير صالح/مستخدم/لرقم آخر
    async take(token, phone) {
      try {
        const p = jwt.verify(String(token || ''), tokSecret());
        if (p.phone !== phone) return null;
        const { rowCount } = await db.query('UPDATE phone_otps SET consumed_at=now() WHERE id=$1 AND phone=$2 AND verified_at IS NOT NULL AND consumed_at IS NULL', [p.otp, phone]);
        return rowCount ? p.otp : null;
      } catch { return null; }
    },
    release: id => db.query('UPDATE phone_otps SET consumed_at=NULL WHERE id=$1', [id]).catch(() => {}),
    markVerified: userId => db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1', [userId]).catch(e => console.error('otp mark', e.message))
  };
};
module.exports.CFG = CFG;
