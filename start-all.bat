@echo off
title Black Meet Server
color 0A

echo.
echo  ==========================================
echo     Black Meet - Starting All Services
echo  ==========================================
echo.

REM === Apache ===
echo [1/7] Apache (port 80^)...
netstat -an | findstr ":80 " | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    start "Apache" "C:\xampp\apache\bin\httpd.exe"
    timeout /t 3 /nobreak >nul
    echo       Started
)

REM === MySQL ===
echo [2/7] MySQL (port 3306^)...
netstat -an | findstr ":3306 " | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    start "MySQL" "C:\xampp\mysql\bin\mysqld.exe" --standalone
    timeout /t 3 /nobreak >nul
    echo       Started
)

REM === Node Signaling Server ===
echo [3/7] Node signaling (port 3000^)...
netstat -an | findstr ":3000" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-Signal" node server.js
    timeout /t 3 /nobreak >nul
    echo       Started
)

REM === TURN Server ===
echo [4/7] TURN server (port 3478^)...
netstat -an | findstr ":3478" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-Turn" node turn.js
    timeout /t 2 /nobreak >nul
    echo       Started
)

REM === TCP Proxy ===
echo [5/7] TCP proxy (port 3478^)...
netstat -an | findstr ":3478" | findstr "TCP" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Node-Proxy" node turn-proxy.js
    timeout /t 2 /nobreak >nul
    echo       Started
)

REM === SSH Tunnel ===
echo [6/7] Website tunnel...
tasklist | findstr "ssh.exe" >nul 2>&1
if %errorlevel%==0 (
    echo       Already running
) else (
    cd /d C:\xampp\htdocs\black-meet
    start "Tunnel" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File keep-tunnel.ps1
    timeout /t 5 /nobreak >nul
    echo       Started
)

REM === Bore Tunnel ===
echo [7/7] TURN tunnel (bore^)...
if exist "C:\Users\BLACKL~1\AppData\Local\Temp\opencode\bore\bore.exe" (
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

REM Check Apache
netstat -an | findstr ":80 " | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (echo  [OK] Apache        :80) else (echo  [OFF] Apache       :80)

REM Check MySQL
netstat -an | findstr ":3306 " | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (echo  [OK] MySQL         :3306) else (echo  [OFF] MySQL        :3306)

REM Check Node
netstat -an | findstr ":3000" | findstr "LISTEN" >nul 2>&1
if %errorlevel%==0 (echo  [OK] Node          :3000) else (echo  [OFF] Node         :3000)

REM Check SSH
tasklist | findstr "ssh.exe" >nul 2>&1
if %errorlevel%==0 (echo  [OK] SSH Tunnel    active) else (echo  [OFF] SSH Tunnel   DOWN)

echo.
if exist C:\xampp\htdocs\black-meet\tunnel_url.txt (
    set /p URL=<C:\xampp\htdocs\black-meet\tunnel_url.txt
    echo  Website: %URL%
)

echo.
echo  ==========================================
echo    Press any key to exit...
echo  ==========================================
pause >nul
