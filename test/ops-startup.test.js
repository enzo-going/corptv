'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootStarter = fs.readFileSync(path.join(__dirname, '../iniciar.bat'), 'utf8');
const opsStarter = fs.readFileSync(path.join(__dirname, '../ops/start-corptv.cmd'), 'utf8');

test('os iniciadores deixam o watchdog como único mecanismo de reinício', () => {
  for (const starter of [rootStarter, opsStarter]) {
    assert.match(starter, /node\.exe" src\\server\.js/);
    assert.doesNotMatch(starter, /^:loop\s*$/im);
    assert.doesNotMatch(starter, /goto\s+loop/i);
    assert.doesNotMatch(starter, /timeout\s+\/t/i);
  }
  assert.match(rootStarter, /CorporTV Watchdog/);
});

test('os iniciadores criam a pasta de log antes de redirecionar para ela', () => {
  // No cmd, um ">>" para pasta inexistente aborta a linha inteira: o Node nem
  // roda. Foi o que aconteceria no servidor ao trocar a pasta de log antiga
  // pela nova, que ninguém tinha criado.
  for (const starter of [rootStarter, opsStarter]) {
    const criaPasta = starter.search(/if not exist "C:\\ProgramData\\CorporTVLogs" mkdir "C:\\ProgramData\\CorporTVLogs"/);
    const redireciona = starter.search(/>> "C:\\ProgramData\\CorporTVLogs\\corptv\.log"/);
    assert.ok(criaPasta >= 0, 'o iniciador não cria a pasta de log');
    assert.ok(redireciona > criaPasta, 'a pasta precisa ser criada antes do redirecionamento');
  }
});
