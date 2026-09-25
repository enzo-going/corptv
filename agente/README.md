# CorporTV — Agente local

Roda no aparelho atrás da TV (Raspberry Pi, mini PC). Resolve o problema de
**pico de rede** e de **oscilação durante a exibição**.

## O problema

O navegador não baixa o vídeo na velocidade em que o assiste. Quando a TV abre
o player, ele tenta puxar o arquivo inteiro o mais rápido que a rede permitir.

Medições reais neste ambiente:

| Situação | Tráfego |
|---|---|
| 1 TV tocando direto do servidor | **11,7 Mb/s** de pico |
| 4 TVs tocando direto do servidor | **11,6 Mb/s permanentes** (teto do QoS é 12) |
| 4 TVs com agente | **~106 KB por hora** (medido) |

Com 4 telas tocando direto, a rede fica no limite o dia inteiro e qualquer
oscilação vira travamento na tela.

## A solução

```
    SERVIDOR                      APARELHO (Pi / mini PC)              TV
 http://SEU-SERVIDOR:3000                                              │
        │                                                              │
        │  1. programação (JSON, ~1 KB por minuto)                     │
        │ ───────────────────────────────────────►  agente             │
        │                                              │               │
        │  2. vídeo, UMA vez, a 2 Mb/s                 │               │
        │ ───────────────────────────────────────►  disco local        │
        │                                              │               │
        │                                    3. 127.0.0.1 ──────────► navegador
        │                                       (sem rede)              │
```

Durante a exibição o vídeo sai do disco local. **A rede não é usada.**

O player **não muda**: ele continua pedindo `/api/player/<tela>` e a mídia, só
que ao agente, que responde com os arquivos locais.

## Instalação — Raspberry Pi

```bash
sudo apt install -y nodejs
sudo mkdir -p /opt/corptv-agente
sudo cp agente.js iniciar-quiosque.sh /opt/corptv-agente/
sudo chmod +x /opt/corptv-agente/iniciar-quiosque.sh
sudo cp corptv-agente.service /etc/systemd/system/
sudo nano /etc/systemd/system/corptv-agente.service   # ajustar CORPTV_TELA
sudo systemctl daemon-reload
sudo systemctl enable --now corptv-agente
mkdir -p ~/.config/autostart && cp corptv-quiosque.desktop ~/.config/autostart/
```

Conferir: `journalctl -u corptv-agente -f` e `curl localhost:8080/status`

## Instalação — mini PC / PC com Windows (um clique)

Copie esta pasta para o aparelho, clique com o **botão direito** em
`Instalar-Agente.bat` e escolha **Executar como administrador**.

O instalador confere o Node.js, valida o nome da tela contra o servidor,
instala em `C:\corptv-agente`, registra a tarefa que sobe no boot e já começa
o download.

Depois aponte o navegador da TV, em tela cheia, para **http://127.0.0.1:8080** —
e **não** mais para o endereço do servidor.

Sem Node.js no aparelho: `winget install OpenJS.NodeJS.LTS`

## Configuração

| Variável | Padrão | Para que serve |
|---|---|---|
| `CORPTV_SERVIDOR` | **obrigatório** | Endereço do servidor, ex.: `http://192.168.0.10:3000`. Sem ele o agente recusa subir, em vez de tentar um endereço chutado |
| `CORPTV_TELA` | `teste` | Nome da tela cadastrada no painel |
| `CORPTV_PORTA` | `8080` | Porta local (só 127.0.0.1) |
| `CORPTV_CACHE` | `./cache` | Onde a mídia fica guardada |
| `CORPTV_LIMITE_MBPS` | `2` | Ritmo do download |
| `CORPTV_JITTER` | `90` | Espalha o início do download, em segundos |
| `CORPTV_INTERVALO` | `60` | De quanto em quanto tempo confere a programação |
| `CORPTV_INTERVALO_PLAYER` | `600` | De quanto em quanto tempo baixa de novo a página do player (a TV pega a versão nova no recarregamento da meia-noite) |

### Como escolher o limite

O servidor tem teto de **12 Mb/s** (política de QoS da rede).
A conta é simples: `aparelhos × limite` deve caber com folga nesse teto.

| Aparelhos | Limite recomendado | Total | Tempo para baixar 170 MB |
|---|---|---|---|
| 1–2 | 4 Mb/s | 8 Mb/s | ~6 min |
| 4 | 2 Mb/s | 8 Mb/s | ~11 min |
| 8 | 1 Mb/s | 8 Mb/s | ~23 min |

O download só acontece quando o vídeo **muda**. Demorar não é problema: a TV
continua exibindo o conteúdo anterior enquanto o novo baixa.

## O que o agente garante

- **Retomada**: se a rede cair no meio, continua de onde parou (testado
  derrubando o processo com 42 MB baixados — retomou em vez de recomeçar).
- **Tentativas espaçadas**: 1s, 2s, 5s, 10s, 30s. Não fica martelando o servidor.
- **Só troca quando muda**: compara o `ETag` e o tamanho do arquivo. Se o vídeo
  é o mesmo, não baixa nada — só o JSON de ~1 KB por minuto.
- **Arquivo incompleto nunca é exibido**: baixa como `.parcial` e só renomeia no
  fim, depois de conferir o tamanho.
- **Funciona sem servidor**: se o servidor cair, continua exibindo o que está no
  disco. Ao voltar, sincroniza sozinho.
- **Espalha a carga**: com vários aparelhos ligando juntos, o jitter evita que
  todos baixem no mesmo instante.
- **Limpa o disco**: mídia que saiu da programação é apagada.
- **Heartbeat**: o painel continua mostrando a tela como online.
- **Som pela HDMI**: o quiosque escolhe a saída HDMI e deixa o volume do sistema
  em 100% a cada início. O volume de cada tela se ajusta no painel (Telas) e
  chega à TV em até 2 minutos; o controle remoto da TV continua valendo por cima.
- **Player sempre atualizado**: a página do player é baixada de novo a cada 10
  minutos, então correções publicadas no servidor chegam sem reiniciar a Pi.

## Verificação

`http://127.0.0.1:8080/status` mostra o que já está no disco e se há download
em andamento:

```json
{
  "tela": "recepcao",
  "limite_mbps": 2,
  "baixando": false,
  "conteudos_prontos": 1,
  "arquivos": [ { "arquivo": "b4ccb4c5….mp4", "mb": 170.2, "no_disco": true } ]
}
```

## Limites conhecidos

- O agente serve só em `127.0.0.1` — de propósito. Não é um servidor de rede.
- Não valida hash do arquivo, só o tamanho. O servidor não expõe checksum hoje;
  se algum dia expuser, dá para apertar essa checagem.
- A primeira exibição depois de trocar o vídeo espera o download terminar. É o
  comportamento desejado: melhor esperar do que exibir travando.
