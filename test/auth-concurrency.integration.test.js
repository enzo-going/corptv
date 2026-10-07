'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-perfis-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');

test('alterações simultâneas de perfil mantêm pelo menos um administrador ativo', async t => {
  await db.ready;
  const senha = await hashPassword('abcde');
  await db.users.insert(['admin-a', 'admin-b'].map(id => ({ id, username: id, name: 'Administrador de teste', role: 'admin', active: true, password_hash: senha })));
  const servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => servidor.close(resolve)); db.stopMaintenance();
    limparTemporario(pasta);
  });
  const base = `http://localhost:${servidor.address().port}`;
  const contas = [];
  for (const username of ['admin-a', 'admin-b']) {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'abcde' })
    });
    assert.equal(r.status, 200);
    contas.push({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf_token });
  }
  const contar = db.users.count;
  db.users.count = async query => {
    const quantidade = await contar.call(db.users, query);
    if (query.role === 'admin') await new Promise(resolve => setTimeout(resolve, 30));
    return quantidade;
  };
  try {
    const respostas = await Promise.all(contas.map((conta, i) => fetch(base + '/api/users/' + (i === 0 ? 'admin-b' : 'admin-a'), {
      method: 'PUT', headers: { cookie: conta.cookie, 'x-csrf-token': conta.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ active: false })
    })));
    assert.equal(respostas.filter(r => r.status === 200).length, 1);
    assert.ok(respostas.some(r => r.status === 400 || r.status === 401));
    for (const r of respostas) await r.json();
    assert.equal(await db.users.count({ role: 'admin', active: true }), 1);
  } finally { db.users.count = contar; }
});
