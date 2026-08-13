'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-api-'));
process.env.CORPTV_DATA_DIR = path.join(sandbox, 'data');
process.env.CORPTV_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.CORPTV_LOG_DIR = path.join(sandbox, 'logs');
process.env.CORPTV_DISABLE_SEED = '1';
process.env.CORPTV_DISABLE_MAINTENANCE = '1';

const db = require('../src/db');
const { app } = require('../src/server');

let server;
let baseUrl;

async function json(pathname, options) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options && options.headers) },
    body: options && options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  await db.ready;
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.stopMaintenance();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('API valida relações, entradas e impede cache de programação', async () => {
  const invalid = await json('/api/groups', { method: 'POST', body: { name: '', color: '#123456' } });
  assert.equal(invalid.response.status, 400);

  const createdGroup = await json('/api/groups', {
    method: 'POST', body: { name: ' Recepção ', color: '#AABBCC' }
  });
  assert.equal(createdGroup.response.status, 200);
  assert.equal(createdGroup.body.name, 'Recepção');

  const missingGroup = await json('/api/screens', {
    method: 'POST', body: { name: 'TV sem grupo', group_id: 'inexistente' }
  });
  assert.equal(missingGroup.response.status, 404);

  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'Recepção Principal', group_id: createdGroup.body.id }
  });
  assert.equal(screen.response.status, 200);

  const player = await fetch(baseUrl + '/api/player/' + screen.body.id);
  assert.equal(player.status, 200);
  assert.match(player.headers.get('cache-control'), /no-store/);
});

test('upload falso é rejeitado e removido', async () => {
  const form = new FormData();
  form.set('title', 'Arquivo falso');
  form.set('type', 'img');
  form.set('duration', '8');
  form.set('bg', '#111111');
  form.set('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'falso.png');
  const response = await fetch(baseUrl + '/api/slides', { method: 'POST', body: form });
  assert.equal(response.status, 415);
  assert.deepEqual(fs.readdirSync(process.env.CORPTV_UPLOADS_DIR), []);
});

test('exclusão de slide também remove sua mídia', async () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const form = new FormData();
  form.set('title', 'Aviso');
  form.set('type', 'img');
  form.set('duration', '8');
  form.set('bg', '#111111');
  form.set('file', new Blob([png], { type: 'image/png' }), 'aviso.png');
  const created = await fetch(baseUrl + '/api/slides', { method: 'POST', body: form });
  assert.equal(created.status, 200);
  const slide = await created.json();
  const mediaPath = path.join(process.env.CORPTV_UPLOADS_DIR, path.basename(slide.url));
  assert.equal(fs.existsSync(mediaPath), true);

  const removed = await json('/api/slides/' + slide.id, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal(fs.existsSync(mediaPath), false);
});
