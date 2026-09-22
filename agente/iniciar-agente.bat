@echo off
REM Agente CorporTV para mini PC com Windows.
REM Roda em loop: se o Node cair, volta em 10 segundos.
cd /d "%~dp0"

REM ── Configuracao ──────────────────────────────────────────
set CORPTV_SERVIDOR=http://SERVIDOR-CORPTV:3000
REM Trocar pelo nome da tela cadastrada no painel:
set CORPTV_TELA=teste
set CORPTV_PORTA=8080
REM Ritmo do download em Mb/s (4 aparelhos x 2 = 8, abaixo do teto de 12):
set CORPTV_LIMITE_MBPS=2
set CORPTV_JITTER=90

:loop
node agente.js >> "%~dp0agente.log" 2>&1
echo [%date% %time%] agente encerrou, reiniciando em 10s >> "%~dp0agente.log"
timeout /t 10 /nobreak >nul
goto loop
