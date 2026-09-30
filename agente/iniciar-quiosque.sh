#!/bin/bash
# Abre o Chromium em tela cheia apontando para o agente local (127.0.0.1).
#
# Importante: o endereço é LOCAL. O navegador nunca fala com o servidor para
# buscar vídeo — quem faz isso é o agente, devagar e uma vez só.
#
# Instalar no autostart do Raspberry Pi (sessão gráfica):
#   mkdir -p ~/.config/autostart
#   cp corptv-quiosque.desktop ~/.config/autostart/
#
# 127.0.0.1 conta como "origem segura" para o navegador, então autoplay e
# demais recursos funcionam sem HTTPS.
#
# O navegador fica dentro de um laço: se fechar sozinho, abre de novo. Sem isso
# a TV ficava preta até alguém ir até lá reiniciar o aparelho. Acompanhar com:
#   journalctl -t corptv-quiosque

PORTA="${CORPTV_PORTA:-8080}"
URL="http://127.0.0.1:${PORTA}/"

# Um quiosque só: a sessão gráfica pode chamar este script por mais de um caminho,
# e dois navegadores disputariam a tela e o som.
exec 9>"/tmp/corptv-quiosque-$(id -u).lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "quiosque ja aberto nesta sessao"
  exit 0
fi

# Raspberry Pi OS antigo chama o navegador de chromium-browser; o atual, de chromium.
NAVEGADOR=$(command -v chromium-browser || command -v chromium || echo chromium-browser)

# Espera o agente responder antes de abrir a tela (evita erro na inicialização).
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORTA}/status" >/dev/null 2>&1; then break; fi
  sleep 2
done

# Não deixa a tela apagar nem entrar protetor de tela. O xset só existe no X11;
# no Wayland (labwc, padrão do Raspberry Pi OS atual) quem desliga o apagamento é
# o raspi-config, que o preparar.sh já chama.
if [ -n "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && command -v xset >/dev/null 2>&1; then
  xset s off
  xset -dpms
  xset s noblank
fi

# Registra no journal do sistema, para conferir depois com:
#   journalctl -t corptv-quiosque
registrar() {
  echo "$1"
  command -v logger >/dev/null 2>&1 && logger -t corptv-quiosque "$1"
}

# Limpa flags de encerramento anormal, senão o Chromium abre com a barra
# "restaurar páginas" cobrindo o vídeo. Precisa rodar antes de CADA abertura:
# quando o navegador cai, é justamente essa flag que fica suja.
limpar_flags_de_crash() {
  PERFIL="$HOME/.config/chromium/Default/Preferences"
  if [ -f "$PERFIL" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PERFIL" 2>/dev/null
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PERFIL" 2>/dev/null
  fi
}

# Som pela HDMI e volume do sistema em 100%. Quem regula o volume é o painel
# (por tela) e o controle remoto da TV. Se o volume do sistema ficasse nos 40%
# que às vezes vêm de fábrica, o "100%" do painel sairia baixo sem ninguém
# entender por quê. E se a saída padrão fosse o fone (P2), a TV ficaria muda.
# Nunca impede o quiosque de abrir: sem som é ruim, sem imagem é pior.
configurar_audio() {
  command -v pactl >/dev/null 2>&1 || { registrar "som: pactl ausente, saida nao configurada"; return; }
  for i in $(seq 1 15); do pactl info >/dev/null 2>&1 && break; sleep 1; done
  local saida
  # HDMI0 (fef00700 na Pi 4) é a porta mais perto da energia, a que o checklist manda usar.
  saida=$(pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -m1 'fef00700.*hdmi')
  [ -z "$saida" ] && saida=$(pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -m1 -i 'hdmi')
  if [ -z "$saida" ]; then
    # Sem TV ligada a Pi não enxerga a HDMI e ela nem aparece na lista. A escolha
    # feita num boot com a TV ligada fica guardada e volta a valer quando ela aparece.
    registrar "som: nenhuma saida HDMI encontrada (TV desligada na hora do boot?)"
    return
  fi
  pactl set-default-sink "$saida"
  pactl set-sink-mute "$saida" 0
  pactl set-sink-volume "$saida" 100%
  registrar "som: saida $saida, volume do sistema em 100%"
}

configurar_audio

# --password-store=basic: a Pi entra sozinha, sem digitar senha, e o chaveiro do
# sistema abria a janela "escolha uma senha para o chaveiro" por cima da TV — numa
# TV sem teclado, ela ficaria ali para sempre. O quiosque não guarda senha nenhuma.
#
# Se o Chromium fechar — travou, ficou sem memória, alguém fechou sem querer —
# a TV não pode ficar preta esperando alguém ir até lá reiniciar o aparelho.
# O systemd cuida do agente (Restart=always), mas não do navegador: quem faz
# esse papel é o laço abaixo.
encerrando=0
falhas_seguidas=0

# Ctrl+C ou fim da sessão gráfica: fecha o navegador e sai do laço, em vez de
# reabrir a janela em cima de quem está desligando.
trap 'encerrando=1; kill "$navegador" 2>/dev/null' TERM INT HUP

registrar "iniciando o quiosque em $URL"

while [ "$encerrando" -eq 0 ]; do
  limpar_flags_de_crash
  inicio=$(date +%s)

  "$NAVEGADOR" \
    --ozone-platform-hint=auto \
    --kiosk \
    --password-store=basic \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    "$URL" &

  navegador=$!
  wait "$navegador"
  saida=$?

  [ "$encerrando" -eq 1 ] && break

  duracao=$(( $(date +%s) - inicio ))

  # Ficou de pé um tempo razoável? Então foi uma queda isolada: reabre já.
  # Morreu em menos de 30s? É falha de verdade (sem tela, sem o binário,
  # perfil corrompido) e reabrir sem parar só enche o log e esquenta a CPU.
  if [ "$duracao" -lt 30 ]; then
    falhas_seguidas=$(( falhas_seguidas + 1 ))
    [ "$falhas_seguidas" -gt 5 ] && falhas_seguidas=5
    espera=$(( 2 ** falhas_seguidas ))
  else
    falhas_seguidas=0
    espera=2
  fi

  registrar "chromium saiu (codigo $saida) depois de ${duracao}s; reabrindo em ${espera}s"
  sleep "$espera"
done

registrar "quiosque encerrado"
