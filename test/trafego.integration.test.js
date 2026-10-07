'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-trafego-api-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado', CORPTV_LIMITE_MBPS: '0'
});
const db = require('../src/db');
const { hashPassword } = require('../src/security');
const { app } = require('../src/server');
let servidor, base;
const contas = {};

test.before(async () => {
  await db.ready;
  const password_hash = await hashPassword('abcde');
  await db.users.insert(['admin', 'editor'].map(role => ({ id: role, username: role, name: 'Conta de teste', role, active: true, password_hash })));
  servidor = app.listen(0, '127.0.0.1');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
  for (const role of ['admin', 'editor']) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: role, password: 'abcde' }) });
    contas[role] = r.headers.get('set-cookie').split(';')[0];
    await r.json();
  }
});

test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance();
  fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('o TI vê quanto o CorporTV mandou, para quem, e exporta a planilha; o editor não', async () => {
  // Um vídeo de 2 MB baixado por uma TV "atrás do nginx" (o endereço real vem no X-Real-IP).
  const nome = '123e4567-e89b-12d3-a456-426614174abc.mp4';
  fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, nome), Buffer.alloc(2 * 1024 * 1024, 7));
  const video = await fetch(base + '/uploads/' + nome, { headers: { 'x-real-ip': '192.0.2.77' } });
  assert.equal(video.status, 200);
  await video.arrayBuffer();

  const r = await fetch(base + '/api/trafego', { headers: { cookie: contas.admin } });
  assert.equal(r.status, 200);
  const dados = await r.json();
  assert.ok(dados.total.saida >= 2 * 1024 * 1024, 'contou o vídeo: ' + dados.total.saida);
  const tv = dados.clientes.find(c => c.endereco === '192.0.2.77');
  assert.ok(tv && tv.saida >= 2 * 1024 * 1024, 'o vídeo ficou no cliente certo');
  assert.ok(dados.tipos.video.saida >= 2 * 1024 * 1024);
  assert.equal(dados.minutos, undefined, 'a lista bruta de minutos não vai para o painel');

  const agora = await (await fetch(base + '/api/trafego/agora', { headers: { cookie: contas.admin } })).json();
  assert.equal(typeof agora.mbps, 'number');

  const csv = await fetch(base + '/api/trafego/exportar', { headers: { cookie: contas.admin } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="trafego-corportv-/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  // Marca UTF-8 no início: o Excel abre com os acentos certos.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const texto = bytes.subarray(3).toString('utf8');
  assert.match(texto, /^data_hora;enviado_mb;recebido_mb;media_mbps;pico_1s_mbps;pedidos;maior_cliente;maior_cliente_mb\r\n/);
  assert.match(texto, /192\.0\.2\.77/);

  assert.equal((await fetch(base + '/api/trafego', { headers: { cookie: contas.editor } })).status, 403);
  assert.equal((await fetch(base + '/api/trafego')).status, 401);
  assert.equal((await fetch(base + '/api/trafego?de=ontem', { headers: { cookie: contas.admin } })).status, 400);
  const longo = new Date(Date.now() - 40 * 86400000).toISOString();
  assert.equal((await fetch(base + '/api/trafego?de=' + longo, { headers: { cookie: contas.admin } })).status, 400);
});
