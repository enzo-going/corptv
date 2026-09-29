# CorporTV — Instalação do Raspberry Pi

Checklist de operação. Siga na ordem. Cada passo tem como conferir se deu certo.

**Tempo estimado:** 40 min na bancada + 15 min no local.

---

## 0. Material

- [ ] Raspberry Pi 4 Model B
- [ ] Fonte oficial USB-C **5,1 V / 3 A (15 W)**. Fonte de celular não serve e a USB da TV muito menos: subtensão trava a Pi de forma intermitente e é difícil de diagnosticar depois.
- [ ] Cartão microSD 32 GB de **alta durabilidade** (endurance) — aqui vale confiabilidade, não capacidade nem preço
- [ ] Case com dissipação passiva — atrás da TV é abafado
- [ ] Cabo **micro**-HDMI (não mini, não full), na saída **HDMI0**, a mais perto da energia
- [ ] Cabo de rede — a TV fica no cabo, não no Wi-Fi
- [ ] Teclado USB (só na bancada)
- [ ] Pendrive com a pasta `agente/`

> **Vídeo:** a Pi 4 decodifica H.264 em hardware, e o padrão do CorporTV é 720p H.264 a ~2,8 Mb/s. Sobra folga. Se o vídeo picotar, o problema é energia ou arquivo fora do padrão — não a placa.

---

## 1. Antes de encostar na Pi: cadastrar a tela no painel

Endereço do servidor neste ambiente: `http://________________`
(preencha antes de imprimir; é o valor que vai no `CORPTV_SERVIDOR` no passo 4)

> **Use o nome completo, com o domínio** (ex.: `http://corportv.seu-dominio`), ou o IP com a porta (`http://IP:3000`).
> O nome curto (`http://corportv`) só funciona em computador que é membro do domínio Windows: ele completa o nome sozinho. A Pi não é membro de domínio, e só completaria se o DHCP da rede entregasse o sufixo — se não entrega, o nome curto não resolve.
> Não resolva isso com `/etc/hosts` em cada Pi: no dia em que o servidor mudar de IP, cada aparelho quebra calado.

1. [ ] Abrir o painel nesse endereço → **Telas** → criar a tela (ex.: `Recepção`), se ainda não existir
2. [ ] Deixar pelo menos um conteúdo agendado para essa tela, senão não há o que baixar e o teste não prova nada

---

## 2. Gravar o cartão (bancada)

1. [ ] Raspberry Pi Imager → **Raspberry Pi OS (64-bit), versão com desktop**
2. [ ] Na engrenagem de configuração, antes de gravar:
   - [ ] hostname: `corptv-<setor>` (ex.: `corptv-recepcao`)
   - [ ] usuário: **`ti`** — o `corptv-agente.service` está escrito para o usuário `ti`; se usar outro nome, tem que editar a linha `User=` do serviço
   - [ ] SSH ligado (facilita o suporte sem levar teclado até a TV)
   - [ ] Wi-Fi: **não configurar**
3. [ ] Gravar, colocar na Pi, ligar no cabo de rede e no HDMI, ligar a energia

**Confere:** chegou no desktop sem o raio amarelo de subtensão no canto da tela.

---

