'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parse } = require('content-disposition');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-download-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado', CORPTV_LIMITE_MBPS: '0.001'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');
const cookies = {};
let servidor;
let base;

async function conteudo(type, title, extra = {}) {
  const id = randomUUID();
  const nome = id + (type === 'vid' ? '.mp4' : '.png');
  const bytes = Buffer.alloc(512 * 1024, 42);
  if (type !== 'txt') fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, nome), bytes);
  const slide = { id, type, title, url: type === 'txt' ? null : '/uploads/' + nome, ...extra };
  await db.slides.insert(slide);
  return { ...slide, bytes };
}

function baixar(id, perfil = 'viewer') {
  return fetch(base + '/api/slides/' + id + '/arquivo', {
    headers: perfil ? { cookie: cookies[perfil] } : {}, signal: AbortSignal.timeout(5000)
  });
}

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
  if (servidor) await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance();
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('todos os perfis baixam vídeo e imagem com título e extensão, sem a limitação das TVs', async () => {
  for (const [type, title, extension] of [['vid', 'Video institucional', '.mp4'], ['img', 'Programação', '.png']]) {
    const slide = await conteudo(type, title);
    for (const role of ['admin', 'editor', 'viewer']) {
      const r = await baixar(slide.id, role);
      assert.equal(r.status, 200);
      const disposition = parse(r.headers.get('content-disposition'));
      assert.equal(disposition.type, 'attachment');
      assert.equal(disposition.parameters.filename, title + extension);
      assert.match(r.headers.get('cache-control'), /no-store/);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), slide.bytes);
    }
  }
});

test('download saneia caracteres de caminho, controles e nomes reservados', async () => {
  for (const [title, expected] of [
    ['../Vídeo: "teste"\r\n/\\*?<>| .', 'Vídeo teste.mp4'],
    ['... ', 'Conteúdo.mp4'], ['CON', '_CON.mp4']
  ]) {
    const slide = await conteudo('vid', title);
    const r = await baixar(slide.id);
    assert.equal(r.status, 200);
    assert.equal(parse(r.headers.get('content-disposition')).parameters.filename, expected);
    await r.arrayBuffer();
  }
});

test('download exige login', async () => {
  const slide = await conteudo('img', 'Imagem');
  const r = await baixar(slide.id, null);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('content-disposition'), null);
  await r.json();
});

test('download retorna 404 para texto, conteúdo ausente, URL inválida e arquivo ausente', async () => {
  const texto = await conteudo('txt', 'Texto');
  const invalido = await conteudo('img', 'Imagem', { url: '/uploads/../package.json' });
  const ausente = await conteudo('img', 'Imagem', { url: '/uploads/' + randomUUID() + '.png' });
  for (const id of [texto.id, randomUUID(), invalido.id, ausente.id]) {
    const r = await baixar(id);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-disposition'), null);
    assert.ok((await r.json()).error);
  }
});

test('download recusa vídeo em preparo sem entregar o original', async () => {
  const slide = await conteudo('vid', 'Vídeo', { otimizacao: { estado: 'otimizando' } });
  const r = await baixar(slide.id);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'O vídeo ainda está sendo preparado' });
  assert.equal(r.headers.get('content-disposition'), null);
});
