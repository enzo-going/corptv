const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('o player tenta reproduzir videos com som e orienta quando o navegador bloqueia', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/player/index.html'), 'utf8');
  const activeScript = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));

  assert.doesNotThrow(() => new Function(activeScript.replace(/^<script>/, '')));
  assert.match(activeScript, /video\.muted = false;/);
  assert.match(activeScript, /video\.defaultMuted = false;/);
  assert.match(activeScript, /video\.volume = screenVolume;/);
  assert.match(activeScript, /playWithSound\(video\)/);
  assert.match(activeScript, /Som bloqueado pelo navegador/);
  assert.doesNotMatch(activeScript, /video\.volume = [01]\b/);
});

function scriptAtivo() {
  const html = fs.readFileSync(path.join(__dirname, '../public/player/index.html'), 'utf8').replace(/\r/g, '');
  return html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
}

function extrair(script, nome) {
  return script.match(new RegExp('function ' + nome + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'))[0];
}

test('o player converte o volume do painel e toca no máximo quando o servidor não manda', () => {
  const normalizeVolume = new Function(extrair(scriptAtivo(), 'normalizeVolume') + '; return normalizeVolume;')();
  assert.equal(normalizeVolume(undefined), 1);   // servidor antigo, sem o campo
  assert.equal(normalizeVolume(35), 0.35);
  assert.equal(normalizeVolume('80'), 0.8);
  assert.equal(normalizeVolume(0), 0);
  assert.equal(normalizeVolume(150), 1);
  assert.equal(normalizeVolume(-5), 0);
});

test('o player muda o volume na hora, muta na hora e só religa o som no próximo vídeo', () => {
  const fabrica = new Function('document', 'setAudioBlocked', 'volumeInicial',
    'var screenVolume = volumeInicial;\n' + extrair(scriptAtivo(), 'setScreenVolume') +
    '\nreturn { ajustar: setScreenVolume, atual: function () { return screenVolume; } };');
  const video = { muted: false, volume: 0.5 };
  const player = fabrica({ getElementById: () => video }, () => {}, 0.5);

  player.ajustar(0.8);
  assert.equal(video.volume, 0.8);
  player.ajustar(0);
  assert.equal(video.muted, true);
  // Desmutar sem gesto do usuário pode pausar o vídeo em alguns navegadores.
  player.ajustar(0.6);
  assert.equal(video.muted, true);
  assert.equal(player.atual(), 0.6);
});

test('o player lê o volume da programação, guarda no cache e toca mudo sem aviso', () => {
  const script = scriptAtivo();
  assert.match(script, /setScreenVolume\(normalizeVolume\(data\.screen && data\.screen\.volume\)\)/);
  assert.match(script, /volume: Math\.round\(screenVolume \* 100\)/);
  assert.match(script, /var screenVolume = normalizeVolume\(cacheRecord\.volume\)/);
  const tocar = extrair(script, 'playWithSound');
  assert.match(tocar, /if \(screenVolume === 0\) \{\s*\/\/[^\n]*\n\s*setAudioBlocked\(false\);\s*playMutedFallback\(video\);/);
});

test('o player suporta texto oculto, fixo ou temporário com fade', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/player/index.html'), 'utf8');
  const activeScript = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));

  assert.match(html, /#overlay\.video-text-fade, #content\.video-text-fade/);
  assert.match(activeScript, /slide\.video_text_mode \|\| 'fixed'/);
  assert.match(activeScript, /textMode !== 'none'/);
  assert.match(activeScript, /visibleSeconds \* 1000/);
  assert.match(activeScript, /classList\.add\('video-text-fade'\)/);
  assert.match(activeScript, /video_text_seconds: list\[i\]\.video_text_seconds/);
});

test('conteúdo sem tempo não liga o cronômetro: não troca e não redesenha', () => {
  const fonte = extrair(scriptAtivo(), 'startTimer');
  const montar = new Function('slides', 'current', 'setInterval', 'clearInterval', 'resetProgress', 'document',
    'var timer = null; var elapsed = 0;\n' + fonte + '\nreturn startTimer;');
  let intervalos = 0;
  let zerou = 0;
  const contar = () => { intervalos++; return 1; };
  const nada = () => {};

  montar([{ type: 'img', duration: 0 }], 0, contar, nada, () => { zerou++; }, null)();
  assert.equal(intervalos, 0, 'sem tempo não pode agendar troca');
  assert.equal(zerou, 1, 'a barra de progresso fica zerada');

  montar([{ type: 'txt', duration: '0' }], 0, contar, nada, nada, null)();
  assert.equal(intervalos, 0);

  // Com tempo, continua trocando; duração ausente segue caindo nos 8 s de sempre.
  montar([{ type: 'img', duration: 12 }], 0, contar, nada, nada, null)();
  montar([{ type: 'img' }], 0, contar, nada, nada, null)();
  assert.equal(intervalos, 2);
});
