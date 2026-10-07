'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const limparTemporario = require('./limpar-temporario');

const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
const trecho = (inicio, fim) => codigo.slice(codigo.indexOf(inicio), codigo.indexOf(fim, codigo.indexOf(inicio)));

function preparar(t, playlistLocal = null) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-limpeza-'));
  t.after(() => limparTemporario(pasta));
  const arqEstado = path.join(pasta, 'estado.json');
  let gravacoes = 0;
  const contexto = vm.createContext({
    fs: { ...fs, writeFileSync: (...args) => {
      if (args[0] === arqEstado) gravacoes++;
      return fs.writeFileSync(...args);
    } },
    path, URL, CONFIG: { pasta, servidor: 'http://tv.exemplo.test' }, arqEstado, playlistLocal, log: () => {}
  });
  vm.runInContext(
    trecho('function lerEstado()', '// ── HTTP') +
    trecho('function nomeLocal(', 'async function sincronizar(') +
    trecho('function removerMidias(', '// ── HEARTBEAT') +
    codigo.match(/^const TIPOS = .*;$/m)[0], contexto);
  return { pasta, arqEstado, contexto, gravacoes: () => gravacoes };
}

for (const limpeza of ['limparAntigos', 'liberarEspaco']) {
  test(`${limpeza} remove do estado mídia ausente e mantém a mídia da programação`, t => {
    const { pasta, arqEstado, contexto, gravacoes } = preparar(t);
    const atual = { etag: '"atual"', tamanho: 5, em: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(arqEstado, JSON.stringify({ 'antiga.mp4': atual, 'atual.mp4': atual }));
    fs.writeFileSync(path.join(pasta, 'atual.mp4'), 'video');

    contexto[limpeza]([{ url: '/uploads/atual.mp4' }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(arqEstado, 'utf8')), { 'atual.mp4': atual });
    assert.equal(fs.readFileSync(path.join(pasta, 'atual.mp4'), 'utf8'), 'video');
    assert.equal(gravacoes(), 1);
    contexto[limpeza]([{ url: '/uploads/atual.mp4' }]);
    assert.equal(gravacoes(), 1, 'estado sem mudança não deve ser gravado novamente');
  });
}

test('liberarEspaco preserva também a entrada da programação ainda em exibição', t => {
  const { pasta, arqEstado, contexto, gravacoes } = preparar(t, { slides: [{ url: '/midia/em-exibicao.mp4' }] });
  const estado = { 'em-exibicao.mp4': { etag: '"anterior"', tamanho: 5 } };
  fs.writeFileSync(arqEstado, JSON.stringify(estado));
  fs.writeFileSync(path.join(pasta, 'em-exibicao.mp4'), 'video');

  contexto.liberarEspaco([{ url: '/uploads/nova.mp4' }]);

  assert.deepEqual(JSON.parse(fs.readFileSync(arqEstado, 'utf8')), estado);
  assert.ok(fs.existsSync(path.join(pasta, 'em-exibicao.mp4')));
  assert.equal(gravacoes(), 0);
});

test('apagar um arquivo sem entrada no estado não regrava o estado', t => {
  const { pasta, arqEstado, contexto, gravacoes } = preparar(t);
  fs.writeFileSync(arqEstado, '{}');
  fs.writeFileSync(path.join(pasta, 'antiga.mp4'), 'video');

  contexto.limparAntigos([]);

  assert.ok(!fs.existsSync(path.join(pasta, 'antiga.mp4')));
  assert.equal(fs.readFileSync(arqEstado, 'utf8'), '{}');
  assert.equal(gravacoes(), 0);
});
