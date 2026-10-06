'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('o cache do navegador recebe só o prazo restante sem alterar o prazo salvo no agente', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8').replace(/\r\n/g, '\n');
  const inicio = codigo.indexOf('function programacaoValida(');
  const funcao = codigo.slice(inicio, codigo.indexOf('\n}\n', inicio) + 3);
  let agora = 1500;
  const validar = vm.runInNewContext(`${funcao}\nprogramacaoValida`, { Date: { now: () => agora } });
  const playlist = { salvo_em: 1000, slides: [{ id: 'com-prazo', cache_for_ms: 1000 }, { id: 'sem-prazo', cache_for_ms: null }] };
  assert.equal(validar(playlist).slides[0].cache_for_ms, 500);
  agora = 1800;
  assert.equal(validar(playlist).slides[0].cache_for_ms, 200);
  assert.equal(playlist.slides[0].cache_for_ms, 1000, 'consultas locais não podem regravar o prazo');
  agora = 2000;
  assert.equal(validar(playlist).slides.length, 1);
  assert.equal(validar(playlist).slides[0].id, 'sem-prazo');
});
