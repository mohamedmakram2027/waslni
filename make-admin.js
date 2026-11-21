// الاستخدام: node make-admin.js 01XXXXXXXXX   (بعد ما تسجّل الحساب من التطبيق)
require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
db.query("UPDATE users SET role='admin' WHERE phone=$1", [process.argv[2]])
  .then(r => { console.log(r.rowCount ? 'تم تحويل الحساب لأدمن ✅' : 'الرقم غير مسجل'); return db.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
