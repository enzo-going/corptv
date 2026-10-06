'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = fs.readFileSync(path.join(__dirname, '../agente/iniciar-quiosque.sh'), 'utf8');
const registrar = script.slice(script.indexOf('registrar() {'), script.indexOf('\n}\n', script.indexOf('registrar() {')) + 3);
const inicio = script.indexOf('configurar_audio() {');
const audio = script.slice(inicio, script.indexOf('\n}\n', inicio) + 3);

function executar(t, status, opcoes = {}) {
  const resultado = spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    env: { ...process.env, AUDIO_STATUS: status },
    input: `
command() {
  if [ "$1" = -v ]; then
    case "$2" in
      pactl) return ${opcoes.pactl ? 0 : 1} ;;
      wpctl) return ${opcoes.semWpctl ? 1 : 0} ;;
    esac
  fi
  builtin command "$@"
}
sleep() { echo "espera $1"; }
logger() { echo "logger $*"; }
wpctl() {
  if [ "$1" = status ]; then
    ${opcoes.statusFalha ? 'return 1' : 'printf "%s\\n" "$AUDIO_STATUS"; return 0'}
  fi
  echo "wpctl $*"
  return ${opcoes.configFalha ? 1 : 0}
}
pactl() {
  case "$1" in
    info) return 0 ;;
    list) printf '1 alsa_output.fef00700.hdmi stereo\\n'; return 0 ;;
  esac
  echo "pactl $*"
}
${registrar}
${audio}
configurar_audio
echo "audio retornou $?"
echo "navegador abriu"
`
  });
  if (resultado.error && resultado.error.code === 'ENOENT') {
    t.skip('sem bash neste sistema');
    return null;
  }
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /audio retornou 0\nnavegador abriu/);
  return resultado.stdout;
}

const status = sinks => `PipeWire
Audio
 ├─ Devices:
 │      10. fef00700 HDMI 0
 ├─ Sinks:
${sinks}
 ├─ Sources:
 │      20. fef00700 HDMI 0
 └─ Streams:
Video
 ├─ Sinks:
 │      30. fef00700 HDMI 0
Settings
`;

test('wpctl prefere HDMI 0 entre os sinks de áudio, com estrela e árvore no status', t => {
  for (const nome of ['alsa_output.platform-fef00700.hdmi-stereo', 'Built-in Audio HDMI 0']) {
    const saida = executar(t, status(` │      41. Built-in Audio HDMI 1 [vol: 0.50]\n │  *   42. ${nome} [vol: 0.40]\n │      43. Analog Stereo`));
    if (!saida) return;
    assert.match(saida, /wpctl set-default 42\nwpctl set-mute 42 0\nwpctl set-volume 42 1\.0/);
    assert.match(saida, /logger -t corptv-quiosque som: saida 42 pelo wpctl/);
    assert.doesNotMatch(saida, /wpctl set-default (10|20|30|41|43)/);
  }
});

test('wpctl usa outra HDMI quando HDMI 0 não está disponível', t => {
  const saida = executar(t, status(' │      41. Analog Stereo\n │      44. Built-in Audio HDMI 1'));
  if (saida) assert.match(saida, /wpctl set-default 44/);
});

test('sem HDMI, sem ferramentas ou com erro, registra e segue para o navegador', t => {
  for (const [conteudo, opcoes] of [
    [status(' │      41. Analog Stereo'), {}],
    [status(' │      42. HDMI 0'), { semWpctl: true }],
    [status(' │      42. HDMI 0'), { statusFalha: true }],
    [status(' │      42. HDMI 0'), { configFalha: true }]
  ]) {
    const saida = executar(t, conteudo, opcoes);
    if (!saida) return;
    assert.match(saida, /logger -t corptv-quiosque som: (nenhuma|pactl e wpctl ausentes|nao consegui)/);
    if (!opcoes.configFalha) assert.doesNotMatch(saida, /wpctl set-default/);
    if (opcoes.statusFalha) assert.equal((saida.match(/espera 1/g) || []).length, 15);
  }
});

test('com pactl disponível mantém a configuração HDMI existente', t => {
  const saida = executar(t, '', { pactl: true });
  if (!saida) return;
  assert.match(saida, /pactl set-default-sink alsa_output\.fef00700\.hdmi/);
  assert.match(saida, /pactl set-sink-mute .* 0/);
  assert.match(saida, /pactl set-sink-volume .* 100%/);
  assert.doesNotMatch(saida, /wpctl set-/);
});
