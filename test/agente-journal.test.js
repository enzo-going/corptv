'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const limparTemporario = require('./limpar-temporario');

const preparo = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');
const watchdog = preparo.indexOf('# ── 6. Watchdog de hardware');
const inicio = preparo.indexOf('# ── 7. Limite do journal');
const fim = preparo.indexOf('# ── Rede: aplicar o sufixo por último');
const passo = preparo.slice(inicio, fim);
const esperado = '[Journal]\n# Limita os logs no cartão para preservar espaço para os vídeos.\nSystemMaxUse=50M\nMaxRetentionSec=1month\n';

test('o preparo limita o journal depois do watchdog e antes de reaplicar a rede', () => {
  assert.ok(watchdog >= 0 && inicio > watchdog && fim > inicio);
  assert.ok(passo.includes('conf=/etc/systemd/journald.conf.d/90-corptv-journal.conf'));
});

test('o journal só grava e reinicia quando o conteúdo muda', t => {
  if (spawnSync('bash', ['-c', 'exit 0']).status !== 0) {
    t.skip('sem bash neste sistema');
    return;
  }
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-journal-'));
  t.after(() => limparTemporario(pasta));
  const conf = path.join(pasta, 'journald.conf.d/90-corptv-journal.conf');
  const chamadas = path.join(pasta, 'chamadas');
  // Executa só o passo novo, com caminhos temporários e systemctl simulado.
  const isolado = passo.replaceAll('/etc/systemd/journald.conf.d', './journald.conf.d');
  const auxiliares = preparo.match(/^passo\(\).*$/m)[0] + '\n' + preparo.match(/^ok\(\).*$/m)[0];
  const rodar = () => {
    const resultado = spawnSync('bash', ['-s'], {
      cwd: pasta, encoding: 'utf8',
      input: `set -euo pipefail\n${auxiliares}\nsystemctl() { printf '%s\\n' "$*" >> ./chamadas; }\n${isolado}`
    });
    assert.equal(resultado.status, 0, resultado.stderr);
    return resultado.stdout;
  };

  assert.ok(!fs.existsSync(path.dirname(conf)));
  assert.match(rodar(), /ok: criado/);
  assert.equal(fs.readFileSync(conf, 'utf8'), esperado);
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'restart systemd-journald\n');

  const data = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(conf, data, data);
  const modificadoEm = fs.statSync(conf).mtimeMs;
  assert.match(rodar(), /ok: já estava/);
  assert.equal(fs.statSync(conf).mtimeMs, modificadoEm, 'não deve regravar conteúdo igual');
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'restart systemd-journald\n');

  fs.writeFileSync(conf, '[Journal]\nSystemMaxUse=200M\n');
  assert.match(rodar(), /ok: criado/);
  assert.equal(fs.readFileSync(conf, 'utf8'), esperado);
  assert.equal(fs.readFileSync(chamadas, 'utf8'), 'restart systemd-journald\nrestart systemd-journald\n');
});
