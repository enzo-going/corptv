#!/bin/bash
# CorporTV - prepara uma Raspberry Pi para exibir uma tela.
#
# Não precisa guardar este arquivo nem lembrar que ele existe: o painel mostra o
# comando em Telas → Aparelhos, e o servidor entrega o script na mesma versão
# dele. Uma vez em cada Pi nova, com rede — o comando é igual para todas:
#
#   curl -fsSL http://SEU-SERVIDOR/pi/preparar.sh | sudo bash
#
# Depois a Pi aparece sozinha no painel (Telas → Aparelhos) e a tela que ela
# exibe se escolhe ali. Opcional: "... | sudo bash -s -- <tela>" já deixa uma
# tela escolhida. Pode rodar de novo (atualizar o agente): cada passo confere
# antes de mexer. Mexe só nesta Pi — nada na rede, no roteador ou no servidor.
set -euo pipefail

# Tudo dentro de main: com "curl | bash", o bash só começa a executar depois de
# ler o script inteiro, e nenhum comando (apt, por exemplo) engole o resto dele.
main() {

SERVIDOR="${CORPTV_SERVIDOR:-__SERVIDOR__}"
TELA="${1:-}"

passo() { printf '\n== %s\n' "$1"; }
ok()    { printf '   ok: %s\n' "$1"; }
falha() { printf '\nERRO: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || falha "rode com sudo (veja o comando no painel)"
case "$SERVIDOR" in
  http://*|https://*) ;;
  *) falha "endereço do servidor desconhecido; baixe o script pelo comando do painel" ;;
esac
[[ -z "$TELA" || "$TELA" =~ ^[a-z0-9-]+$ ]] || falha "nome de tela inválido: $TELA"

passo "Servidor"
curl -fsS -m 15 -o /dev/null "$SERVIDOR/health" || falha "servidor $SERVIDOR não respondeu"
if [ -n "$TELA" ]; then
  curl -fsS -m 15 -o /dev/null "$SERVIDOR/api/player/$TELA" || falha "a tela '$TELA' não existe no painel"
  ok "$SERVIDOR, tela $TELA"
else
  ok "$SERVIDOR (a tela se escolhe no painel)"
fi

# ── 1. Nome curto (corportv/) ────────────────────────────────────────────────
# A Pi não é do domínio e a rede não entrega o sufixo; sem ele, só o nome
# completo resolve. O sufixo é o domínio do próprio endereço do servidor.
passo "Sufixo de nome nas redes desta Pi"
host="${SERVIDOR#*://}"; host="${host%%[:/]*}"
dominio=""
[[ "$host" == *.* && ! "$host" =~ ^[0-9.]+$ ]] && dominio="${host#*.}"
mudou_rede=0
if [ -z "$dominio" ]; then
  ok "servidor sem domínio no endereço; nada a fazer"
elif ! command -v nmcli >/dev/null 2>&1; then
  ok "sem NetworkManager; pulando"
else
  while IFS=: read -r uuid tipo; do
    case "$tipo" in 802-11-wireless|802-3-ethernet) ;; *) continue ;; esac
    nome=$(nmcli -g connection.id connection show "$uuid")
    atual=$(nmcli -g ipv4.dns-search connection show "$uuid")
    if [[ ",$atual," == *",$dominio,"* ]]; then
      ok "$nome já tem $dominio"
    else
      nmcli connection modify "$uuid" +ipv4.dns-search "$dominio"
      ok "$nome recebeu $dominio"
      mudou_rede=1
    fi
  done < <(nmcli -t -f UUID,TYPE connection show)
fi

# ── 2. Wi-Fi sem economia de energia ─────────────────────────────────────────
# A economia de energia do Wi-Fi da Pi atrasa e derruba conexões.
passo "Wi-Fi sem economia de energia"
conf=/etc/NetworkManager/conf.d/99-corptv-wifi.conf
esperado=$'[connection]\n# CorporTV: economia de energia do Wi-Fi desligada em todas as redes\nwifi.powersave = 2'
if [ -d /etc/NetworkManager/conf.d ]; then
  if [ "$(cat "$conf" 2>/dev/null)" != "$esperado" ]; then
    printf '%s\n' "$esperado" > "$conf"
    ok "criado $conf"
  else
    ok "já estava"
  fi
  command -v iw >/dev/null 2>&1 && iw dev wlan0 set power_save off 2>/dev/null || true
