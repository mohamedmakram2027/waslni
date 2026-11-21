# مرجع الـ API – وصّلني

كل المسارات تحتاج الهيدر `Authorization: Bearer <token>` ما عدا اللي مكتوب قدامها «—». الأخطاء بترجع JSON: `{ "error": "رسالة بالعربي" }`.
الحسابات الموقوفة بترجع 401. التحقق من الأدوار بيتم في الخادم (مش بس إخفاء الأزرار).

## الحساب والدخول
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/auth/register` | — | تسجيل جديد. body: name, phone, password, role (customer|courier|admin), admin_code (للإدارة فقط) |
| POST | `/auth/login` | — | دخول. body: phone, password |
| GET | `/config` | — | نسبة العمولة الحالية |
| GET | `/me` | أي دور | بياناتي + حالة التوثيق + عدد الإشعارات غير المقروءة |
| PATCH | `/me` | أي دور | تعديل الاسم. body: name |
| POST | `/me/password` | أي دور | تغيير كلمة المرور. body: old_password, new_password |
| POST | `/me/push-token` | أي دور | تسجيل توكن الإشعارات. body: token |

## التوثيق
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/verification` | عميل/مندوب | إرسال طلب توثيق: national_id, id_front, id_back, selfie (JPEG base64), vehicle_type, plate |
| GET | `/photo/selfie/:uid` | حسب الصلاحية | صورة شخصية (صاحبها / الإدارة / عميل قدّم له المندوب عرضًا) |

## العميل
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/orders` | عميل | نشر طلب |
| GET | `/orders/mine` | عميل/مندوب | طلباتي |
| GET | `/orders/:id` | طرف في الطلب/إدارة | تفاصيل طلب |
| GET | `/orders/:id/bids` | عميل | عروض الطلب |
| POST | `/orders/:id/accept/:bidId` | عميل | قبول عرض وحساب العمولة |
| POST | `/orders/:id/cancel` | عميل | إلغاء (قبل الاستلام). body: reason |
| POST | `/orders/:id/rate` | عميل | تقييم المندوب. body: stars, comment |
| GET | `/orders/:id/track` | طرف في الطلب | آخر موقع للمندوب |
| GET | `/addresses` | أي دور | عناويني المحفوظة |
| POST | `/addresses` | أي دور | حفظ عنوان (حد أقصى 10). body: label, address, lat, lng |
| DELETE | `/addresses/:id` | أي دور | حذف عنوان |

## المندوب
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/orders/open` | مندوب | الطلبات المفتوحة |
| POST | `/orders/:id/bids` | مندوب موثّق | تقديم/تعديل عرض. body: price, eta_minutes |
| POST | `/orders/:id/picked-up` | مندوب | تم الاستلام |
| POST | `/orders/:id/location` | مندوب | إرسال الموقع. body: lat, lng |
| POST | `/orders/:id/deliver` | مندوب | تسليم بالكود. body: code |
| GET | `/courier/earnings` | مندوب | أرباح اليوم/الأسبوع/الشهر/الإجمالي + آخر المشاوير |

## الإشعارات والبلاغات
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/notifications` | أي دور | آخر 40 إشعار (مخزّنة في قاعدة البيانات) |
| POST | `/notifications/read` | أي دور | تعليم الكل كمقروء |
| POST | `/orders/:id/complaint` | عميل/مندوب | بلاغ عن مشكلة. body: type (delay|behavior|damaged|payment|other), message |
| GET | `/complaints/mine` | عميل/مندوب | بلاغاتي وردود الإدارة |

## الإدارة (دور admin فقط)
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/admin/badges` | إدارة | عدّادات: توثيقات منتظرة وبلاغات مفتوحة |
| GET | `/admin/dashboard?days=7|30|90|0` | إدارة | لوحة التحكم: مؤشرات، مستخدمين، توزيع حالات، سلسلة يومية، أفضل مناديب، آخر طلبات |
| GET | `/admin/stats` | إدارة | ملخص بسيط (قديم) |
| GET | `/admin/orders?status=&q=&limit=&offset=` | إدارة | بحث وفلترة الطلبات |
| POST | `/admin/orders/:id/cancel` | إدارة | إلغاء طلب. body: reason |
| GET | `/admin/users?f=all|customer|courier|admin|blocked&q=` | إدارة | المستخدمون |
| POST | `/admin/users/:id/block` | إدارة | إيقاف حساب. body: reason |
| POST | `/admin/users/:id/unblock` | إدارة | رفع الإيقاف |
| GET | `/admin/verifications?status=pending` | إدارة | طلبات التوثيق (مع الرقم القومي) |
| GET | `/admin/verifications/:uid/:kind` | إدارة | صورة (front|back|selfie) |
| POST | `/admin/verifications/:uid/approve` | إدارة | موافقة |
| POST | `/admin/verifications/:uid/reject` | إدارة | رفض. body: reason |
| GET | `/admin/complaints` | إدارة | البلاغات المفتوحة |
| POST | `/admin/complaints/:id/resolve` | إدارة | معالجة بلاغ. body: note |
| POST | `/admin/commission` | إدارة | تغيير نسبة العمولة. body: rate (0–30) |
| GET | `/admin/audit?limit=` | إدارة | سجل العمليات الإدارية |
| GET | `/admin/export/orders.csv?days=` | إدارة | تصدير الطلبات (CSV يفتح في Excel) |
| POST | `/admin/couriers/:id/verify` | إدارة | توثيق يدوي سريع لمندوب (احتياطي) |

