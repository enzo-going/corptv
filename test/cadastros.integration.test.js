'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-cadastros-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
const db = require('../src/db');
const { app } = require('../src/server');
let servidor, base, cookie, csrf;

async function post(rota, corpo) {
  return fetch(base + rota, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify(corpo)
  });
}

test.before(async () => {
  await db.ready;
  servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;
  const setup = await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin-teste', name: 'Administrador de teste', password: 'abcde' })
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  csrf = (await setup.json()).csrf_token;
  await db.groups.insert({ id: 'grupo-teste', name: 'Ambiente de teste' });
  await db.slides.insert({ id: 'slide-teste', title: 'Texto de teste', type: 'txt' });
});
test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance();
  limparTemporario(pasta);
});

test('telas com o mesmo nome cadastradas juntas recebem endereços diferentes', async () => {
  const respostas = await Promise.all(Array.from({ length: 6 }, () => post('/api/screens', { name: 'TV teste', group_id: 'grupo-teste' })));
  const ids = [];
  for (const r of respostas) { assert.equal(r.status, 200); ids.push((await r.json()).id); }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(await db.screens.count({}), ids.length);
});

test('registros simultâneos do mesmo aparelho não duplicam o cadastro', async () => {
  const id = randomUUID();
  const buscar = db.devices.findOne;
  db.devices.findOne = async query => {
    const item = await buscar.call(db.devices, query);
    await new Promise(resolve => setTimeout(resolve, 30));
    return item;
  };
  try {
    const respostas = await Promise.all(Array.from({ length: 6 }, () => post('/api/aparelhos/registro', { id, nome: 'aparelho-teste' })));
    for (const r of respostas) { assert.equal(r.status, 200); await r.json(); }
    assert.equal(await db.devices.count({ id }), 1);
  } finally { db.devices.findOne = buscar; }
});

test('publicações simultâneas do mesmo conteúdo não duplicam o vínculo', async () => {
  const buscar = db.gslides.findOne;
  db.gslides.findOne = async query => {
    const item = await buscar.call(db.gslides, query);
    await new Promise(resolve => setTimeout(resolve, 30));
    return item;
  };
  try {
    const respostas = await Promise.all(Array.from({ length: 6 }, () => post('/api/groups/grupo-teste/slides', { slide_id: 'slide-teste' })));
    assert.equal(respostas.filter(r => r.status === 200).length, 1);
    assert.equal(respostas.filter(r => r.status === 400).length, 5);
    for (const r of respostas) await r.json();
    assert.equal(await db.gslides.count({ group_id: 'grupo-teste', slide_id: 'slide-teste' }), 1);
  } finally { db.gslides.findOne = buscar; }
});

test('identificador de conteúdo como objeto não vira consulta no banco', async () => {
  await db.groups.insert({ id: 'grupo-injecao', name: 'Ambiente de teste' });
  const r = await post('/api/groups/grupo-injecao/slides', { slide_id: { $ne: null } });
  assert.equal(r.status, 400);
  await r.json();
  assert.equal(await db.gslides.count({ group_id: 'grupo-injecao' }), 0);
});

test('falha de gravação não prende os próximos cadastros na fila', async () => {
  const inserir = db.screens.insert;
  db.screens.insert = async () => { throw new Error('falha de gravação simulada'); };
  try {
    const erro = await post('/api/screens', { name: 'TV nova', group_id: 'grupo-teste' });
    assert.equal(erro.status, 500);
    await erro.json();
  } finally { db.screens.insert = inserir; }
  const sucesso = await post('/api/screens', { name: 'TV nova', group_id: 'grupo-teste' });
  assert.equal(sucesso.status, 200);
  assert.equal((await sucesso.json()).id, 'tv-nova');
});
