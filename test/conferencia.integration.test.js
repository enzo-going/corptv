'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const limparTemporario = require('./limpar-temporario');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-conferencia-api-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
fs.mkdirSync(process.env.CORPTV_UPLOADS_DIR, { recursive: true });
const db = require('../src/db');
const { app } = require('../src/server');
let servidor;
let base;

test.before(async () => {
  await db.ready;
  servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  limparTemporario(pasta);
});

async function programacao(tela) {
  const r = await fetch(base + '/api/player/' + tela, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
  return (await r.json()).slides;
}

test('a programação leva o SHA-256 de cada mídia assim que ele fica pronto', async () => {
  const id = crypto.randomUUID();
  const video = Buffer.alloc(2 * 1024 * 1024, 9);
  fs.writeFileSync(path.join(process.env.CORPTV_UPLOADS_DIR, id + '.mp4'), video);
  await db.slides.insert({ id, type: 'vid', title: 'Vídeo', duration: 10, url: '/uploads/' + id + '.mp4' });
  await db.slides.insert({ id: 'aviso', type: 'txt', title: 'Aviso', body: 'texto', duration: 10, url: null });
  await db.groups.insert({ id: 'ambiente', name: 'Ambiente', color: '#123456' });
  await db.gslides.insert([
    { group_id: 'ambiente', slide_id: id, position: 0 },
    { group_id: 'ambiente', slide_id: 'aviso', position: 1 }
  ]);
  await db.screens.insert({ id: 'sala', name: 'Sala', group_id: 'ambiente' });

  // O primeiro pedido não espera o cálculo: a TV recebe a programação na hora.
  const primeira = await programacao('sala');
  assert.equal(primeira.length, 2);
  assert.equal(primeira[0].sha256, undefined);

  let slides = primeira;
  for (let i = 0; i < 100 && !slides[0].sha256; i++) {
    await new Promise(r => setTimeout(r, 20));
    slides = await programacao('sala');
  }
  assert.equal(slides[0].sha256, crypto.createHash('sha256').update(video).digest('hex'));
  assert.equal(slides[1].sha256, undefined, 'texto não tem arquivo para conferir');
  assert.ok(fs.existsSync(path.join(process.env.CORPTV_DATA_DIR, 'conferencia-midias.json')));
});
