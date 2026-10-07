'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Decisão da coordenação: o vídeo publicado no CorporTV não sai para o computador de
// ninguém pelo painel. O endereço que entregava o arquivo como anexo ("Baixar") não
// existe mais, para nenhum perfil.
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-download-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');
const cookies = {};
let servidor;
let base;

test.before(async () => {
  await db.ready;
  const password_hash = await hashPassword('abcde');
  await db.users.insert(['admin', 'editor', 'viewer'].map(role => ({
    id: role, username: role, name: 'Conta de teste', role, active: true, password_hash
  })));
  servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;
  for (const role of ['admin', 'editor', 'viewer']) {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: role, password: 'abcde' })
    });
    assert.equal(r.status, 200);
    cookies[role] = r.headers.get('set-cookie').split(';')[0];
    await r.json();
  }
});

test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  limparTemporario(pasta);
});

test('nenhum perfil consegue baixar vídeo ou imagem como anexo', async () => {
  for (const type of ['vid', 'img']) {
    const id = randomUUID();
    const nome = id + (type === 'vid' ? '.mp4' : '.png');
    fs.mkdirSync(process.env.CORPTV_UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, nome), Buffer.alloc(64 * 1024, 42));
    await db.slides.insert({ id, type, title: 'Conteúdo', url: '/uploads/' + nome });

    for (const perfil of ['admin', 'editor', 'viewer', null]) {
      const r = await fetch(base + '/api/slides/' + id + '/arquivo', {
        headers: perfil ? { cookie: cookies[perfil] } : {}, signal: AbortSignal.timeout(5000)
      });
      await r.arrayBuffer();
      assert.notEqual(r.status, 200, `${perfil || 'sem login'} baixou ${type}`);
      assert.equal(r.headers.get('content-disposition'), null);
    }
  }
});
