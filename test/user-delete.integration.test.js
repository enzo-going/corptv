'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-excluir-usuario-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');
let servidor;
let base;
let senha;

async function enviar(route, { method = 'GET', auth, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers.cookie = auth.cookie;
    if (auth.csrf) headers['x-csrf-token'] = auth.csrf;
  }
  const r = await fetch(base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  return { status: r.status, data: await r.json(), headers: r.headers };
}

async function login(username) {
  const r = await enviar('/api/auth/login', { method: 'POST', body: { username, password: 'abcde' } });
  assert.equal(r.status, 200);
  return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf_token };
}

function excluir(id, auth) {
  return enviar('/api/users/' + id, { method: 'DELETE', auth });
}

test.before(async () => {
  await db.ready;
  senha = await hashPassword('abcde');
  servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;
});

test.beforeEach(async () => {
  await db.sessions.remove({}, { multi: true });
  await db.users.remove({}, { multi: true });
  await db.users.insert(['admin', 'editor', 'viewer'].map(role => ({
    id: role, username: role, name: 'Conta de teste', role, active: true, password_hash: senha
  })));
});

test.after(async () => {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance();
  limparTemporario(pasta);
});

test('admin exclui editor, apaga todas as sessões e preserva a auditoria antiga', async () => {
  const admin = await login('admin');
  const sessoes = [await login('editor'), await login('editor')];
  const historico = await db.audit.find({ 'actor.username': 'editor' }).sort({ seq: 1 });
  assert.ok(historico.length >= 2);
  assert.equal(await db.sessions.count({ user_id: 'editor' }), 2);
  const r = await excluir('editor', admin);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal(await db.users.findOne({ id: 'editor' }), null);
  assert.equal(await db.sessions.count({ user_id: 'editor' }), 0);
  for (const auth of sessoes) assert.equal((await enviar('/api/auth/me', { auth })).status, 401);
  assert.deepEqual(await db.audit.find({ 'actor.username': 'editor' }).sort({ seq: 1 }), historico);
  const evento = await db.audit.findOne({ action: 'user.delete', entity_id: 'editor' });
  assert.equal(evento.details.username, 'editor');
  assert.equal(evento.details.sessions, 2);
  assert.equal(evento.actor.username, 'admin');
  assert.equal(evento.entity_type, 'user');
  assert.equal((await enviar('/api/audit', { auth: admin })).data.integrity.ok, true);
  assert.equal((await enviar('/api/auth/login', {
    method: 'POST', body: { username: 'editor', password: 'abcde' }
  })).status, 401);
});

test('admin não exclui a própria conta mesmo com outro administrador ativo', async () => {
  await db.users.insert({ id: 'outro-admin', username: 'outro-admin', name: 'Conta de teste', role: 'admin', active: true, password_hash: senha });
  const r = await excluir('admin', await login('admin'));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /própria conta/);
  assert.equal(await db.users.count({ role: 'admin', active: true }), 2);
});

test('exclusão exige login, perfil admin e CSRF válido', async () => {
  assert.equal((await excluir('editor')).status, 401);
  for (const role of ['editor', 'viewer']) {
    assert.equal((await excluir('admin', await login(role))).status, 403);
  }
  const admin = await login('admin');
  assert.equal((await excluir('editor', { ...admin, csrf: '' })).status, 403);
  assert.equal((await excluir('editor', { ...admin, csrf: 'invalido' })).status, 403);
  assert.ok(await db.users.findOne({ id: 'editor' }));
});

test('exclusão retorna 404 para usuário inexistente e permite remover conta inativa', async () => {
  const admin = await login('admin');
  assert.equal((await excluir('ausente', admin)).status, 404);
  await db.users.update({ id: 'viewer' }, { $set: { role: 'admin', active: false } });
  assert.equal((await excluir('viewer', admin)).status, 200);
  assert.equal(await db.users.count({ role: 'admin', active: { $ne: false } }), 1);
});

// Ambas as requisições passam pela autorização antes da primeira alteração.
// A segunda precisa conferir o último administrador dentro da fila compartilhada.
for (const method of ['DELETE', 'PUT']) {
  test('exclusão concorrente com ' + method + ' preserva o último administrador ativo', async () => {
    await db.users.insert({ id: 'outro-admin', username: 'outro-admin', name: 'Conta de teste', role: 'admin', password_hash: senha });
    const contas = [await login('admin'), await login('outro-admin')];
    const contar = db.users.count;
    let liberar;
    const autorizado = new Promise(resolve => { liberar = resolve; });
    const buscarSessao = db.sessions.findOne;
    let consultas = 0;
    db.sessions.findOne = async function(query) {
      const sessao = await buscarSessao.call(this, query);
      if (++consultas === 2) liberar();
      return sessao;
    };
    db.users.count = async function(query) {
      const quantidade = await contar.call(this, query);
      if (query.role === 'admin') {
        await autorizado;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return quantidade;
    };
    try {
      const respostas = await Promise.all([
        excluir('outro-admin', contas[0]),
        enviar('/api/users/admin', { method, auth: contas[1], body: method === 'PUT' ? { active: false } : undefined })
      ]);
      assert.deepEqual(respostas.map(r => r.status).sort(), [200, 400]);
      assert.match(respostas.find(r => r.status === 400).data.error, /ao menos um administrador ativo/);
      assert.equal(await contar.call(db.users, { role: 'admin', active: { $ne: false } }), 1);
    } finally {
      db.users.count = contar;
      db.sessions.findOne = buscarSessao;
    }
  });
}
