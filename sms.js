// إرسال الرسائل النصية. المزوّد الحالي: Twilio (REST مباشرة بدون مكتبات). لإضافة مزوّد محلي: أضف دالة هنا وفعّلها بـ SMS_PROVIDER.
// المتغيرات: SMS_PROVIDER=twilio ، TWILIO_ACCOUNT_SID ، TWILIO_AUTH_TOKEN ، وواحد من TWILIO_FROM أو TWILIO_MESSAGING_SERVICE_SID
const E = process.env;
const enabled = () => E.SMS_PROVIDER === 'twilio' && !!E.TWILIO_ACCOUNT_SID && !!E.TWILIO_AUTH_TOKEN && !!(E.TWILIO_FROM || E.TWILIO_MESSAGING_SERVICE_SID);

async function send(phone, text) {                       // phone بصيغة 01XXXXXXXXX
  const body = new URLSearchParams({ To: '+20' + String(phone).slice(1), Body: text });
  if (E.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', E.TWILIO_MESSAGING_SERVICE_SID); else body.set('From', E.TWILIO_FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(E.TWILIO_ACCOUNT_SID + ':' + E.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body, signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('SMS provider ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
module.exports = { enabled, send };
