'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Biblioteca oferece Baixar para mídias fora dos controles restritos a edição', () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  const render = painel.slice(painel.indexOf('function renderSlides(){'), painel.indexOf('// Vídeo pesado é otimizado'));
  const lista = {};
  vm.runInNewContext(render + ';renderSlides();', {
    slides: ['vid', 'img', 'txt'].map(type => ({ id: type, type })),
    document: { getElementById: () => lista }, esc: String, nomeDe: s => s.id,
    videoTextLabel: () => '', tempoDe: () => '', thumbDe: () => '', preparoDe: () => ''
  });
  for (const type of ['vid', 'img']) {
    assert.ok(lista.innerHTML.includes('href="/api/slides/' + type + '/arquivo">Baixar</a>'));
  }
  assert.ok(!lista.innerHTML.includes('/api/slides/txt/arquivo'));
  assert.equal((lista.innerHTML.match(/>Baixar<\/a>/g) || []).length, 2);
  assert.match(lista.innerHTML, /<div class="item-actions">\s*<a class="btn btn-ghost btn-sm"/);
  assert.match(lista.innerHTML, /<div class="item-actions editor-only">\s*<button/);
});