fi

# ── 2b. Wi-Fi sem janela de senha na TV ──────────────────────────────────────
# Caso real: levada para outro prédio, a Pi tentou sozinha redes cuja senha não
# estava guardada no sistema e abriu a janela "digite a senha" por cima da TV.
# Rede com senha que não está guardada deixa de ser tentada sozinha (continua
# cadastrada; a que está em uso agora nunca é mexida). Rede aberta e corporativa
# (com usuário) ficam como estão.
passo "Wi-Fi sem janela de senha na TV"
if command -v nmcli >/dev/null 2>&1; then
  ativas=$(nmcli -t -f UUID connection show --active)
  while IFS=: read -r uuid tipo; do
    [ "$tipo" = 802-11-wireless ] || continue
    nome=$(nmcli -g connection.id connection show "$uuid")
    seguranca=$(nmcli -g 802-11-wireless-security.key-mgmt connection show "$uuid" 2>/dev/null || true)
    case "$seguranca" in wpa-psk|sae) ;; *) continue ;; esac
    senha=$(nmcli -s -g 802-11-wireless-security.psk connection show "$uuid" 2>/dev/null || true)
    if [ -z "$senha" ] && ! grep -qx "$uuid" <<<"$ativas"; then
      nmcli connection modify "$uuid" connection.autoconnect no
      ok "$nome: sem senha guardada, não tenta mais sozinha"
    fi
  done < <(nmcli -t -f UUID,TYPE connection show)
  # Comando para cadastrar o Wi-Fi do local da instalação, com a senha guardada no
  # sistema e prioridade sobre as outras redes.
  cat > /usr/local/bin/corptv-wifi <<WIFI
#!/bin/bash
# Cadastra o Wi-Fi do local onde esta TV fica, com a senha guardada no sistema
# (a TV nunca pede senha na tela) e prioridade sobre as outras redes conhecidas.
# Uso, na Pi com teclado ou pelo SSH:  sudo corptv-wifi "Nome da rede"
set -euo pipefail
[ "\$(id -u)" -eq 0 ] || { echo 'Use: sudo corptv-wifi "Nome da rede"'; exit 1; }
ssid="\${1:-}"
if [ -z "\$ssid" ]; then
  echo 'Use: sudo corptv-wifi "Nome da rede"'; echo 'Redes ao alcance:'
  nmcli -f SSID,SIGNAL device wifi list 2>/dev/null | head -15; exit 1
fi
read -r -s -p "Senha do Wi-Fi \"\$ssid\": " senha; echo
[ -n "\$senha" ] || { echo 'Senha vazia; nada feito.'; exit 1; }
nmcli -t -f NAME connection show | grep -Fxq "\$ssid" && nmcli connection delete "\$ssid" >/dev/null
args=(connection add type wifi ifname wlan0 con-name "\$ssid" ssid "\$ssid"
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "\$senha" wifi-sec.psk-flags 0
  connection.autoconnect yes connection.autoconnect-priority 10)
[ -n "$dominio" ] && args+=(ipv4.dns-search "$dominio")
nmcli "\${args[@]}" >/dev/null
# As outras redes ficam de reserva, abaixo desta.
while IFS=: read -r uuid tipo; do
  [ "\$tipo" = 802-11-wireless ] || continue
  [ "\$(nmcli -g connection.id connection show "\$uuid")" = "\$ssid" ] && continue
  nmcli connection modify "\$uuid" connection.autoconnect-priority 0 || true
