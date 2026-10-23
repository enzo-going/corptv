'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const trecho = (inicio, fim) => {
  const de = html.indexOf(inicio);
  assert.notEqual(de, -1, 'trecho não encontrado: ' + inicio);
  return html.slice(de, html.indexOf(fim, de));
};

// Medido em 23/10: com o painel aberto, as miniaturas de vídeo eram recriadas a cada
// redesenho de 30 s e o navegador baixava uns 2 MB por minuto do servidor.
test('o redesenho só troca a lista quando ela mudou', () => {
  const contexto = vm.createContext({});
  vm.runInContext(trecho('function trocarHtml(el,html){', '// Vídeo pesado é otimizado'), contexto);
  let trocas = 0, atual = '';
  const el = { set innerHTML(v) { trocas++; atual = v; }, get innerHTML() { return atual; } };
  contexto.trocarHtml(el, '<div>A</div>');
  contexto.trocarHtml(el, '<div>A</div>');
  assert.equal(trocas, 1, 'a mesma lista não é recriada');
  contexto.trocarHtml(el, '<div>B</div>');
  assert.equal(trocas, 2);
  // Esvaziar e voltar à lista anterior redesenha de novo: não fica preso no "vazio".
  contexto.trocarHtml(el, 'vazio');
  contexto.trocarHtml(el, '<div>B</div>');
  assert.equal(trocas, 4);
  assert.equal(atual, '<div>B</div>');
});

test('biblioteca e ambientes só redesenham quando a lista muda', () => {
  const slides = trecho('function renderSlides(){', 'function trocarHtml(');
  assert.match(slides, /trocarHtml\(el,slides\.map\(/);
  assert.doesNotMatch(slides, /el\.innerHTML=/);
  const grupos = trecho('async function renderGroups(){', 'async function delGroup(');
  assert.match(grupos, /trocarHtml\(el,groups\.map\(/);
  assert.doesNotMatch(grupos, /el\.innerHTML=/);
  // Com a lista estável, um "adicionar" recusado não pode ficar mostrando o conteúdo escolhido.
  assert.match(trecho('async function addToGroup(', 'async function removeFromGroup('), /toast\(r\.error\);select\.value='';return;/);
});
