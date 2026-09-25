@echo off
cd /d C:\corptv
set PORT=3000
REM Sem a pasta, o cmd aborta o redirecionamento e o Node nao sobe.
if not exist "C:\ProgramData\CorporTVLogs" mkdir "C:\ProgramData\CorporTVLogs"
"C:\Program Files\nodejs\node.exe" src\server.js >> "C:\ProgramData\CorporTVLogs\corptv.log" 2>&1
