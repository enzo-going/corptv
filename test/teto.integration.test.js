'use strict';

// O teto total do CorporTV: a soma de tudo o que ele manda de mídia não passa do
// valor configurado, nem com várias TVs baixando ao mesmo tempo. Mexe só no próprio
// CorporTV (o QoS do Windows não pega o tráfego que sai pelo nginx).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const limparTemporario = require('./limpar-temporario');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-teto-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado',
  // Sem limite por TV, teto total de 8 Mb/s = 1 MB/s.
  CORPTV_LIMITE_MBPS: '0', CORPTV_TETO_TOTAL_MBPS: '8', CORPTV_MEDIA_REQUESTS_PER_MINUTE: '1000'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');
let servidor, base;

test.before(async () => {
  await db.ready;
  servidor = app.listen(0, '127.0.0.1');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance();
  limparTemporario(pasta);
});

test('duas TVs baixando juntas dividem o teto total, sem passar dele', async () => {
  const nome = '123e4567-e89b-12d3-a456-4266141740aa.mp4';
  fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, nome), Buffer.alloc(768 * 1024, 3));
  const inicio = Date.now();
  const baixar = async () => Buffer.from(await (await fetch(base + '/uploads/' + nome)).arrayBuffer()).length;
  const tamanhos = await Promise.all([baixar(), baixar()]);
  const segundos = (Date.now() - inicio) / 1000;
  assert.deepEqual(tamanhos, [768 * 1024, 768 * 1024]);
  // 1,5 MB a 1 MB/s: pelo menos ~1,4 s. Sem o teto, no próprio computador, seria instantâneo.
  assert.ok(segundos >= 1.3, `as duas baixaram rápido demais (${segundos.toFixed(2)} s): o teto não segurou`);
});

test('o Baixar do painel também fica dentro do teto total', async () => {
  const password_hash = await hashPassword('abcde');
  await db.users.insert({ id: 'adm', username: 'adm', name: 'Conta de teste', role: 'admin', active: true, password_hash });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'adm', password: 'abcde' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.json();
  const nome = '123e4567-e89b-12d3-a456-4266141740bb.mp4';
  fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, nome), Buffer.alloc(1024 * 1024, 5));
  await db.slides.insert({ id: 'baixar-teto', type: 'vid', title: 'Video', url: '/uploads/' + nome });
  const inicio = Date.now();
  const r = await fetch(base + '/api/slides/baixar-teto/arquivo', { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Video\.mp4"/);
  assert.equal(r.headers.get('content-length'), String(1024 * 1024));
  assert.equal(Buffer.from(await r.arrayBuffer()).length, 1024 * 1024);
  assert.ok((Date.now() - inicio) / 1000 >= 0.85, 'o download passou do teto');
});

test('a página Rede recebe o teto configurado', async () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(fonte, /resumo\.teto_mbps = TETO_TOTAL_MBPS;/);
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  assert.ok(painel.includes('if(Number.isFinite(r.teto_mbps))REDE_REF_MBPS=r.teto_mbps;'));
});
