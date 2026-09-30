# AGENTS.md

Persian (RTL) group voice/video-chat app like Google Meet. Single **Node.js** process: Express + Socket.IO + SQLite (`node:sqlite`), all originally ported from a PHP/Apache/MySQL app. Local dev on Windows. No tests, no linter, no build step (except regenerating Tailwind CSS).

## Local stack (all started by `start-all.bat`)

- Node app `server/index.js` :3000 — serves web pages (EJS), REST API, Socket.IO, static assets, and SQLite. **Apache/MySQL are gone**; the app is only reachable at port 3000.
- TURN `node turn.js` UDP :3478, TCP relay `node turn-proxy.js` TCP :3478.
- Website tunnel = `keep-tunnel-chain.ps1` watchdog with fallback **Cloudflare -> SSH localhost.run -> SSH serveo.net -> bore** (`bin\cloudflared.exe` default; also reads `C:\Users\BlackLine\Downloads\bore-tool\bore.exe`). Writes the CURRENT public URL to `tunnel_url.txt`; loops forever. On the first health-checked URL it opens the site in Chrome once. Exactly ONE chain runs (global mutex + sibling-kill at startup — duplicate instances fight over `tunnel_url.txt` and reset each other's tunnels). **All methods point at `127.0.0.1:3000`** (never `localhost` — cloudflared resolves it to IPv6 `[::1]` and can't dial). Health check = `GET /black-meet/login` through the tunnel. `start-all.bat` waits up to 90s for a URL and opens Chrome on the public URL, falling back to `http://localhost:3000/black-meet/` when no tunnel is up yet.
- `keep-bore.ps1` -> bore tunnel for TURN relay (port 3478), writes `turn_host.txt`.
- **bore.exe gets flagged/deleted by Windows Defender** — keep-bore restores it from local zips if present; cross-NAT media falls back to the metered.ca TURN in `turnConfig()`.
- `tunnel.cmd`/`tunnels.ps1` launch the chain + TURN relay manually.
- `start-all.bat` must stay open and end with `pause` — don't remove the pause.

## Wiring / gotchas

- `base_url()`/`baseUrl(req)` (server/lib/helpers.js) **hardcodes the `/black-meet` path**. All routes are mounted at `/black-meet/*` with clean, PHP-free URLs (`/black-meet/login`, `/home`, `/create`, `/profile`, `/meeting?room=…`, `/messages`, `/members`, `/forgot-password`; API at `/black-meet/api/…` like `api/meetings/create`, `api/messages/conversations`). Old `.php` URLs still work via 308 redirects: pages.js `aliasPhp()` map + api.js `PH_TO_CLEAN` compatibility middleware (`/api/*.php` → clean; POST bodies are not preserved on redirect, but all current clients use the clean names). The root `/socket.io/` path is served at the server root (not under `/black-meet`).
- The call-page member info panel fetches `GET api/members/:userId` (usable only for two users sharing an active meeting, or self).
- Always build URLs with `asset_url()/assetUrl()` — it appends `?v=<mtime>`. Hardcoded css/js paths are the classic "my change isn't showing" bug.
- Socket.IO event names are defined once in `shared/socket-events.js` (browser global `BMEv`, and `require`d by Node). Add/change events there, not as inline strings.
- Socket auth is an HMAC token (`makeSocketToken`/`verifySocketToken`), 24h TTL, `cfg.secret`. Watch the `|`delimiter format `userId|meetingId|ts.sig`.
- The old `api/internal.php` / `/__broadcast` server-to-server hop is gone: sockets call `server/lib/internal.js` directly (synchronous; sockets.js wraps each fn in a Promise). `broadcast_secret`/`BM_BROADCAST_SECRET` is now unused but still read by `config.js`.
- Sessions are SQLite-backed (`bm_sessions` table), cookie `bm`, httpOnly + SameSite=Lax + Secure-over-https. CSRF = 32-hex token stored in the session, verified on every POST (`csrfToken`/`csrfValid`). `establishLoginSession` rotates the sid on login.
- UI is Persian RTL; templates are EJS under `server/views/` (`head.ejs` partial). Keep UTF-8. Persian text font is **Vazirmatn bundled locally** (`fonts/`, `@font-face` in `assets/css/styles.css`).
- **Tailwind is self-hosted, no CDN** (CDN is blocked in Iran). Config: `tailwind.config.js`; generate with `npm run tailwind:build` → `assets/css/tailwind.css` (committed). Rebuild it whenever you add new utility classes; still-hosted classes rely on JIT scanning `server/views/**/*.ejs`, `assets/js/**/*.js`, `shared/**/*.js`.
- Icons: Material Symbols via local `fonts/material-symbols-outlined.css`; Google Fonts/jSDelivr links are removed on purpose — do not re-add them. Since local Tailwind uses hexadecimal colors, no `@theme`/dynamic color classes exist.

## Config & secrets

- `config.json` holds `secret`, `broadcast_secret`, `DEV_MODE`, `socket_port`, `base_url`, TURN creds. Read once via `app_config()/appConfig()` (cached).
- `DEV_MODE: true` returns the OTP in API responses and logs it to `dev_otp.log`. **Currently `true` locally** (no SMS gateway) — the user needs the OTP shown on the verify page. Must be `false` in production. config.json is a tracked secret; never push its current value.
- Passwords are bcrypt via `bcryptjs` (`server/lib/pwd.js`). Legacy **plaintext** rows are still accepted and transparently upgraded to bcrypt (`verifyAndUpgradePassword`). Don't remove that path.
- DB: SQLite at repo root as `black_meet.db` (`node:sqlite` `DatabaseSync`, WAL). Schema at `server/lib/schema.sql` (idempotent; `db.js` runs it on boot). `BM_DB_PATH` env overrides the file location (used by Render).

## Git hygiene (important)

- `.gitignore` lists `config.json`, `.env`, `tunnel_url.txt`, `turn_host.txt`, `node.err`, `dev_otp.log`, `black_meet.db*` — but several are **already tracked** in history. Before any push: `git rm --cached <file>`. Never commit them again; the tunnel watchers rewrite the txt files constantly.
- GitHub remote is `https://github.com/maxmancoder/black-meet` (user `blackline`). `gh` CLI is not installed.

## DB / migrations

- Old MySQL schema source: `sql/schema.sql` + `sql/migrations/` (for reference / import tool only). The Node app owns `server/lib/schema.sql` now — no runtime DDL, no `ensure_*` functions.

## Deploy (Render)

- For production run a single Node service (`npm start`) exposing port 3000; `server/index.js` honors `process.env.PORT` and `BM_DB_PATH`. Old Render/Docker/PHP artifacts were removed in the Node rewrite.

## Security

- Apache is gone; the old `.htaccess`/mod_rewrite rules no longer apply and the file is deleted. Static serving is Express `express.static` over hardened-scoped mounts (`assets`, `fonts`, `shared`, `icons`, `uploads`); avatar uploads validate MIME + 2 MB cap via `multer`. If you reintroduce Apache, keep the old block rules.