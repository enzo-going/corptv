'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('limpeza repete a remoção e apenas avisa se o arquivo continuar bloqueado', () => {
  const codigo = fs.readFileSync(path.join(__dirname, 'limpar-temporario.js'), 'utf8');
  const chamadas = [];
  const avisos = [];
  let bloqueado = true;
  const contexto = {
    module: { exports: {} }, console: { warn: (...args) => avisos.push(args) },
    require: nome => {
      assert.equal(nome, 'node:fs');
      return { rmSync: (pasta, opcoes) => {
        chamadas.push({ pasta, ...opcoes });
        if (bloqueado) throw Object.assign(new Error('arquivo ocupado'), { code: 'EPERM' });
      } };
    }
  };
  vm.runInNewContext(codigo, contexto);
  assert.doesNotThrow(() => contexto.module.exports('temporario'));
  assert.deepEqual(chamadas, [{ pasta: 'temporario', recursive: true, force: true, maxRetries: 10, retryDelay: 200 }]);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0][1], 'EPERM');
  bloqueado = false;
  contexto.module.exports('temporario');
  assert.equal(chamadas.length, 2);
  assert.equal(avisos.length, 1, 'remoção bem-sucedida não avisa');
});
