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
