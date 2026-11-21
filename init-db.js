// يجهّز قاعدة البيانات تلقائيًا عند كل تشغيل (آمن للتكرار): جداول جديدة أو ترقية قاعدة قديمة.
require('dotenv').config();
const fs = require('fs'), { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const sql = f => fs.readFileSync(__dirname + '/' + f, 'utf8');
(async () => {
  const has = async t => (await db.query('SELECT to_regclass($1) AS r', ['public.' + t])).rows[0].r !== null;
  const hasCol = async (t, c) => (await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2", [t, c])).rowCount > 0;
  if (!(await has('users'))) { await db.query(sql('schema.sql')); console.log('تم إنشاء كل الجداول'); }
  else {
    if (!(await has('verifications'))) { await db.query(sql('migration_001_verification.sql')); console.log('تمت إضافة جدول التوثيق'); }
    if (!(await has('notifications'))) { await db.query(sql('migration_002_admin_features.sql')); console.log('تمت إضافة جداول الإدارة والإشعارات والبلاغات'); }
    if (!(await has('phone_otps'))) { await db.query(sql('migration_004_otp.sql')); console.log('تمت إضافة جدول التحقق من الهاتف (OTP)'); }
    if (!(await has('user_roles'))) { await db.query(sql('migration_005_roles.sql')); console.log('تمت إضافة جدول الأدوار المتعددة'); }
    if (!(await hasCol('users', 'bio'))) { await db.query(sql('migration_003_profile.sql')); console.log('تمت إضافة حقول الملف الشخصي'); }
  }
  console.log('قاعدة البيانات جاهزة');
  await db.end();
})().catch(e => { console.error('فشل تجهيز قاعدة البيانات:', e.message); process.exit(1); });
