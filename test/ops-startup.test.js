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
