# Black Meet — Socket.IO Event Contract (Phase 1)

## ۱. فهرست eventهای فعلی (قبل از Phase 1)

### Server → Client (emit)
| Event | جهت | نوع | توضیح |
|---|---|---|---|
| `member-list` | room broadcast | **state** | کل لیست اعضا (full re-render سمت کلاینت) |
| `room-peers` | target | state | لیست peers برای PC creation |
| `peer-joined` / `peer-left` | room | notification | join/leave کاربر |
| `join-request` | room (ادمین) | notification | درخواست ورود کاربر pending |
| `join-alert` | ادمین | notification | اطلاع صوتی به ادمین |
| `approved` / `you-approved` | target | state | تأیید عضویت |
| `you-rejected` / `you-removed` / `you-blocked` | target | state | اخراج/مسدودی |
| `force-disable` | target | state | خاموش‌کردن اجباری mic/cam/screen |
| `member-status` | room | state | تغییر muted/cam/sharing |
| `signal` (WebRTC) | p2p relay | transport | offer/answer/ice |
| `chat` | room | message | پیام چت داخل تماس (بدون persist در Node) |
| `emoji` | room | notification | ایموجی شناور |
| `error-msg` | target | error | خطا |
| `bm:announcements` | broadcast room | notification | اعلان عمومی (از PHP) |

### Client → Server (on)
`bm:subscribe`, `join`, `signal`, `chat`, `emoji`, `member-status`,
`admin-approve`, `admin-reject`, `admin-remove`, `admin-block`, `admin-disable`,
`alert-admin`, `leave`, `disconnect`, `sync`

### مشکلات inventory
- **Dual source of truth**: `admin-approve` سوکتی فقط RAM را عوض می‌کند؛ `api/approve_member.php` فقط DB را. کلاینت هر دو را جدا می‌زند.
- **Chat بدون persist در مسیر سوکت**: `chat` فقط relay است؛ persist جدا با HTTP (`save_message.php`) → پیام ممکن است ذخیره شود ولی نرسد یا برعکس.
- **`sync` polling**: جبران‌کننده inconsistency (هر ۶۰s).
- **`room-peers` duplicate**: هم در join و هم در approve → race در PC creation.
- **بدون handshake auth**: هر socket وصل می‌شود و auth فقط در `join` است.

---

## ۲. قرارداد جدید (Phase 1)

### Namespacing
- `call:*` — اتاق تماس (signaling + members)
- `pv:*` — پیام خصوصی
- `chat:*` — چت داخل تماس
- `notif:*` — اعلان‌ها
- `presence:*` — آنلاین/آفلاین
- `callreq:*` — درخواست تماس 1:1
- `err` — خطای یکنواخت `{ ok:false, error:'CODE', msg? }`

### Client → Server (new/changed)
| Event | Payload | Auth | توضیح |
|---|---|---|---|
| `auth:hello` | `{ userToken? }` | handshake | پس از connect؛ userToken برای صفحات غیر call |
| `presence:ping` | — | handshake | heartbeat هر 25s (سرور هم PING خود Socket.IO را دارد) |
| `call:join` | `{ room, token, user }` | token (HMAC) | جایگزین `join` |
| `call:signal` | `{ to, data }` | room | جایگزین `signal` |
| `chat:send` | `{ body, clientMsgId }` | room | persist در DB (توسط PHP) بعد emit |
| `call:emoji` | `{ emoji }` | room | ایموجی شناور |
| `call:status` | `{ muted, cam, sharing }` | room | جایگزین member-status |
| `call:approve` | `{ userId }` | admin | → DB + state + broadcast (تک‌مسیره) |
| `call:reject` / `call:kick` | `{ userId }` | admin | → DB + خروج اجباری |
| `call:block` | `{ userId }` | admin | → DB (meeting_blocks) + اخراج |
| `call:alert-admin` | — | pending | اطلاع به ادمین |
| `call:leave` | — | room | خروج ارادی |
| `callreq:send` | `{ toUserId, roomId? }` | user | درخواست تماس 1:1 |
| `callreq:accept` / `callreq:reject` / `callreq:cancel` | `{ requestId }` | user | پاسخ |
| `pv:send` | `{ toUserId, body, clientMsgId }` | user | پیام خصوصی → DB → تحویل |
| `pv:typing` | `{ toUserId }` | user | (اختیاری، آینده) |

### Server → Client (new/changed)
| Event | Payload | گیرنده |
|---|---|---|
| `presence:online` / `presence:offline` | `{ userId }` | همه صفحه‌های متصل به user rooms |
| `chat:new-message` | `{ id, userId, name, body, clientMsgId, ts }` | room تماس |
| `chat:ack` | `{ clientMsgId, id, ok, error? }` | فرستنده |
| `pv:new-message` | `{ id, fromUserId, fromName, body, clientMsgId, ts }` | گیرنده + فرستنده (echo) |
| `pv:conversation-updated` | `{ userId, lastBody, ts, unread }` | مدیر (messages page) |
| `notif:new` | `{ id, body, created_at }` | همه کاربران آنلاین |
| `member:joined` / `member:left` | `{ member }` | room |
| `member:updated` | `{ userId, muted, cam, sharing }` | room |
| `member:approved` | `{ member }` | room |
| `member:pending` | `{ member }` | room (ادمین‌ها کارت درخواست می‌سازند) |
| `member:blocked` | `{ userId }` | room |
| `member:kicked` | `{ userId, reason }` | room + target |
| `call:welcome` | `{ meeting, you, members }` | join‌کننده (state اولیه کامل) |
| `callreq:incoming` | `{ requestId, fromUserId, fromName }` | target |
| `callreq:accepted` / `callreq:rejected` / `callreq:cancelled` / `callreq:ended` / `callreq:busy` | `{ requestId, ... }` | طرفین |
| `conn:state` | `{ state: 'connected'|'disconnected' }` | client خودش هم local می‌سازد |

### قواعد
1. **Ack pattern**: هر client→server که state می‌سازد پاسخ `cb({ok})` یا event ack می‌گیرد.
2. **Idempotency**: `clientMsgId` برای chat/pv؛ سرور dedupe می‌کند (DB unique index).
3. **Bootstrap via HTTP، updates via WS**: initial list از SSR/API؛ بعد از آن فقط event.
4. **Single source of truth برای participant actions**: socket handler → PHP internal API (HMAC) → DB → broadcast. کلاینت فقط یک emit می‌زند.
5. **Presence**: Node memory فقط؛ `presence:online/offline` در room per-user. interface برای Redis adapter بعداً.
6. **Error uniform**: `socket.emit('err', { ok:false, error:'NOT_AUTHORIZED' })` — پیام داخلی نشت نمی‌کند.
