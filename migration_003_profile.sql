-- المرحلة 1: الملف الشخصي (نبذة + صورة شخصية). إضافات فقط: لا حذف ولا تعديل لأي بيانات موجودة.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;   -- اسم ملف JPEG داخل مجلد uploads الخاص (غير متاح للعامة)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_bio_len') THEN
    ALTER TABLE users ADD CONSTRAINT users_bio_len CHECK (bio IS NULL OR char_length(bio) <= 300);
  END IF;
END $$;
