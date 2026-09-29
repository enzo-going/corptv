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
REM Endereco que o painel mostra nos links do player (nome oficial, via nginx).
set CORPTV_ENDERECO_PUBLICO=http://corportv
REM Ajustes deste servidor (ex.: o nome completo com o dominio, para aparelhos
REM fora do dominio como a Raspberry). Fica fora do repositorio e o deploy nao
REM sobrescreve: copiar iniciar.local.exemplo.bat para iniciar.local.bat.
if exist "C:\corptv\iniciar.local.bat" call "C:\corptv\iniciar.local.bat"
REM Se a pasta do ">>" nao existir, o cmd aborta a linha inteira e o Node nem
REM chega a rodar - sem erro visivel, so o servico fora do ar.
if not exist "C:\ProgramData\CorporTVLogs" mkdir "C:\ProgramData\CorporTVLogs"
REM Node proprio do CorporTV, fora do instalador do servidor. Em 29/09 o Node do
REM sistema foi desinstalado para trocar de versao e o servico nao voltaria no
REM proximo reinicio. Sem o proprio, cai no do sistema, como era antes.
set "CORPTV_NODE=C:\corptv\runtime\node.exe"
if not exist "%CORPTV_NODE%" set "CORPTV_NODE=C:\Program Files\nodejs\node.exe"
"%CORPTV_NODE%" src\server.js >> "C:\ProgramData\CorporTVLogs\corptv.log" 2>&1
