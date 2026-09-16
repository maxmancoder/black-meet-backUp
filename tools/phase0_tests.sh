#!/bin/bash
# Phase 0 regression test suite (bash + curl)
BASE="http://localhost/black-meet"
JAR="/tmp/bm_test_jar.txt"
rm -f "$JAR" /tmp/bm_t3.txt /tmp/bm_t5.txt /tmp/bm_t10.txt /tmp/bm_t11.txt /tmp/bm_t14.txt

get_csrf() {
  curl -s -b "$1" "$BASE/index.php" | grep -o 'window.CSRF = "[^"]*"' | sed 's/.*"\(.*\)".*/\1/'
}

echo "=== T1: signup + OTP flow ==="
curl -s -c "$JAR" "$BASE/index.php" -o /dev/null
CSRF=$(get_csrf "$JAR")
RND=$RANDOM
SU=$(curl -s -b "$JAR" -X POST "$BASE/api/signup.php" \
  -d "csrf=$CSRF&full_name=Phase+Tester&username=phtester$RND&email=pt$RND@test.com&phone=0912000$RND&password=testpass123")
echo "$SU"
SUOTP=$(echo "$SU" | sed 's/.*"otp":"\([^"]*\)".*/\1/')
SUPHONE=$(echo "$SU" | sed 's/.*"phone":"\([^"]*\)".*/\1/')

echo "=== T2: verify OTP (correct) ==="
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/verify_otp.php" -d "csrf=$CSRF&phone=$SUPHONE&code=$SUOTP&purpose=signup"
echo
echo "T2a: home page: $(curl -s -b "$JAR" "$BASE/home.php" -o /dev/null -w "%{http_code}")"
CSRF1=$(curl -s -b "$JAR" "$BASE/home.php" | grep -o 'window.CSRF = "[^"]*"' | sed 's/.*"\(.*\)".*/\1/')
echo "T2b: create meeting: $(curl -s -b "$JAR" -X POST "$BASE/api/create_meeting.php" -d "csrf=$CSRF1&title=Signup+User+Meeting" | head -c 120)"
ROOM1=$(curl -s -b "$JAR" -X POST "$BASE/api/create_meeting.php" -d "csrf=$CSRF1&title=Signup+User+Meeting" | sed 's/.*"room_id":"\([^"]*\)".*/\1/')
echo "T2c: call room: $(curl -s -b "$JAR" "$BASE/call.php?room=$ROOM1" | grep -c 'window.INIT') INIT blocks"

echo "=== T3: OTP replay (must fail) ==="
rm -f /tmp/bm_t3.txt; curl -s -c /tmp/bm_t3.txt "$BASE/index.php" -o /dev/null
CSRF3=$(get_csrf /tmp/bm_t3.txt)
curl -s -b /tmp/bm_t3.txt -X POST "$BASE/api/verify_otp.php" -d "csrf=$CSRF3&phone=$SUPHONE&code=$SUOTP&purpose=signup"
echo

echo "=== T5: email login (bcrypt-verified user) ==="
curl -s -c /tmp/bm_t5.txt "$BASE/index.php" -o /dev/null
CSRF5=$(get_csrf /tmp/bm_t5.txt)
curl -s -b /tmp/bm_t5.txt -c /tmp/bm_t5.txt -X POST "$BASE/api/login_email.php" -d "csrf=$CSRF5&email=av0098056@gmail.com&password=amirali1388"
echo
echo "T5a: home page: $(curl -s -b /tmp/bm_t5.txt "$BASE/home.php" -o /dev/null -w "%{http_code}")"

echo "=== T6: create meeting (admin) ==="
CSRF6=$(curl -s -b /tmp/bm_t5.txt "$BASE/home.php" | grep -o 'window.CSRF = "[^"]*"' | sed 's/.*"\(.*\)".*/\1/')
CM=$(curl -s -b /tmp/bm_t5.txt -X POST "$BASE/api/create_meeting.php" -d "csrf=$CSRF6&title=Phase0+Regression")
echo "$CM"
ROOM=$(echo "$CM" | sed 's/.*"room_id":"\([^"]*\)".*/\1/')