## أخرى
| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/health` | — | فحص التشغيل |

## ملاحظات الربط
- الواجهة (`www/index.html`) بتتكلم مع الخادم عبر `API_URL`. فاضي = نفس الدومين.
- لفحص إن كل طلب في الواجهة ليه مسار في الخادم: `npm run check`.
- الإشعارات بتتخزن في جدول `notifications` وبتظهر في التطبيق دايمًا، وPush (Firebase) اختياري فوقها.
- كل عملية إدارية (توثيق، إيقاف، إلغاء، عمولة، معالجة بلاغ، تصدير) بتتسجل في `audit_log`.

## المرحلة 1 — الملف الشخصي (جديد)
| المسار | الدور | الوظيفة |
|---|---|---|
| GET /profile/me | الكل | ملفي الشخصي (الاسم، النبذة، الصورة، التقييم، رقم الهاتف) |
| GET /profile/:id | الكل | ملف مستخدم آخر. مسموح لصاحبه والإدارة ومن بينهم طلب أو عرض مشترك فقط (وإلا 403). لا يظهر رقم الهاتف لغير صاحبه والإدارة |
| PATCH /me/profile | الكل | تعديل النبذة `{bio}` (حتى 300 حرف) |
| POST /me/avatar | الكل | رفع الصورة الشخصية `{image: "data:image/jpeg;base64,..."}` (JPEG، حتى 3MB) |
| DELETE /me/avatar | الكل | حذف الصورة الشخصية |
| GET /photo/face/:uid | الكل | صورة العرض (الشخصية، أو سيلفي التوثيق المعتمد لو مفيش) بنفس صلاحيات الملف الشخصي |

الصور محفوظة في مجلد `uploads/` الخاص وبتتقدّم عبر API بتوكن فقط. تغيير الاسم لسه عن طريق `PATCH /me` الموجود.

## المرحلة 2 — التحقق من الهاتف OTP (جديد)
| المسار | الوظيفة |
|---|---|
| POST /auth/otp/send `{phone}` | إرسال كود 6 أرقام بـ SMS. فاصل 60 ثانية بين الرسائل، 5 رسائل/ساعة لكل رقم، 10/ساعة لكل IP. يرفض الأرقام غير الصحيحة والوهمية الواضحة والمسجّلة مسبقًا. يرد 503 لو مزوّد الرسائل غير مفعّل |
| POST /auth/otp/verify `{phone, code}` | التحقق من الكود (صلاحية 5 دقائق، 5 محاولات). عند النجاح يرجّع `otp_token` صالح 15 دقيقة |
| POST /auth/register | **تغيّر:** غير الإدارة لازم يرسلوا `otp_token`. التوكن يُستخدم مرة واحدة ولنفس الرقم فقط، وإلا 403 بـ `code: PHONE_NOT_VERIFIED`. تسجيل الإدارة بالكود السري لم يتغير |

الكود لا يُخزَّن (بصمة HMAC فقط). تسجيل الدخول لم يتغير. الحسابات القديمة `phone_verified_at` فيها NULL ولا تتأثر.
