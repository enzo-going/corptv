@echo off
REM Copie para iniciar.local.bat e ajuste. Lido pelo iniciar.bat a cada inicio.
REM Nome completo, com o dominio: funciona tambem fora do dominio (Raspberry,
REM celular). O nome curto so resolve em computador membro do dominio.
set CORPTV_ENDERECO_PUBLICO=http://corportv.seu-dominio
REM Para smart TV sem Raspberry: ela nao usa o DNS interno, entao o nome nao abre.
REM IP fixo do servidor e a porta do CorporTV; o painel mostra este link a mais.
set CORPTV_ENDERECO_TV=http://IP-DO-SERVIDOR:3000