echo "=== T7: call room page ==="
echo "call.php INIT blocks: $(curl -s -b /tmp/bm_t5.txt "$BASE/call.php?room=$ROOM" | grep -c 'window.INIT')"

echo "=== T8: logout ==="
curl -s -b /tmp/bm_t5.txt -c /tmp/bm_t5.txt -X POST "$BASE/api/logout.php" -d "csrf=$CSRF6"
echo
echo "T8a: home after logout: $(curl -s -b /tmp/bm_t5.txt "$BASE/home.php" -o /dev/null -w "%{http_code}") (expect 302)"

echo "=== T9: chat persistence (must require login) ==="
curl -s -b /tmp/bm_t5.txt -X POST "$BASE/api/save_message.php" -d "csrf=$CSRF6&body=hello&meeting_id=1"
echo

echo "=== T10: brute-force lockout (7 wrong codes) ==="
curl -s -c /tmp/bm_t10.txt "$BASE/index.php" -o /dev/null
CSRF10=$(get_csrf /tmp/bm_t10.txt)
# clean previous rows/failures for this test phone, then request a FRESH code
curl -s -b /tmp/bm_t10.txt -X POST "$BASE/api/resend_otp.php" -d "csrf=$CSRF10&phone=09331660212&purpose=login_phone" -o /dev/null
php -r "\$p=new PDO('mysql:host=localhost;dbname=blackmeet','root',''); \$p->prepare('DELETE FROM verification_codes WHERE identifier LIKE ?')->execute(['bf|09331660212']);"
for i in 1 2 3 4 5 6 7; do
  R=$(curl -s -b /tmp/bm_t10.txt -X POST "$BASE/api/verify_otp.php" -d "csrf=$CSRF10&phone=09331660212&code=00000$i&purpose=login_phone")
  echo "attempt $i: $(echo "$R" | head -c 80)"
done

echo "=== T11: rate limit OTP send (6 sends) ==="
php -r "\$p=new PDO('mysql:host=localhost;dbname=blackmeet','root',''); \$p->prepare('DELETE FROM verification_codes WHERE identifier=?')->execute(['09331660212']); \$p->prepare('DELETE FROM verification_codes WHERE identifier LIKE ?')->execute(['bf|09331660212']);"
curl -s -c /tmp/bm_t11.txt "$BASE/index.php" -o /dev/null
CSRF11=$(get_csrf /tmp/bm_t11.txt)
for i in 1 2 3 4 5 6 7; do
  R=$(curl -s -b /tmp/bm_t11.txt -X POST "$BASE/api/resend_otp.php" -d "csrf=$CSRF11&phone=09331660212&purpose=login_phone")
  echo "send $i: $(echo "$R" | head -c 90)"
done

echo "=== T12: broadcast auth ==="
node -e "
const http=require('http'),crypto=require('crypto');
const data=JSON.stringify({room:'announcements',event:'announcements',data:{body:'x'}});
http.request({host:'127.0.0.1',port:3000,path:'/__broadcast',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}},r=>{console.log('no-auth:',r.statusCode);process.exit(0);}).end(data);
" 2>/dev/null || echo "server not running"

echo "=== T13: sensitive files blocked ==="
for p in .env config.json sql/schema.sql keep-tunnel.ps1 node.log turn_host.txt tunnel_url.txt server.js; do
  echo "$p => $(curl -s -o /dev/null -w "%{http_code}" "$BASE/$p")"
done

echo "=== T14: announcements (login required, returns JSON) ==="
curl -s -c /tmp/bm_t14.txt "$BASE/index.php" -o /dev/null
CSRF14=$(get_csrf /tmp/bm_t14.txt)
curl -s -b /tmp/bm_t14.txt -c /tmp/bm_t14.txt -X POST "$BASE/api/login_email.php" -d "csrf=$CSRF14&email=av0098056@gmail.com&password=amirali1388" -o /dev/null
echo "unauthenticated: $(curl -s "$BASE/api/announcements.php" | head -c 60)"
echo "authenticated: $(curl -s -b /tmp/bm_t14.txt "$BASE/api/announcements.php" | head -c 60)"

echo "ALL TESTS DONE"
