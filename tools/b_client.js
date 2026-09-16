// tools/b_client.js — real second-party client over Apache for browser-pair tests.
// Signs up a fresh user (DEV_MODE otp), opens call.php (participant row + meeting
// token), joins the room, and logs live events (approve / chat / presence).
const http = require('http');
const { io } = require('socket.io-client');

const ROOM = process.argv[2] || 'wThIrNjhykaS2eJn';
const PHP = 'http://localhost/black-meet';

function req(method, path, jar, form, cb) {
  const body = form ? new URLSearchParams(form).toString() : null;
  const r = http.request(PHP + path, {
    method,
    headers: Object.assign({ Cookie: jar.join('; ') }, body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
  }, res => {
    (res.headers['set-cookie'] || []).forEach(c => {
      const n = c.split('=')[0];
      const i = jar.findIndex(x => x.startsWith(n + '='));
      if (i >= 0) jar[i] = c.split(';')[0]; else jar.push(c.split(';')[0]);
    });
    let d = ''; res.on('data', c => d += c); res.on('end', () => cb(d));
  });
  if (body) r.write(body);
  r.end();
}

const jar = [];
const events = [];
const stamp = Date.now() % 1000000;
const phone = '0912' + String(7000000 + stamp);
const uname = 'uB' + stamp;

req('GET', '/index.php', jar, null, () => {
  req('GET', '/index.php', jar, null, (html) => {
    const m = html.match(/window\.CSRF = "([^"]*)"/);
    const csrf = m ? m[1] : '';
    req('POST', '/api/signup.php', jar, { csrf, full_name: 'کاربر B', username: uname, email: 'ub' + stamp + '@t.com', phone, password: 'passB123' }, (resp) => {
      let otp; try { otp = JSON.parse(resp).otp; } catch (e) {}
      if (!otp) { console.log('SIGNUP FAILED: ' + resp.slice(0, 120)); process.exit(1); return; }
      req('POST', '/api/verify_otp.php', jar, { csrf, phone, code: String(otp), purpose: 'signup' }, (vf) => {
        if (!String(vf).includes('"ok":true')) { console.log('VERIFY FAILED: ' + vf.slice(0, 120)); process.exit(1); return; }
        req('GET', '/api/socket_token.php', jar, null, (b) => {
          const t = JSON.parse(b);
          // preflight: open call.php once — creates the pending participant row
          // and is where the meeting-scoped token comes from in the real flow
          req('GET', '/call.php?room=' + ROOM, jar, null, (pageHtml) => {
            const tm = pageHtml.match(/"token":"([^"]+)"/);
            const meetToken = tm ? tm[1] : null;
            const s = io('http://localhost', { transports: ['polling', 'websocket'], auth: { token: t.token }, reconnection: false });
            s.on('connect', () => {
              console.log('B (uid=' + t.user_id + ') connected via ' + s.io.engine.transport.name + '; joining ' + ROOM);
              s.emit('call:join', { room: ROOM, token: meetToken, user: { id: t.user_id, name: 'کاربر B', username: uname, avatar_color: '#10b981' } }, (j) => {
                console.log('B join: ' + JSON.stringify(j).slice(0, 140));
                ['you-approved', 'member:approved', 'chat:new-message', 'user:online', 'call:signal', 'you-removed', 'you-blocked'].forEach(ev => {
                  s.on(ev, d => { events.push(ev); console.log('EVENT: ' + ev); });
                });
                console.log('B waiting — approve from BROWSER admin panel...');
              });
            });
            let n = 0;
            setInterval(() => {
              n++;
              if (events.includes('you-approved')) { console.log('PASS: B approved live (no refresh)'); process.exit(0); }
              if (n >= 18) { console.log('SUMMARY events: ' + JSON.stringify(events)); process.exit(events.length ? 0 : 4); }
            }, 5000);
            s.on('connect_error', e => { console.log('connect_error: ' + e.message); process.exit(2); });
          });
        });
      });
    });
  });
});
