#!/bin/bash
# CorporTV - prepara uma Raspberry Pi para exibir uma tela.
#
# Não precisa guardar este arquivo nem lembrar que ele existe: o painel mostra,
# em cada tela (Telas → "Preparar uma Raspberry"), o comando pronto, e o
# servidor entrega o script na mesma versão dele. Numa Pi nova, com rede:
#
#   curl -fsSL http://SEU-SERVIDOR/pi/preparar.sh | sudo bash -s -- <tela>
#
# Pode rodar de novo quantas vezes quiser (trocar de tela, atualizar o agente):
# cada passo confere antes de mexer. Mexe só nesta Pi — nada na rede, no
# roteador ou no servidor.
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
[[ "$TELA" =~ ^[a-z0-9-]+$ ]] || falha "informe a tela, ex.: ... | sudo bash -s -- recepcao"

passo "Servidor e tela"
curl -fsS -m 15 -o /dev/null "$SERVIDOR/health" || falha "servidor $SERVIDOR não respondeu"
curl -fsS -m 15 -o /dev/null "$SERVIDOR/api/player/$TELA" || falha "a tela '$TELA' não existe no painel"
ok "$SERVIDOR, tela $TELA"

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

# Configuração do aparelho: troca servidor e tela, mantém qualquer outro ajuste.
env=/etc/corptv/agente.env
{
  echo "# Configuração desta Pi. Gerado por preparar.sh; pode ajustar à mão."
  echo "CORPTV_SERVIDOR=$SERVIDOR"
  echo "CORPTV_TELA=$TELA"
  [ -f "$env" ] && grep -Ev '^(#|CORPTV_SERVIDOR=|CORPTV_TELA=)' "$env" || true
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
ok "agente no ar em http://127.0.0.1:8080 (tela $TELA)"

# ── Rede: aplicar o sufixo por último ────────────────────────────────────────
# Reaplicar a conexão pode derrubar o SSH por um instante. Por isso fica no fim,
# quando todo o resto já terminou.
if [ "$mudou_rede" -eq 1 ]; then
  passo "Aplicando o sufixo (a conexão pode piscar)"
  nmcli -t -f DEVICE,STATE device status | awk -F: '$2=="connected"{print $1}' \
    | while read -r dev; do nmcli device reapply "$dev" >/dev/null 2>&1 || true; done
fi

printf '\nPronto. Esta Pi exibe a tela "%s".\n' "$TELA"
printf 'Conferir: curl -s localhost:8080/status   e   journalctl -u corptv-agente -f\n'
}

main "$@"
