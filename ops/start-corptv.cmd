@echo off
cd /d C:\corptv
set PORT=3000
set CORPTV_ENDERECO_PUBLICO=http://corportv
REM Sem a pasta, o cmd aborta o redirecionamento e o Node nao sobe.
if not exist "C:\ProgramData\CorporTVLogs" mkdir "C:\ProgramData\CorporTVLogs"
REM Node proprio do CorporTV; sem ele, o do sistema.
set "CORPTV_NODE=C:\corptv\runtime\node.exe"
if not exist "%CORPTV_NODE%" set "CORPTV_NODE=C:\Program Files\nodejs\node.exe"
"%CORPTV_NODE%" src\server.js >> "C:\ProgramData\CorporTVLogs\corptv.log" 2>&1
