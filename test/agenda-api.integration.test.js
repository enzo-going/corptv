'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-agenda-api-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado'
});
const db = require('../src/db');
const { app } = require('../src/server');
let servidor, base, cookie, csrf;
async function enviar(rota, method, body) {
  const r = await fetch(base + rota, {
    method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}
test.before(async () => {
  await db.ready;
  servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;
  const r = await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin-teste', name: 'Administrador de teste', password: 'abcde' })
  });
  cookie = r.headers.get('set-cookie').split(';')[0]; csrf = (await r.json()).csrf_token;
  await db.groups.insert({ id: 'grupo-teste', name: 'Ambiente de teste' });
});
test.after(async () => {
  await new Promise(resolve => servidor.close(resolve));
  db.stopMaintenance(); fs.rmSync(pasta, { recursive: true, force: true });
});

test('datas, horários e dias inválidos não criam nem substituem uma agenda', async () => {
  const casos = [
    { starts_at: 'invalida' }, { starts_at: '2026-02-30' }, { expires_at: '2026-08-14lixo' },
    { time_start: '25:00', time_end: '26:00' }, { time_start: '09:90', time_end: '10:00' },
    { days: [9] }, { days: { dia: 1 } },
    { starts_at: '2026-08-14T10:00', expires_at: '2026-08-14T10:00' }
  ];
  for (const agenda of casos) {
    const id = randomUUID();
    await db.slides.insert({ id, type: 'txt', title: 'Texto de teste' });
    const rota = '/api/groups/grupo-teste/slides';
    const novo = await enviar(rota, 'POST', { slide_id: id, ...agenda });
    assert.equal(novo.status, 400, JSON.stringify(agenda));
    assert.equal(await db.gslides.count({ slide_id: id }), 0);
    const bom = await enviar(rota, 'POST', { slide_id: id, starts_at: '2026-08-14', expires_at: '2026-08-14' });
    assert.equal(bom.status, 200);
    const antes = await db.gslides.findOne({ slide_id: id });
    const ruim = await enviar(rota + '/' + id, 'PUT', agenda);
    assert.equal(ruim.status, 400, JSON.stringify(agenda));
    assert.deepEqual(await db.gslides.findOne({ slide_id: id }), antes);
  }
});

test('data sem hora vale o dia inteiro e data com fuso conserva o instante', async () => {
  const id = randomUUID();
  await db.slides.insert({ id, type: 'txt', title: 'Texto de teste' });
  const rota = '/api/groups/grupo-teste/slides';
  assert.equal((await enviar(rota, 'POST', { slide_id: id, starts_at: '2026-08-14', expires_at: '2026-08-14' })).status, 200);
  let agenda = await db.gslides.findOne({ slide_id: id });
  const inicio = new Date(agenda.starts_at), fim = new Date(agenda.expires_at);
  assert.equal(inicio.getDate(), 14); assert.equal(inicio.getHours(), 0);
  assert.equal(fim.getDate(), 14); assert.equal(fim.getHours(), 23); assert.equal(fim.getMinutes(), 59);
  assert.equal((await enviar(rota + '/' + id, 'PUT', {
    starts_at: '2026-08-14T10:00:00.000Z', expires_at: '2026-08-14T11:00:00.000Z'
  })).status, 200);
  agenda = await db.gslides.findOne({ slide_id: id });
  assert.equal(agenda.starts_at, '2026-08-14T10:00:00.000Z');
  assert.equal(agenda.expires_at, '2026-08-14T11:00:00.000Z');
});
