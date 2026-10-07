'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const trecho = codigo.slice(codigo.indexOf('const ESTADOS_APARELHO'), codigo.indexOf("app.post('/api/aparelhos/registro'"));
const sanitizar = vm.runInNewContext(trecho + '\nsituacaoAparelho');

test('servidor aceita temperatura inteira entre 0 e 120 e limitação booleana', () => {
  for (const temperatura_c of [0, 62, 75, 76, 120]) {
    for (const limitada of [true, false]) {
      const situacao = sanitizar({ estado: 'pronto', temperatura_c, limitada, extra: 'descartar' });
      assert.equal(situacao.temperatura_c, temperatura_c);
      assert.equal(situacao.limitada, limitada);
      assert.equal(situacao.estado, 'pronto');
      assert.ok(!Object.hasOwn(situacao, 'extra'));
    }
  }
});

test('servidor descarta valores térmicos inválidos sem perder os demais campos válidos', () => {
  for (const temperatura_c of [undefined, null, '62', true, false, [], {}, -1, 121, 62.5, NaN, Infinity]) {
    const s = sanitizar({ estado: 'baixando', percentual: 50, temperatura_c, limitada: false });
    assert.ok(!Object.hasOwn(s, 'temperatura_c'));
    assert.equal(s.limitada, false);
    assert.equal(s.percentual, 50);
  }
  for (const limitada of [undefined, null, 'true', 'false', 0, 1, [], {}]) {
    const s = sanitizar({ estado: 'sem_tela', temperatura_c: 62, limitada });
    assert.ok(!Object.hasOwn(s, 'limitada'));
    assert.equal(s.temperatura_c, 62);
  }
  assert.equal(sanitizar({ temperatura_c: 62, limitada: true }), null);
});
