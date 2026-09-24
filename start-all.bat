@echo off
title Black Meet Server
color 0A

echo.
echo  ==========================================
echo     Black Meet (Node) - Starting Services
echo  ==========================================
echo.

REM === Node App (web + REST + Socket.IO + SQLite) ===
echo [1/5] Node app (port 3000^)...
netstat -an | findstr ":3000" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-App" node server/index.js
    timeout /t 3 /nobreak >nul
    echo       Started
)

REM === TURN Server (UDP 3478) ===
echo [2/5] TURN server (UDP 3478^)...
netstat -an | findstr ":3478" | findstr "UDP" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-Turn" node turn.js
    timeout /t 2 /nobreak >nul
    echo       Started
)

REM === TCP Proxy (TCP 3478) ===
echo [3/5] TCP proxy (TCP 3478^)...
netstat -an | findstr ":3478" | findstr "TCP" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-Proxy" node turn-proxy.js
    timeout /t 2 /nobreak >nul
    echo       Started
)

REM === Web Tunnel (cloudflare -> ssh -> bore) ===
echo [4/5] Website tunnel (cloudflare -^> ssh -^> bore^)...
tasklist | findstr /I "ssh.exe cloudflared.exe bore.exe" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Tunnel" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File keep-tunnel-chain.ps1
    timeout /t 5 /nobreak >nul
    echo       Started
)

REM === TURN Relay Tunnel (bore) ===
echo [5/5] TURN relay tunnel (bore^)...
if exist "C:\Users\BlackLine\Downloads\bore-tool\bore.exe" (
    cd /d C:\xampp\htdocs\black-meet
    start "Bore" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File keep-bore.ps1
    timeout /t 3 /nobreak >nul
    echo       Started
) else (
    echo       Skipped - bore.exe not found
)

echo.
echo  ==========================================
echo       Waiting for services to start...
echo  ==========================================
timeout /t 8 /nobreak >nul

echo.
echo  ==========================================
echo              SERVICE STATUS
echo  ==========================================
echo.

REM Check Node app
netstat -an | findstr ":3000" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (echo  [OK] Node App    :3000) else (echo  [OFF] Node App   :3000)

REM Check TURN
netstat -an | findstr ":3478" | findstr "UDP" >nul 2>&1
if %errorlevel%==0 (echo  [OK] TURN        UDP:3478) else (echo  [OFF] TURN       UDP:3478)

REM Check TCP proxy
netstat -an | findstr ":3478" | findstr "TCP" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (echo  [OK] TCP proxy    TCP:3478) else (echo  [OFF] TCP proxy   TCP:3478)

REM Check Website Tunnel
tasklist | findstr /I "ssh.exe cloudflared.exe bore.exe" >nul 2>&1
if %errorlevel%==0 (echo  [OK] Website Tunnel active) else (echo  [OFF] Website Tunnel DOWN)

echo.
if exist C:\xampp\htdocs\black-meet\tunnel_url.txt (
    set /p URL=<C:\xampp\htdocs\black-meet\tunnel_url.txt
    echo  Website: %URL%
)
if exist C:\xampp\htdocs\black-meet\turn_host.txt (
    set /p TH=<C:\xampp\htdocs\black-meet\turn_host.txt
    echo  TURN:   turn://%TH%
)

echo.
echo  NOTE: Apache/MySQL no longer needed. The app is served ONLY
echo  by Node :3000. Start XAMPP separately if you still want
echo  phpMyAdmin for the old MySQL data.
echo.
echo  ==========================================
echo    Press any key to exit...
echo  ==========================================
pause >nul