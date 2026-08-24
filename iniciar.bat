@echo off
REM CorporTV - iniciado pela Tarefa Agendada do Windows (tarefa "CorporTV").
REM
REM SEM LOOP DE PROPOSITO. Quem cuida do 24/7 e a tarefa "CorporTV Watchdog",
REM que confere a saude e reinicia quando precisa (ops\watchdog.ps1).
REM
REM Um loop aqui brigava com o watchdog: o "schtasks /End" matava a tarefa mas
REM o cmd.exe do loop sobrevivia, o Agendador continuava vendo a tarefa como
REM "Em execucao" e recusava subir outra instancia. O servico ficava fora do ar
REM sem ninguem conseguir reinicia-lo remotamente. Nao reintroduzir o loop.
cd /d C:\corptv
set PORT=3000
"C:\Program Files\nodejs\node.exe" src\server.js >> "C:\ProgramData\CorporTVLogs\corptv.log" 2>&1
