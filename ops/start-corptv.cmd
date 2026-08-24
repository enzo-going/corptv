@echo off
cd /d C:\corptv
set PORT=3000
"C:\Program Files\nodejs\node.exe" src\server.js >> "C:\ProgramData\CorporTVLogs\corptv.log" 2>&1
