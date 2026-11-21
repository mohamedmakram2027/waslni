-- قاعدة بيانات "وصّلني" (PostgreSQL 13+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('customer','courier','admin');
CREATE TYPE order_status AS ENUM ('bidding','accepted','picked_up','delivered','cancelled');
CREATE TYPE bid_status AS ENUM ('pending','accepted','rejected','withdrawn');
CREATE TYPE tx_type AS ENUM ('commission','payout','adjustment');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'customer',
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,      -- تحقق هوية المندوب
  rating_avg    NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count  INT NOT NULL DEFAULT 0,
  push_token    TEXT,                                -- للإشعارات
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings(key,value) VALUES ('commission_rate','10');

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES users(id),
  courier_id       UUID REFERENCES users(id),
  title            TEXT NOT NULL,
  pickup_address   TEXT NOT NULL,
  pickup_lat       DOUBLE PRECISION,
  pickup_lng       DOUBLE PRECISION,
  dropoff_address  TEXT NOT NULL,
  dropoff_lat      DOUBLE PRECISION,
  dropoff_lng      DOUBLE PRECISION,
  distance_km      NUMERIC(6,2),
  suggested_price  NUMERIC(10,2) NOT NULL CHECK (suggested_price > 0),
  status           order_status NOT NULL DEFAULT 'bidding',
  accepted_bid_id  UUID,
  final_price      NUMERIC(10,2),
  commission_rate  NUMERIC(5,2),
  commission_amount NUMERIC(10,2),
  courier_earning  NUMERIC(10,2),
  delivery_code    CHAR(4) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at      TIMESTAMPTZ,
  picked_up_at     TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX idx_orders_status   ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_courier  ON orders(courier_id);

CREATE TABLE bids (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier_id  UUID NOT NULL REFERENCES users(id),
  price       NUMERIC(10,2) NOT NULL CHECK (price > 0),
  eta_minutes INT NOT NULL DEFAULT 15,
  status      bid_status NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, courier_id)                       -- عرض واحد لكل مندوب
);
CREATE INDEX idx_bids_order ON bids(order_id);

CREATE TABLE tracking_points (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier_id UUID NOT NULL REFERENCES users(id),
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_track_order ON tracking_points(order_id, created_at DESC);

CREATE TABLE ratings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL UNIQUE REFERENCES orders(id),
  courier_id UUID NOT NULL REFERENCES users(id),
  stars      INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- سجل أرباح المنصة (عمولات) ومستحقات المناديب
CREATE TABLE wallet_transactions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),               -- NULL = حساب المنصة
  order_id   UUID REFERENCES orders(id),
  type       tx_type NOT NULL,
  amount     NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- توثيق الهوية (نفّذه لو كنت شغّلت schema.sql القديم)
CREATE TYPE verification_status AS ENUM ('pending','approved','rejected');
CREATE TABLE verifications (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  national_id_enc  TEXT NOT NULL,                 -- الرقم القومي مشفّر AES-256-GCM
  national_id_hash TEXT NOT NULL UNIQUE,          -- بصمة لمنع تكرار نفس الهوية على حسابين
  birth_date       DATE NOT NULL,
  gender           TEXT NOT NULL,
  governorate      CHAR(2) NOT NULL,
  id_front         TEXT NOT NULL,                 -- أسماء ملفات الصور (مجلد uploads الخاص)
  id_back          TEXT NOT NULL,
  selfie           TEXT NOT NULL,
  vehicle_type     TEXT,
  plate            TEXT,
  status           verification_status NOT NULL DEFAULT 'pending',
  reject_reason    TEXT,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      UUID REFERENCES users(id)
);
CREATE INDEX idx_verif_status ON verifications(status);

-- ميزات الإدارة والتخزين الإضافي: إيقاف الحسابات، إلغاء الطلبات، عناوين محفوظة، إشعارات، بلاغات، سجل عمليات
ALTER TABLE users  ADD COLUMN IF NOT EXISTS is_blocked     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS saved_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, address TEXT NOT NULL,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addr_user ON saved_addresses(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, order_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  against_user_id UUID REFERENCES users(id),
  type TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  admin_note TEXT, resolved_at TIMESTAMPTZ, resolved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, target TEXT, details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- المرحلة 1: الملف الشخصي (نفس migration_003_profile.sql)
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;   -- اسم ملف JPEG داخل مجلد uploads الخاص (غير متاح للعامة)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_bio_len') THEN
    ALTER TABLE users ADD CONSTRAINT users_bio_len CHECK (bio IS NULL OR char_length(bio) <= 300);
  END IF;
END $$;

-- المرحلة 2: OTP (نفس migration_004_otp.sql)
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

-- المرحلة 3: تعدد الأدوار (نفس migration_005_roles.sql)
-- users.role يفضل كما هو (الدور الأصلي)، والأدوار الفعلية للحساب في user_roles.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('customer','courier','admin')),   -- المرحلة 4 هتوسّع القيد لـ 'business'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role, user_id);
-- نسخ الدور الحالي لكل حساب قديم (آمن للتكرار)
INSERT INTO user_roles(user_id, role) SELECT id, role::text FROM users ON CONFLICT DO NOTHING;
-- آخر دور استخدمه الحساب (للدخول التالي). NULL = استخدم users.role
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_role TEXT;
