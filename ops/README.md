# Operação no Windows

Estes scripts complementam o serviço em instalações Windows locais:

- `../iniciar.bat` (e o equivalente `start-corptv.cmd`): inicia uma única instância do Node, sem loop;
- `watchdog.ps1`: confirma duas falhas de saúde consecutivas antes de reiniciar o processo;
- `backup.ps1`: cria um snapshot diário consistente, com o serviço brevemente parado;
- `register-tasks.ps1`: registra o watchdog e o backup e torna a tarefa principal tolerante a energia/UPS.

O backup guarda os bancos por cópia e as mídias por hardlinks NTFS. Isso protege uma mídia excluída sem duplicar imediatamente vários gigabytes. São mantidos sete snapshots em `C:\corptv\backups\data`.

O iniciador não deve conter um loop de reinício. O watchdog já é o responsável
pelo 24/7; dois mecanismos concorrentes impedem que `schtasks /End` finalize a
tarefa de forma limpa e podem deixar o serviço indisponível.

Para instalar as tarefas em um PowerShell elevado:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\corptv\ops\register-tasks.ps1
```

Para testar somente a saúde, sem reiniciar nada:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\corptv\ops\watchdog.ps1 -CheckOnly
```

Antes de uma restauração manual, pare a tarefa `CorporTV`. Copie os arquivos de `data` do snapshot escolhido para `C:\corptv\data` e recupere somente as mídias necessárias para `C:\corptv\public\uploads`. Depois, inicie a tarefa novamente e confirme `/health`.
