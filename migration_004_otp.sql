-- المرحلة 2: التحقق من رقم الهاتف بـ OTP. إضافات فقط: لا حذف ولا تعديل لأي بيانات موجودة.
CREATE TABLE IF NOT EXISTS phone_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                      -- بصمة HMAC للكود (الكود نفسه لا يُخزَّن أبدًا)
  attempts    INT  NOT NULL DEFAULT 0,            -- محاولات الإدخال الخاطئة/الكلية لهذا الكود
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,                        -- وقت إثبات ملكية الرقم
  consumed_at TIMESTAMPTZ,                        -- وقت استخدام الإثبات في إنشاء حساب (مرة واحدة فقط)
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON phone_otps(phone, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;   -- NULL = حساب قديم لم يُتحقق من رقمه بعد
