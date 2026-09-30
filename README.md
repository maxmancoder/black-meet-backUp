# Black Meet — سایت تماس صوتی/تصویری گروهی

یک سیستم تماس گروهی (مشابه Google Meet) با یک پروسه **Node.js** واحد:
Express (سرو صفحات)، Socket.IO (سیگنالینگ + ریل‌تایم) و SQLite (`node:sqlite`).
شامل احراز هویت (شماره/ایمیل + OTP، یا ایمیل + رمز عبور با bcrypt)، مدیریت تماس‌ها،
چت، اشتراک‌گذاری صفحه، ایموجی زنده و کنترل دسترسی مبتنی بر نقش (ادمین/عضو).

---

## پیش‌نیازها
- **Node.js نسخه ۲۲+** (به‌خاطر `node:sqlite`؛ روی v24 تست شده).
- مرورگر مدرن (Chrome/Edge/Firefox) با پشتیبانی WebRTC + دسترسی به میکروفون/دوربین.
- **Apache و MySQL دیگر لازم نیستند** — فقط برای phpMyAdmin اختیاری است.

---

## نصب و راه‌اندازی

```
C:\xampp\htdocs\black-meet
```

1. `npm install`
2. `config.json` را متناسب با محیط تنظیم کنید:
   - `secret`: رشته تصادفی برای OTP و HMAC سوکت
   - `DEV_MODE: true` → کد OTP در پاسخ API و `dev_otp.log` می‌آید (برای تست؛ در پروداکشن `false`)
   - `db`: فقط هنگام ایمپورت از MySQL قدیمی استفاده می‌شود
3. همه‌چیز را با **`start-all.bat`** اجرا کنید (Node :3000 + TURN UDP/TCP :3478 + تونل وب + تونل TURN).
   - تونل وب با ترتیب فالبک اجرا می‌شود: **Cloudflare ← SSH (localhost.run) ← bore (bore.pub)**.
   - وقتی URL عمومی آماده شد، سایت به‌صورت خودکار در مرورگر پیش‌فرض کروم باز می‌شود
     (فایل `tunnel_url.txt` همیشه URL فعلی را دارد؛ `turn_host.txt` برای TURN).
   - بدون تونل هم سایت روی `http://localhost:3000/black-meet` در دسترس است.
- اجرای دستی تونل بدون `start-all.bat`: `tunnels.ps1` یا `tunnel.cmd`.

---

## حساب مدیر (پیش‌فرض)
- شماره تلفن: `09331660212`
- ایمیل: `av0098056@gmail.com`
- نام کاربری: `blackline`

رمز عبور به‌صورت هش‌شده (bcrypt) در دیتابیس ذخیره است. ورود legacy
(متون ساده قدیمی) هم پذیرفته و به‌صورت خودکار به bcrypt ارتقا می‌یابد.

---

## نحوه استفاده
1. **ثبت‌نام / ورود:** در صفحه اصلی بین ورود با شماره/ایمیل و ثبت‌نام جابه‌جا شوید.
   در حالت `DEV_MODE` کد تأیید هم در صفحه و هم در `dev_otp.log` نمایش داده می‌شود.
2. **ایجاد تماس:** از داشبورد روی «ایجاد جلسه جدید» کلیک کنید؛ یک لینک عمومی می‌گیرید.
3. **پیوستن با لینک:** لینک یا کد تماس را در باکس جستجوی داشبورد وارد کنید.
4. **اتاق تماس:**
   - دوربین / میکروفون / اشتراک صفحه را کنترل کنید (میکروفون و دوربین **جداگانه** درخواست می‌شوند؛
     نبودِ دوربین جلوی صدا را نمی‌گیرد).
   - چت در سمت چپ، لیست اعضا و تب ادمین در سمت راست.
   - کاربران جدید باید توسط **ادمین** (سازنده تماس) تایید شوند.
   - ادمین می‌تواند اعضا را **حذف**، **ساکت** یا **مسدود** کند (برای خودش یا همه).

---

## ساختار پروژه
```
black-meet/
├─ server/
│  ├─ index.js          نقطه ورود Express + Socket.IO (پورت ۳۰۰۰ / process.env.PORT)
│  ├─ app.js            مونت‌کردن روت‌ها («/black-meet/*» حفظ شده)
│  ├─ sockets.js        سیگنالینگ WebRTC + رویدادهای ریل‌تایم
│  ├─ routes/           pages.js (صفحات EJS) و api.js (REST)
│  ├─ lib/              config, db (SQLite), helpers, internal, sessions, otp, pwd, state, bus, schema.sql
│  └─ views/            قالب‌های EJS (فارسی RTL)
├─ shared/socket-events.js   تک‌منبع نام رویدادهای Socket.IO
├─ assets/              css (tailwind محلی)، js
├─ fonts/               Vazirmatn + Material Symbols (محلی، بدون CDN)
├─ icons/  uploads/     آیکون‌های SVG و آواتارهای آپلودی
├─ bin/  keep-*.ps1     تونل وب (cloudflared) و تونل TURN (bore)
├─ turn.js  turn-proxy.js   سرور TURN (UDP) و پراکسی TCP
├─ tools/               ابزار ایمپورت MySQL→SQLite (import_sqlite.js + mysql_dump)
├─ sql/                 اسکیمای مرجع MySQL قدیمی (فقط برای ایمپورت)
├─ start-all.bat        اجرای همه خدمات
├─ config.json          تنظیمات (در .gitignore؛ داخل گیت نیاید)
└─ black_meet.db        دیتابیس SQLite (into .gitignore)
```

---

## امنیت
- رمزهای عبور با `bcryptjs` هش می‌شوند.
- نشست‌ها مبتنی بر SQLite (`bm_sessions`) با کوکی httpOnly + SameSite=Lax و CSRF برای همه POSTها.
- ارتباط سوکت با توکن HMAC (`makeSocketToken`/`verifySocketToken`، TTL ۲۴ ساعت).
- XSS از طریق escape در EJS و `htmlspecialchars` معادل در کلاینت.
- فایل‌های حساس (`config.json`, `.env`, `tunnel_url.txt`, `turn_host.txt`, `dev_otp.log`,
  `black_meet.db*`) در `.gitignore` هستند و نباید سرچ شوند.

---

## عیب‌یابی
- **تماس برقرار نمی‌شود (میان NAT):** مطمئن شوید `turn.js` و `turn-proxy.js` روی
  :3478 اجرا هستند و `turn_host.txt` میزبان تونل TURN را دارد؛ فالبک آزاد
  `openrelay.metered.ca` هم در `turnConfig()` هست.
- **صدا/تصویر نمی‌آید:** دسترسی میکروفون/دوربین را در مرورگر بدهید؛
  امروزه مرورگر روی URL عمومی **https** اجازه می‌دهد نه روی `localhost`.
- **صدا قطع می‌شود ولی تصویر هست:** میکروفون جداگانه درخواست می‌شود؛
  اگر دستگاه صدا ندارد، آیکون میکروفون را خاموش ببینید.
- **تعداد اعضا:** شمارنده شامل خود شما + همه حاضرین در اتاق است.
- **قالب Tailwind:** بعد از افزودن کلاس جدید: `npm run tailwind:build` (خروجی محلی `assets/css/tailwind.css`).