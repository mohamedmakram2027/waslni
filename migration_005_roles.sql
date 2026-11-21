-- المرحلة 3: تعدد الأدوار (حساب واحد = عميل و/أو مندوب). إضافات فقط: لا حذف ولا تعديل لأي بيانات موجودة.
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
