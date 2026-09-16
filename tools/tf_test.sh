#!/bin/bash
BASE="http://localhost/black-meet"
JAR=/tmp/tf1.txt
rm -f $JAR
curl -s -c $JAR "$BASE/index.php" -o /dev/null
CSRF=$(curl -s -b $JAR "$BASE/index.php" | grep -o 'window.CSRF = "[^"]*"' | sed 's/.*"\(.*\)".*/\1/')
R=$RANDOM
SU=$(curl -s -b $JAR -X POST "$BASE/api/signup.php" -d "csrf=$CSRF&full_name=TF&username=tfuser$R&email=tf$R@t.com&phone=0912333$R&password=pass123456")
echo "signup: $SU"
OTP=$(echo "$SU" | sed 's/.*"otp":"\([^"]*\)".*/\1/')
PH=$(echo "$SU" | sed 's/.*"phone":"\([^"]*\)".*/\1/')
echo "verify: $(curl -s -b $JAR -c $JAR -X POST "$BASE/api/verify_otp.php" -d "csrf=$CSRF&phone=$PH&code=$OTP&purpose=signup")"
echo "home: $(curl -s -b $JAR "$BASE/home.php" -o /dev/null -w "%{http_code}")"
CSRF2=$(curl -s -b $JAR "$BASE/home.php" | grep -o 'window.CSRF = "[^"]*"' | sed 's/.*"\(.*\)".*/\1/')
echo "create: $(curl -s -b $JAR -X POST "$BASE/api/create_meeting.php" -d "csrf=$CSRF2&title=TF+Meeting")"
