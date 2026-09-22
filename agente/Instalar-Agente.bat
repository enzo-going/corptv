@echo off
setlocal enabledelayedexpansion
title CorporTV - Instalar agente local

REM ============================================================
REM  Instala o agente do CorporTV neste aparelho (mini PC / PC).
REM
REM  O agente baixa o video devagar, guarda no disco e serve em
REM  127.0.0.1. A TV passa a tocar do disco: durante a exibicao
REM  o trafego de rede e praticamente zero.
REM
REM  COMO USAR: clique com o botao direito > Executar como
REM             administrador.
REM ============================================================

REM  ---- AJUSTE AQUI antes de usar em um ambiente novo ----
REM  Endereco do servidor do CorporTV. Exemplo: http://192.168.0.10:3000
set "SERVIDOR=http://SERVIDOR-CORPTV:3000"

set "DESTINO=C:\corptv-agente"
set "TAREFA=CorporTV Agente"

echo.
echo  ==========================================================
echo   CorporTV - Agente local
echo  ==========================================================
echo.

REM  Precisa ser administrador 
net session >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Execute como administrador.
  echo         Botao direito neste arquivo ^> Executar como administrador.
  echo.
  pause
  exit /b 1
)

REM  Node.js instalado? 
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE (
  echo  [ERRO] Node.js nao encontrado neste aparelho.
  echo.
  echo  Instale com:   winget install OpenJS.NodeJS.LTS
  echo  Depois rode este instalador de novo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('"%NODE%" --version 2^>nul') do set "NODEVER=%%V"
echo   Node.js encontrado: !NODEVER!

REM  Nome da tela 
set "TELA=%~1"
if "%TELA%"=="" (
  echo.
  echo   Qual o nome da tela cadastrada no painel?
  echo   ^(veja em %SERVIDOR%/painel ^> Telas^)
  echo.
  set /p "TELA=  Nome da tela: "
)
if "%TELA%"=="" (
  echo  [ERRO] Nome da tela e obrigatorio.
  pause
  exit /b 1
)

REM  Confere se a tela existe no servidor 
echo.
echo   Conferindo a tela "!TELA!" no servidor...
"%NODE%" -e "fetch('!SERVIDOR!/api/player/'+encodeURIComponent(process.argv[1])).then(r=>{if(r.status!==200){console.log('  [ERRO] tela nao encontrada no painel');process.exit(1)}return r.json()}).then(p=>console.log('  OK: '+p.slides.length+' conteudo(s) programado(s)')).catch(e=>{console.log('  [ERRO] sem contato com o servidor: '+e.message);process.exit(1)})" "!TELA!"
if errorlevel 1 (
  echo.
  echo   Corrija o nome da tela ^(ou o servidor^) e tente de novo.
  pause
  exit /b 1
)

REM  Instala 
echo.
echo   Instalando em %DESTINO% ...
if not exist "%DESTINO%" mkdir "%DESTINO%"
copy /Y "%~dp0agente.js" "%DESTINO%\" >nul
if not exist "%DESTINO%\cache" mkdir "%DESTINO%\cache"

> "%DESTINO%\iniciar-agente.bat" (
  echo @echo off
  echo cd /d "%DESTINO%"
  echo set CORPTV_SERVIDOR=!SERVIDOR!
  echo set CORPTV_TELA=!TELA!
  echo set CORPTV_PORTA=8080
  echo set CORPTV_LIMITE_MBPS=2
  echo set CORPTV_JITTER=90
  echo "%NODE%" agente.js ^>^> "%DESTINO%\agente.log" 2^>^&1
)
echo   Configuracao gravada.

REM  Tarefa agendada: sobe sozinho no boot 
schtasks /Delete /TN "%TAREFA%" /F >nul 2>&1
schtasks /Create /TN "%TAREFA%" /TR "\"%DESTINO%\iniciar-agente.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F >nul
if errorlevel 1 (
  echo  [ERRO] Nao consegui registrar a tarefa agendada.
  pause
  exit /b 1
)
echo   Tarefa "%TAREFA%" registrada ^(inicia no boot^).

REM  Sobe agora 
schtasks /Run /TN "%TAREFA%" >nul 2>&1
echo   Agente iniciado. Aguardando responder...

set /a TENTA=0
:espera
set /a TENTA+=1
"%NODE%" -e "fetch('http://127.0.0.1:8080/status').then(r=>r.json()).then(s=>{console.log('  OK - agente no ar. Conteudos prontos: '+s.conteudos_prontos);process.exit(0)}).catch(()=>process.exit(1))" 2>nul
if not errorlevel 1 goto pronto
if !TENTA! geq 15 goto naosubiu
timeout /t 2 /nobreak >nul
goto espera

:naosubiu
echo  [AVISO] O agente ainda nao respondeu. Veja %DESTINO%\agente.log
goto fim

:pronto
echo.
echo  ==========================================================
echo   INSTALADO
echo  ==========================================================
echo    Tela        : !TELA!
echo    Endereco    : http://127.0.0.1:8080
echo    Situacao    : http://127.0.0.1:8080/status
echo    Log         : %DESTINO%\agente.log
echo.
echo   O download do video comeca agora, a 2 Mb/s.
echo   Enquanto baixa, a tela mostra o que ja estiver pronto.
echo.
echo   AGORA: aponte o navegador da TV, em tela cheia, para
echo          http://127.0.0.1:8080
echo   NAO use mais o endereco do servidor nesta tela.
echo  ==========================================================

:fim
echo.
pause