## 3. Preparar o sistema

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y nodejs chromium-browser curl
node -v
```

- [ ] `node -v` respondeu **v18 ou maior**
- [ ] Se `chromium-browser` não existir, instale `chromium` e ajuste o nome no fim do `iniciar-quiosque.sh`

### Sessão gráfica em X11 e tela sem apagar

O `iniciar-quiosque.sh` usa `xset` e o autostart em `~/.config/autostart` — os dois são de X11. O Raspberry Pi OS Bookworm sobe em Wayland por padrão e aí **nada disso funciona**.

```bash
sudo raspi-config
```

- [ ] **Advanced Options → Wayland → X11** (ou W11/Openbox, conforme a versão)
- [ ] **Display Options → Screen Blanking → Disable**
- [ ] **System Options → Boot / Auto Login → Desktop Autologin** (sem isso a sessão gráfica não sobe sozinha depois de uma queda de energia)
- [ ] Reiniciar e confirmar que voltou direto ao desktop, sem pedir senha

### Som pela HDMI

Com a **TV ligada** (sem TV ligada a Pi não enxerga a saída HDMI):

```bash
pactl list short sinks
```

- [ ] Aparece uma linha com `hdmi` — na Pi 4, a HDMI0 é a que tem `fef00700`
- [ ] Nada a ajustar à mão: o quiosque escolhe a HDMI e põe o volume do sistema em 100% a cada início. Quem regula o volume é o painel (por tela) e o controle remoto da TV

---

## 4. Instalar o agente

No painel (entrando como TI), **Telas → Aparelhos → Preparar uma Raspberry nova** → **Copiar**.
Na Pi, abrir o terminal, colar e digitar a senha quando pedir. O comando é o mesmo para todas as Pis.

- [ ] Terminou com `Pronto. Esta Pi (<nome>) já aparece no painel.`
- [ ] No navegador da Pi, `corportv/` abre o painel (nome curto funcionando)
- [ ] Em **Telas → Aparelhos**, a Pi aparece com o nome dela: escolher a tela na lista
- [ ] Em até 2 minutos, `curl -s localhost:8080/status` mostra essa tela em `"tela"`

O script pode ser repetido sem risco. A configuração do aparelho fica em
`/etc/corptv/agente.env`; o limite de download (`CORPTV_LIMITE_MBPS`) segue a
conta `aparelhos × limite ≤ 8 Mb/s`:

| Aparelhos no total | Limite por aparelho | Baixar 170 MB leva |
|---|---|---|
| 1–2 | 4 | ~6 min |
| 4 | 2 | ~11 min |
| 8 | 1 | ~23 min |

Para mudar, acrescentar a linha no `agente.env` e `sudo systemctl restart corptv-agente`.

## 5. Ligar o quiosque

```bash
mkdir -p ~/.config/autostart
cp corptv-quiosque.desktop ~/.config/autostart/
sudo reboot
```

- [ ] Depois do boot a Pi abre sozinha em tela cheia, tocando o conteúdo
- [ ] Sem barra do Chromium, sem ponteiro do mouse parado no meio da tela
- [ ] No painel, a tela aparece **online** (heartbeat a cada 20s)

---

## 6. Testes de aceite — é isso que se mostra ao supervisor

### 6.1 A rede não é usada durante a exibição *(o teste principal)*

- [ ] Com o vídeo tocando, **desconectar o cabo de rede da Pi**
- [ ] O vídeo **continua tocando normalmente**, sem travar, sem tela preta
- [ ] Reconectar: em até 1 minuto a tela volta a aparecer online no painel

Esse teste é a resposta à pergunta da rede: se toca sem cabo, é porque está tocando do disco e não do servidor.

### 6.2 Volta sozinha da queda de energia

- [ ] Tirar a energia na tomada, esperar 10s, religar
- [ ] Sem tocar em nada: sobe o desktop, sobe o agente, abre em tela cheia e volta a tocar

### 6.3 Troca de conteúdo chega sozinha

- [ ] Publicar um vídeo novo no painel para essa tela
- [ ] Em até 1 min o log registra o download; o tempo total depende do limite configurado
- [ ] Enquanto baixa, a TV segue exibindo o conteúdo anterior — comportamento correto, não é falha
- [ ] Terminado o download, o novo conteúdo entra sozinho

### 6.4 O navegador volta sozinho

- [ ] Pelo SSH, derrubar o Chromium de propósito: `pkill chromium`
- [ ] A tela volta a tocar sozinha em poucos segundos, sem reiniciar a Pi
- [ ] `journalctl -t corptv-quiosque` registrou a saída e a reabertura

### 6.5 Som e volume

- [ ] O vídeo sai **com som** pela TV
- [ ] `journalctl -t corptv-quiosque | grep som` mostra a saída HDMI e `volume do sistema em 100%`
- [ ] No painel, **Telas** → volume da tela em **30%**: em até 2 minutos o som abaixa, **sem o vídeo reiniciar**
- [ ] Volume em **0% (Mudo)**: em até 2 minutos a TV fica sem som, sem aviso na tela
- [ ] De volta a 100%: o som volta no início do próximo vídeo (religar o som no meio do vídeo faz alguns navegadores pausarem)

O controle de volume no painel só existe depois que o servidor estiver na versão com ele. Antes disso a TV toca sempre no máximo, e o volume se ajusta no controle remoto.

### 6.6 Número de rede para levar ao supervisor

Com o agente, o esperado é **~106 KB por hora por aparelho** em regime normal, contra **11,7 Mb/s de pico** quando o navegador toca direto do servidor.

---

## Nunca faça

> **Não aponte o navegador da Pi para o endereço do servidor.**
>
> Tem que ser **`http://127.0.0.1:8080`**. A tela funciona igual dos dois jeitos — e é por isso que o erro passa despercebido. Apontando direto no servidor, cada TV volta a puxar 11,7 Mb/s continuamente e a rede dos setores no cabo sente.

