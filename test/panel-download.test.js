'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Decisão da coordenação: o vídeo publicado no CorporTV não sai para o computador de
// ninguém pelo painel. A biblioteca não oferece mais "Baixar".
test('Biblioteca não oferece Baixar para nenhum tipo de conteúdo', () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  const render = painel.slice(painel.indexOf('function renderSlides(){'), painel.indexOf('// Vídeo pesado é otimizado'));
  const lista = {};
  vm.runInNewContext(render + ';renderSlides();', {
    slides: ['vid', 'img', 'txt'].map(type => ({ id: type, type })),
    document: { getElementById: () => lista }, esc: String, nomeDe: s => s.id,
    videoTextLabel: () => '', tempoDe: () => '', thumbDe: () => '', preparoDe: () => ''
  });
  assert.doesNotMatch(lista.innerHTML, /Baixar/);
  assert.doesNotMatch(lista.innerHTML, /\/arquivo/);
  assert.doesNotMatch(painel, /\/api\/slides\/[^"'`]*\/arquivo/);
  // As ações de edição continuam só para quem edita.
  assert.match(lista.innerHTML, /<div class="item-actions editor-only">\s*<button/);
});
