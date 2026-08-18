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
  assert.match(activeScript, /video\.volume = 1;/);
  assert.match(activeScript, /playWithSound\(video\)/);
  assert.match(activeScript, /Som bloqueado pelo navegador/);
  assert.doesNotMatch(activeScript, /video\.volume = 0/);
});
