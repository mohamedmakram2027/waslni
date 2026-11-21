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
