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

Endereço do servidor neste ambiente: `http://________________:3000`
(preencha antes de imprimir; é o valor que vai no `CORPTV_SERVIDOR` no passo 4)

1. [ ] Abrir o painel nesse endereço → **Telas** → criar a tela (ex.: `Recepção`)
2. [ ] Copiar o **slug** da URL do player que o painel mostra — é a parte final de `/player/<slug>`

> **Atenção:** o slug **não** é o nome da tela. `Recepção` vira `recepcao`. É esse valor, sem acento, que vai no `CORPTV_TELA` mais adiante. Errar aqui é a causa nº 1 de tela preta.

Slug desta tela: `________________`

3. [ ] Deixar pelo menos um conteúdo agendado para essa tela, senão não há o que baixar e o teste não prova nada

---

## 2. Gravar o cartão (bancada)

1. [ ] Raspberry Pi Imager → **Raspberry Pi OS (64-bit), versão com desktop**
2. [ ] Na engrenagem de configuração, antes de gravar:
   - [ ] hostname: `corptv-<setor>` (ex.: `corptv-recepcao`)
   - [ ] usuário: **`pi`** — o `corptv-agente.service` está escrito para o usuário `pi`; se usar outro nome, tem que editar o serviço
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

---

## 4. Instalar o agente

```bash
sudo mkdir -p /opt/corptv-agente
sudo cp agente.js iniciar-quiosque.sh /opt/corptv-agente/
sudo chmod +x /opt/corptv-agente/iniciar-quiosque.sh
sudo cp corptv-agente.service /etc/systemd/system/
sudo nano /etc/systemd/system/corptv-agente.service
```

No editor, ajustar:

- [ ] `CORPTV_TELA=` → **o slug anotado no passo 1**
- [ ] `CORPTV_LIMITE_MBPS=` → pela conta `aparelhos × limite ≤ 8 Mb/s` (teto do QoS do servidor é 12)

| Aparelhos no total | Limite por aparelho | Baixar 170 MB leva |
|---|---|---|
| 1–2 | 4 | ~6 min |
| 4 | 2 | ~11 min |
| 8 | 1 | ~23 min |

Subir o serviço:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now corptv-agente
journalctl -u corptv-agente -f
```

- [ ] O log mostra `midia nova, baixando` e depois `download concluido`
- [ ] Enquanto baixa, **não é erro** a tela ainda não ter conteúdo — a playlist só aceita o que já está inteiro no disco

**Confere:**

```bash
curl -s localhost:8080/status
```

- [ ] `"tela"` é o slug certo
- [ ] `"conteudos_prontos"` é maior que zero
- [ ] `"no_disco": true` nos arquivos

---

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

### 6.5 Número de rede para levar ao supervisor

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
| Tela preta, agente rodando | Slug errado em `CORPTV_TELA` | `curl -s localhost:8080/status` e comparar com a URL do player no painel |
| "sem contato com o servidor e sem cópia local" | A Pi nunca alcançou o servidor | `curl -I http://SEU-SERVIDOR:3000/health` — se falhar, é rede/VLAN, não é a Pi |
| Nada abre depois do boot | Sessão em Wayland ou sem autologin | Refazer o passo 3 |
| Tela apaga sozinha depois de um tempo | Screen Blanking ligado | `raspi-config` → Display Options → Screen Blanking → Disable |
| Vídeo picotando | Subtensão, ou vídeo fora do padrão | Conferir o raio amarelo na tela e a fonte; conferir a conversão do vídeo |
| Baixa e baixa de novo sem parar | Arquivo mudando no servidor, ou disco cheio | `df -h` e `journalctl -u corptv-agente` |
| Barra "restaurar páginas" cobrindo o vídeo | Chromium fechou de forma anormal | O script já limpa isso no boot; se persistir, reiniciar a Pi |
| Tela volta sozinha de tempos em tempos | Chromium sem memória (a Pi 4 aqui tem 2 GB) | `journalctl -t corptv-quiosque` mostra de quanto em quanto tempo; se for frequente, investigar |

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
