'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const trecho = (inicio, fim) => html.slice(html.indexOf(inicio), html.indexOf(fim, html.indexOf(inicio)));

function carregarApi(fetch, timeout = setTimeout) {
  const mensagens = [];
  const contexto = vm.createContext({
    fetch, AbortController, setTimeout: timeout, clearTimeout, BASE: '', csrfToken: 'teste',
    location: {}, toast: msg => mensagens.push(msg), mensagemHttp: status => `Erro de resposta ${status}`
  });
  vm.runInContext(trecho('async function api(', 'let limiteUploadMb='), contexto);
  return { contexto, mensagens };
}

test('a API do painel apresenta falha de rede ou demora sem rejeição não tratada', async () => {
  const rede = carregarApi(async () => { throw new Error('rede indisponível'); });
  assert.match((await rede.contexto.api('POST', '/api/groups', {})).error, /Sem conexão/);
  assert.match(rede.mensagens[0], /Sem conexão/);
  const lento = carregarApi((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const erro = new Error('demora'); erro.name = 'AbortError'; reject(erro);
    });
  }), (fn, ms) => { assert.equal(ms, 15000); return setTimeout(fn, 1); });
  assert.match((await lento.contexto.api('POST', '/api/groups', {})).error, /demorou/);
});

test('erro HTTP sem JSON vira mensagem e sessão encerrada redireciona sem prender a ação', async () => {
  const falha = carregarApi(async () => ({ status: 503, json: async () => { throw new Error('HTML'); } }));
  assert.match((await falha.contexto.api('GET', '/api/screens')).error, /503/);
  assert.match(falha.mensagens[0], /503/);
  const sessao = carregarApi(async () => ({ status: 401 }));
  assert.match((await sessao.contexto.api('POST', '/api/groups', {})).error, /Sessão encerrada/);
  assert.equal(sessao.contexto.location.href, '/login?next=%2Fpainel');
});

test('cadastro e remoção recusados conservam campos e não anunciam sucesso', async () => {
  const mensagens = [];
  const campos = {
    'gr-name': { value: 'Ambiente de teste' }, 'gr-color': { value: '#123456' },
    'sc-name': { value: 'TV teste' }, 'sc-group': { value: 'grupo-teste' },
    'slug-preview': { style: { display: 'block' } }
  };
  let recargas = 0;
  const contexto = vm.createContext({
    document: { getElementById: id => campos[id] },
    api: async () => ({ error: 'Operação recusada' }),
    load: async () => recargas++, toast: msg => mensagens.push(msg)
  });
  vm.runInContext(trecho('async function addGroup()', 'async function renderGroups()') +
    trecho('async function addScreen()', 'async function renderScreens()'), contexto);
  await contexto.addGroup(); await contexto.addScreen(); await contexto.removeFromGroup('grupo-teste', 'slide-teste');
  assert.equal(campos['gr-name'].value, 'Ambiente de teste');
  assert.equal(campos['sc-name'].value, 'TV teste');
  assert.equal(recargas, 0);
  assert.deepEqual(mensagens, ['Operação recusada', 'Operação recusada', 'Operação recusada']);
});

test('resposta de erro durante recarga não substitui as listas válidas do painel', async () => {
  const anterior = [{ id: 'dado-salvo' }];
  let redesenhos = 0;
  const contexto = vm.createContext({
    slides: anterior, groups: anterior, screens: anterior, devices: anterior,
    permissions: { users: true }, api: async (_method, url) => url === '/api/groups' ? { error: 'indisponível' } : [],
    toast: () => {}, renderSlides: () => redesenhos++, renderGroups: () => redesenhos++,
    renderScreens: () => redesenhos++, renderDevices: () => redesenhos++, renderDash: () => redesenhos++, acompanharPreparo: () => {}
  });
  vm.runInContext(trecho('async function load()', '// slug preview'), contexto);
  await contexto.load();
  for (const chave of ['slides', 'groups', 'screens', 'devices']) assert.equal(contexto[chave], anterior);
  assert.equal(redesenhos, 0);
});

test('erro na programação do ambiente mantém a lista exibida e avisa', async () => {
  const el = { innerHTML: 'programação anterior' }, mensagens = [];
  const anterior = { teste: [] };
  const contexto = vm.createContext({
    groups: [{ id: 'teste' }], playlistCache: anterior,
    document: { getElementById: () => el }, api: async () => ({ error: 'indisponível' }), toast: msg => mensagens.push(msg)
  });
  vm.runInContext(trecho('async function renderGroups()', 'async function delGroup('), contexto);
  await contexto.renderGroups();
  assert.equal(el.innerHTML, 'programação anterior');
  assert.equal(contexto.playlistCache, anterior);
  assert.match(mensagens[0], /Não foi possível atualizar/);
});

test('upload com sessão encerrada, HTML ou erro ao iniciar resolve e libera o estado de envio', async () => {
  for (const caso of ['sessao', 'html', 'iniciar']) {
    class Xhr {
      constructor() { this.upload = {}; this.status = caso === 'sessao' ? 401 : 200; this.responseText = '<html>erro</html>'; }
      open() {}
      setRequestHeader() {}
      send() { if (caso === 'iniciar') throw new Error('falha de envio'); this.onload(); }
    }
    const contexto = vm.createContext({
      XMLHttpRequest: Xhr, envioAtual: null, csrfToken: 'teste', BASE: '', location: {}, mensagemHttp: () => 'Erro na conexão'
    });
    vm.runInContext(trecho('function enviarComProgresso(', 'function cancelarEnvio('), contexto);
    const result = await contexto.enviarComProgresso('/api/slides', {}, () => {});
    assert.ok(result.error);
    assert.equal(contexto.envioAtual, null);
    if (caso === 'sessao') assert.equal(contexto.location.href, '/login?next=%2Fpainel');
  }
});
