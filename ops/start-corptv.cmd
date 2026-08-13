@echo off
setlocal
chcp 65001 >nul
cd /d C:\corptv
set PORT=3000
set NODE_ENV=production
set CORPTV_LOG=C:\ProgramData\CodexInstallLogs\corptv.log

:loop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\corptv\ops\rotate-log.ps1" -Path "%CORPTV_LOG%" -AllowedRoot "C:\ProgramData\CodexInstallLogs" -MaxBytes 10485760 -Keep 5
"C:\Program Files\nodejs\node.exe" src\server.js >> "%CORPTV_LOG%" 2>&1
set EXIT_CODE=%ERRORLEVEL%
echo [%date% %time%] node encerrou (codigo %EXIT_CODE%) - reiniciando em 5s >> "%CORPTV_LOG%"
timeout /t 5 /nobreak >nul
goto loop
