'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-publico-'));
Object.assign(process.env, {
  CORPTV_DATA_DIR: path.join(pasta, 'data'), CORPTV_UPLOADS_DIR: path.join(pasta, 'uploads'),
  CORPTV_LOG_DIR: path.join(pasta, 'logs'), CORPTV_DISABLE_SEED: '1',
  CORPTV_DISABLE_MAINTENANCE: '1', CORPTV_FFMPEG: 'desligado',
  CORPTV_PLAYER_REQUESTS_PER_MINUTE: '2', CORPTV_HEARTBEAT_REQUESTS_PER_MINUTE: '2'
});
const db = require('../src/db');
const { app } = require('../src/server');

test('player e heartbeat públicos limitam rajadas antes de consultar ou gravar no banco', async t => {
  await db.ready;
  await db.screens.insert({ id: 'tv-teste', group_id: 'grupo-teste' });
  const servidor = app.listen(0, 'localhost');
  await new Promise(resolve => servidor.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => servidor.close(resolve));
    db.stopMaintenance();
    fs.rmSync(pasta, { recursive: true, force: true });
  });
  const base = `http://localhost:${servidor.address().port}`;
  for (let i = 0; i < 2; i++) {
    const player = await fetch(base + '/api/player/tv-teste');
    assert.equal(player.status, 200);
    await player.json();
    const heartbeat = await fetch(base + '/api/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen_id: 'tv-teste' })
    });
    assert.equal(heartbeat.status, 200);
    await heartbeat.json();
  }
  const antes = (await db.screens.findOne({ id: 'tv-teste' })).last_seen;
  for (const [rota, opcoes] of [['/api/player/tv-teste', {}], ['/api/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen_id: 'tv-teste' })
  }]]) {
    const resposta = await fetch(base + rota, opcoes);
    assert.equal(resposta.status, 429);
    assert.ok(resposta.headers.get('ratelimit'));
    await resposta.text();
  }
  assert.equal((await db.screens.findOne({ id: 'tv-teste' })).last_seen, antes);
});