Outros:

- Não colocar a Pi no Wi-Fi para "facilitar"
- Não subir vídeo fora do padrão sem converter antes
- Não mexer no `CORPTV_LIMITE_MBPS` para cima sem refazer a conta `aparelhos × limite ≤ 8`

---

## Se der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| TV com o aviso "Falta escolher a tela" | Nenhuma tela escolhida para este aparelho | Painel → **Telas → Aparelhos** → escolher a tela na lista |
| Painel mostra a tela **offline**, agente rodando | O navegador não está exibindo: o agente só repassa o aviso que o player manda | `journalctl -t corptv-quiosque -n 20`; se o Chromium estiver aberto e travado, **Recarregar** no painel |
| "sem contato com o servidor e sem cópia local" | A Pi nunca alcançou o servidor | `curl -I http://SEU-SERVIDOR:3000/health` — se falhar, é rede/VLAN, não é a Pi |
| Nada abre depois do boot | Sessão em Wayland ou sem autologin | Refazer o passo 3 |
| Tela apaga sozinha depois de um tempo | Screen Blanking ligado | `raspi-config` → Display Options → Screen Blanking → Disable |
| Vídeo picotando | Subtensão, ou vídeo fora do padrão | Conferir o raio amarelo na tela e a fonte; conferir a conversão do vídeo |
| Baixa e baixa de novo sem parar | Arquivo mudando no servidor, ou disco cheio | `df -h` e `journalctl -u corptv-agente` |
| Barra "restaurar páginas" cobrindo o vídeo | Chromium fechou de forma anormal | O script já limpa isso no boot; se persistir, reiniciar a Pi |
| Tela volta sozinha de tempos em tempos | Chromium sem memória (a Pi 4 aqui tem 2 GB) | `journalctl -t corptv-quiosque` mostra de quanto em quanto tempo; se for frequente, investigar |
| Imagem sem som | TV desligada quando a Pi ligou, tela em **Mudo** no painel, ou TV mutada | `journalctl -t corptv-quiosque \| grep som`: se disser "nenhuma saida HDMI", ligar a TV e reiniciar a Pi. Conferir o volume da tela no painel e o controle da TV |
| Som baixo mesmo em 100% no painel | Volume da própria TV baixo | Controle remoto da TV. O volume do sistema da Pi o quiosque já deixa em 100% |
| Aviso "Som bloqueado pelo navegador" | Chromium aberto sem o quiosque (sem `--autoplay-policy`) | Abrir pelo `iniciar-quiosque.sh`, não pelo menu. Enquanto isso, Enter no teclado libera o som |
| Agente não alcança o servidor pelo nome | Nome curto (`corportv`) sem o domínio | Trocar o `CORPTV_SERVIDOR` pelo nome completo ou pelo IP:3000 (passo 1) |

Comandos de diagnóstico:

```bash
systemctl status corptv-agente
journalctl -u corptv-agente -n 50
curl -s localhost:8080/status
```

---

## Decisão em aberto: cartão SD somente-leitura

Na revisão de equipamentos ficou a recomendação de deixar o sistema em modo somente-leitura (overlay) para que queda de energia não corrompa o cartão SD. Isso foi decidido quando o plano ainda era a TV puxar o vídeo do servidor.

**Com o agente, overlay puro não serve:** ele guarda a mídia em disco, e no overlay toda escrita vai para a RAM e some no próximo boot. A Pi passaria a rebaixar todo o conteúdo a cada reinício — exatamente o tráfego que o agente existe para evitar.

Se for adotar, a pasta do cache (`CORPTV_CACHE`) precisa ficar numa partição gravável de verdade, fora do overlay. Não fazer isso no piloto: primeiro provar que a operação funciona, depois endurecer.

---

## Registro do quiosque

O navegador tem log próprio, separado do agente:

```bash
journalctl -t corptv-quiosque
```

Serve para responder "a tela ficou preta ontem à noite?" — se o Chromium caiu e voltou, está registrado ali, com o código de saída e há quanto tempo estava de pé.
