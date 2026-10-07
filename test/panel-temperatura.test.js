'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const trecho = painel.slice(painel.indexOf('function linhaDeTv(d,ti){'), painel.indexOf('async function renderDevices(){'));
const linha = vm.runInNewContext(trecho + '\nlinhaDeTv', {
  deviceOnline: () => true, screens: [], lastSeenText: () => '',
  situacaoDaTv: () => 'conteúdo guardado', nomeDaTv: d => d.name, esc: String
});
const aparelho = { id: 'teste', name: 'Raspberry de teste', screen_id: 'tela-teste' };
const aviso = 'esquentando: precisa de ventilação';

test('temperatura e aviso aparecem na mesma linha somente para o TI', () => {
  const d = { ...aparelho, situacao: { estado: 'pronto', temperatura_c: 62, limitada: true } };
  assert.ok(linha(d, true).includes('<div class="card-sub">Ligada · conteúdo guardado · 62 °C · ' + aviso + '</div>'));
  assert.ok(!linha(d, false).includes('°C'));
  assert.ok(!linha(d, false).includes(aviso));
});

test('aviso respeita o limite de 75 graus e a flag de limitação', () => {
  for (const [temperatura_c, limitada, esperado] of [[62, false, false], [75, false, false], [76, false, true], [62, true, true]]) {
    const d = { ...aparelho, situacao: { temperatura_c, limitada } };
    assert.equal(linha(d, true).includes(aviso), esperado);
    assert.ok(linha(d, true).includes(temperatura_c + ' °C'));
    assert.ok(!linha(d, false).includes(aviso));
    assert.ok(!linha(d, false).includes('°C'));
  }
});

test('aparelhos sem medição continuam na lista sem temperatura ou aviso', () => {
  for (const situacao of [null, {}, { estado: 'pronto' }]) {
    const html = linha({ ...aparelho, situacao }, true);
    assert.ok(html.includes(aparelho.name));
    assert.ok(!html.includes('°C'));
    assert.ok(!html.includes(aviso));
  }
});
