'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const limparTemporario = require('./limpar-temporario');

const preparo = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');
const inicio = preparo.indexOf('# ── 6. Watchdog de hardware');
const fim = preparo.indexOf('# ── Rede: aplicar o sufixo por último');
const passo = preparo.slice(inicio, fim);
const esperado = '[Manager]\n# Reinicia a Pi se o sistema travar e deixar de alimentar o watchdog.\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n';

test('o preparo configura o watchdog antes de reaplicar a rede', () => {
  assert.ok(inicio >= 0 && fim > inicio);
  assert.ok(passo.includes('[ -e /dev/watchdog ]'));
  assert.ok(passo.includes('conf=/etc/systemd/system.conf.d/90-corptv-watchdog.conf'));
});

test('o watchdog só grava e chama daemon-reexec quando o conteúdo muda', t => {
  if (spawnSync('bash', ['-c', 'exit 0']).status !== 0) {
    t.skip('sem bash neste sistema');
    return;
  }
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-watchdog-'));
  t.after(() => limparTemporario(pasta));
  const conf = path.join(pasta, 'system.conf.d/90-corptv-watchdog.conf');
  const chamadas = path.join(pasta, 'chamadas');
  // Executa só o passo novo, com caminhos temporários e systemctl simulado.
  const isolado = passo.replaceAll('/dev/watchdog', './watchdog')
    .replaceAll('/etc/systemd/system.conf.d', './system.conf.d');
  const auxiliares = preparo.match(/^passo\(\).*$/m)[0] + '\n' + preparo.match(/^ok\(\).*$/m)[0];
  const rodar = () => {
    const resultado = spawnSync('bash', ['-s'], {
      cwd: pasta, encoding: 'utf8',
      input: `set -euo pipefail\n${auxiliares}\nsystemctl() { printf '%s\\n' "$*" >> ./chamadas; }\n${isolado}`
    });
    assert.equal(resultado.status, 0, resultado.stderr);
    return resultado.stdout;
  };

  assert.match(rodar(), /ok: sem watchdog de hardware; pulando/);
  assert.ok(!fs.existsSync(path.dirname(conf)));
  assert.ok(!fs.existsSync(chamadas));

  fs.writeFileSync(path.join(pasta, 'watchdog'), '');
  rodar();
  assert.equal(fs.readFileSync(conf, 'utf8'), esperado);
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'daemon-reexec\n');

  const data = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(conf, data, data);
  const modificadoEm = fs.statSync(conf).mtimeMs;
  assert.match(rodar(), /ok: já estava/);
  assert.equal(fs.statSync(conf).mtimeMs, modificadoEm, 'não deve regravar conteúdo igual');
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'daemon-reexec\n');

  fs.writeFileSync(conf, '[Manager]\nRuntimeWatchdogSec=30\n');
  rodar();
  assert.equal(fs.readFileSync(conf, 'utf8'), esperado);
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'daemon-reexec\ndaemon-reexec\n');
});