done < <(nmcli -t -f UUID,TYPE connection show)
echo "Rede \"\$ssid\" cadastrada e com prioridade. Ela conecta sozinha quando estiver ao alcance."
echo "Para conectar agora (se você está pelo SSH em outra rede, a conexão cai): sudo nmcli connection up \"\$ssid\""
WIFI
  chmod 755 /usr/local/bin/corptv-wifi
  ok "comando corptv-wifi instalado (cadastra o Wi-Fi do local)"
fi

# ── 3. Node.js ───────────────────────────────────────────────────────────────
passo "Node.js"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -qq </dev/null
  apt-get install -y -qq nodejs </dev/null >/dev/null
fi
versao=$(node -p 'process.versions.node.split(".")[0]')
[ "$versao" -ge 18 ] || falha "Node $versao é antigo demais (precisa de 18 ou mais)"
ok "node $(node -v)"

# ── 4. Agente ────────────────────────────────────────────────────────────────
passo "Agente"
mkdir -p /opt/corptv-agente /etc/corptv
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsS -m 60 -o "$tmp/agente.js" "$SERVIDOR/pi/agente/agente.js"
curl -fsS -m 60 -o "$tmp/corptv-agente.service" "$SERVIDOR/pi/agente/corptv-agente.service"
node --check "$tmp/agente.js" || falha "agente.js baixado veio corrompido"
install -m 644 "$tmp/agente.js" /opt/corptv-agente/agente.js
install -m 644 "$tmp/corptv-agente.service" /etc/systemd/system/corptv-agente.service

# Configuração do aparelho: grava o servidor (e a tela, se foi informada) e
# mantém qualquer outro ajuste que já estivesse ali.
env=/etc/corptv/agente.env
{
  echo "# Configuração desta Pi. Gerado por preparar.sh; pode ajustar à mão."
  echo "CORPTV_SERVIDOR=$SERVIDOR"
  if [ -n "$TELA" ]; then echo "CORPTV_TELA=$TELA"; fi
  if [ -f "$env" ]; then
    if [ -n "$TELA" ]; then grep -Ev '^(#|CORPTV_SERVIDOR=|CORPTV_TELA=)' "$env" || true
    else grep -Ev '^(#|CORPTV_SERVIDOR=)' "$env" || true; fi
  fi
} > "$tmp/agente.env"
install -m 644 "$tmp/agente.env" "$env"

systemctl daemon-reload
systemctl enable corptv-agente >/dev/null 2>&1
systemctl restart corptv-agente
for _ in $(seq 1 30); do
  curl -fsS -m 2 http://127.0.0.1:8080/status >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 http://127.0.0.1:8080/status >/dev/null 2>&1 \
  || falha "o agente não respondeu; veja: journalctl -u corptv-agente -n 30"
ok "agente no ar em http://127.0.0.1:8080"

