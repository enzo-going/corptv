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

test('formulários preservam campos e modais com erro HTTP, JSON inesperado ou falha de rede', async () => {
  for (const resposta of [
    async () => ({ status: 400, json: async () => ({ error: 'Dados recusados' }) }),
    async () => ({ status: 500, json: async () => ({}) }),
    async () => ({ status: 503, json: async () => { throw new Error('HTML'); } }),
    async () => ({ status: 500, json: async () => null }),
    async () => { throw new Error('rede indisponível'); }
  ]) {
    const { contexto, mensagens } = carregarApi(resposta);
    const valores = {
      'gr-name': 'Ambiente de teste', 'gr-color': '#123456',
      'sc-name': 'TV teste', 'sc-group': 'grupo-teste',
      'us-name': 'Conta de teste', 'us-username': 'conta-teste', 'us-role': 'editor', 'us-password': 'abcde',
      'pw-current': 'abcde', 'pw-new': 'fghij', 'video-text-mode': 'timed', 'video-text-seconds': '15'
    };
    const campos = Object.fromEntries(Object.entries(valores).map(([id, value]) => [id, { value }]));
    campos['slug-preview'] = { style: { display: 'block' } };
    let recargas = 0, fechamentos = 0;
    Object.assign(contexto, {
      document: { getElementById: id => campos[id] },
      load: async () => recargas++, loadUsers: async () => recargas++,
      schedGrupo: 'grupo-teste', schedEditId: 'slide-teste', videoTextEditId: 'video-teste',
      schedForm: () => ({ starts_at: '2028-02-29', time_start: '09:00', time_end: '10:00' }),
      schedProblema: () => null, closeSched: () => fechamentos++, closeVideoText: () => fechamentos++
    });
    vm.runInContext(
      trecho('async function addGroup()', 'async function renderGroups()') +
      trecho('async function addScreen()', 'async function renderScreens()') +
      trecho('async function saveSched()', 'function clearSched()') +
      trecho('async function saveVideoText()', '// Conteudo enviado') +
      trecho('async function changeOwnPassword()', 'async function loadUsers()'), contexto);
    await contexto.addGroup(); await contexto.addScreen(); await contexto.saveSched();
    await contexto.saveVideoText(); await contexto.addUser(); await contexto.changeOwnPassword();
    for (const [id, value] of Object.entries(valores)) assert.equal(campos[id].value, value, id);
    assert.equal(campos['slug-preview'].style.display, 'block');
    assert.equal(fechamentos, 0);
    assert.equal(recargas, 0);
    assert.ok(mensagens.length >= 6);
    assert.ok(mensagens.every(m => !/criad|adicionad|atualizad|Salvo|Senha alterada/.test(m)));
    assert.equal(contexto.csrfToken, 'teste');
  }
});

test('cadastros bem-sucedidos continuam limpando campos e recarregando as listas', async () => {
  const campos = {
    'gr-name': { value: 'Ambiente de teste' }, 'gr-color': { value: '#123456' },
    'sc-name': { value: 'TV teste' }, 'sc-group': { value: 'grupo-teste' },
    'slug-preview': { style: { display: 'block' } }
  };
  const mensagens = [];
  let recargas = 0;
  const contexto = vm.createContext({
    document: { getElementById: id => campos[id] }, api: async () => ({ id: 'novo' }),
    load: async () => recargas++, toast: msg => mensagens.push(msg)
  });
  vm.runInContext(trecho('async function addGroup()', 'async function addToGroup(') +
    trecho('async function addScreen()', 'async function renderScreens()'), contexto);
  await contexto.addGroup(); await contexto.addScreen();
  assert.equal(campos['gr-name'].value, '');
  assert.equal(campos['sc-name'].value, '');
  assert.equal(campos['slug-preview'].style.display, 'none');
  assert.equal(recargas, 2);
  assert.deepEqual(mensagens, ['Ambiente criado', 'Tela adicionada!']);
});

test('recarga mantém a consulta de aparelhos para perfis de edição e leitura', async () => {
  for (const role of ['editor', 'viewer']) {
    const consultas = [];
    const aparelhos = [{ id: 'aparelho-teste' }];
    const contexto = vm.createContext({
      permissions: { users: false, edit: role === 'editor' }, slides: [], groups: [], screens: [], devices: [],
      api: async (_method, url) => { consultas.push(url); return url === '/api/aparelhos' ? aparelhos : []; },
      toast: () => {}, renderSlides: () => {}, renderGroups: () => {}, renderScreens: () => {},
      renderDevices: () => {}, renderDash: () => {}, acompanharPreparo: () => {}
    });
    vm.runInContext(trecho('async function load()', '// slug preview'), contexto);
    await contexto.load();
    assert.ok(consultas.includes('/api/aparelhos'));
    assert.equal(contexto.devices, aparelhos);
  }
});