# ── 5. Quiosque ──────────────────────────────────────────────────────────────
# Sem isto o agente fica no ar, mas nada abre o navegador: a TV só mostraria o
# conteúdo se alguém abrisse o Chromium na mão a cada vez que a Pi ligasse.
passo "Quiosque (abre a tela sozinho)"
usuario="${SUDO_USER:-}"
if [ -z "$usuario" ] || [ "$usuario" = root ]; then usuario=$(getent passwd 1000 | cut -d: -f1); fi
[ -n "$usuario" ] || falha "não achei o usuário da área de trabalho desta Pi"
casa=$(getent passwd "$usuario" | cut -d: -f6)
grupo=$(id -gn "$usuario")
curl -fsS -m 60 -o "$tmp/iniciar-quiosque.sh" "$SERVIDOR/pi/agente/iniciar-quiosque.sh"
curl -fsS -m 60 -o "$tmp/corptv-quiosque.desktop" "$SERVIDOR/pi/agente/corptv-quiosque.desktop"
bash -n "$tmp/iniciar-quiosque.sh" || falha "iniciar-quiosque.sh baixado veio corrompido"
install -m 755 "$tmp/iniciar-quiosque.sh" /opt/corptv-agente/iniciar-quiosque.sh
# O autostart da área de trabalho vale no X11 e no labwc (Wayland) do Raspberry Pi OS.
install -d -m 755 -o "$usuario" -g "$grupo" "$casa/.config" "$casa/.config/autostart"
install -m 644 -o "$usuario" -g "$grupo" "$tmp/corptv-quiosque.desktop" "$casa/.config/autostart/corptv-quiosque.desktop"
ok "abre sozinho na sessão de $usuario"
# O mesmo atalho no menu: depois de fechar a tela cheia para manutenção (Alt+F4),
# "CorporTV na TV" volta sem precisar reiniciar a Pi.
install -d -m 755 -o "$usuario" -g "$grupo" "$casa/.local" "$casa/.local/share" "$casa/.local/share/applications"
install -m 644 -o "$usuario" -g "$grupo" "$tmp/corptv-quiosque.desktop" "$casa/.local/share/applications/corptv-quiosque.desktop"
ok "atalho \"CorporTV na TV\" no menu"
# A página é em português e o Raspberry Pi OS vem em inglês: o Chromium oferecia
# traduzir a cada troca de conteúdo. A política do navegador desliga a tradução.
install -d -m 755 /etc/chromium/policies/managed
# O navegador da Pi só abre o CorporTV local. Caso real: com a TV sem tela, alguém
# abriu o painel e o player do servidor no próprio navegador da TV; ela passou a
# depender da rede e travou quando o Wi-Fi caiu. A manutenção do TI é pelo SSH.
printf '{\n  "TranslateEnabled": false,\n  "URLBlocklist": ["*"],\n  "URLAllowlist": ["127.0.0.1:8080", "localhost:8080"]\n}\n' > /etc/chromium/policies/managed/corptv.json
ok "tradução automática do navegador desligada"
# O Chromium aberto à mão na Pi (manutenção) também pedia senha do chaveiro a cada
# abertura. O Raspberry Pi OS lê as opções extras do navegador em /etc/chromium.d.
if [ -d /etc/chromium.d ]; then
  printf 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --password-store=basic"\n' > /etc/chromium.d/corptv
  ok "navegador aberto à mão também sem chaveiro"
fi
if command -v raspi-config >/dev/null 2>&1; then
  # 1 = desligar o apagamento de tela; B4 = entrar direto na área de trabalho,
  # para a TV voltar sozinha depois de uma queda de energia.
  if raspi-config nonint do_blanking 1 >/dev/null 2>&1; then ok "tela não apaga sozinha"; else ok "AVISO: não consegui desligar o apagamento de tela (raspi-config)"; fi
  if raspi-config nonint do_boot_behaviour B4 >/dev/null 2>&1; then ok "liga direto na área de trabalho"; else ok "AVISO: não consegui ligar o login automático (raspi-config)"; fi
else
  ok "AVISO: sem raspi-config; desligar o apagamento de tela e ligar o login automático à mão"
fi

# ── Rede: aplicar o sufixo por último ────────────────────────────────────────
# Reaplicar a conexão pode derrubar o SSH por um instante. Por isso fica no fim,
# quando todo o resto já terminou.
if [ "$mudou_rede" -eq 1 ]; then
  passo "Aplicando o sufixo (a conexão pode piscar)"
  nmcli -t -f DEVICE,STATE device status | awk -F: '$2=="connected"{print $1}' \
    | while read -r dev; do nmcli device reapply "$dev" >/dev/null 2>&1 || true; done
fi

if [ -n "$TELA" ]; then
  printf '\nPronto. Esta Pi (%s) exibe a tela "%s". Para trocar: painel, Telas → Aparelhos.\n' "$(hostname)" "$TELA"
else
  printf '\nPronto. Esta Pi (%s) já aparece no painel. Escolha a tela dela em Telas → Aparelhos.\n' "$(hostname)"
fi
printf 'Conferir: curl -s localhost:8080/status   e   journalctl -u corptv-agente -f\n'
printf 'A tela abre sozinha no próximo boot: sudo reboot\n'
}

main "$@"
