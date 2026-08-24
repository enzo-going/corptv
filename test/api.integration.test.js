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
process.env.CORPTV_MEDIA_REQUESTS_PER_MINUTE = '2';
process.env.CORPTV_PAGE_REQUESTS_PER_MINUTE = '2';

const db = require('../src/db');
const { app } = require('../src/server');

let server;
let baseUrl;
let authCookie = '';
let csrfToken = '';

function addPanelFields(form, title) {
  form.set('title', title);
  form.set('body', '');
  form.set('type', 'img');
  form.set('duration', '8');
  form.set('bg', '#111111');
  form.set('starts_at', '');
  form.set('expires_at', '');
  form.set('days', '');
  form.set('time_start', '');
  form.set('time_end', '');
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authCookie) headers.cookie = authCookie;
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(options.method || 'GET')) headers['x-csrf-token'] = csrfToken;
  return fetch(baseUrl + pathname, { ...options, headers });
}

async function json(pathname, options) {
  const response = await request(pathname, {
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
  const setup = await fetch(baseUrl + '/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Administrador dos testes', username: 'test-admin', password: 'Senha segura de testes 2026!' })
  });
  assert.equal(setup.status, 201);
  authCookie = setup.headers.get('set-cookie').split(';')[0];
  csrfToken = (await setup.json()).csrf_token;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.stopMaintenance();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('limita leituras de mídia e páginas por endereço', async () => {
  const fileName = '123e4567-e89b-12d3-a456-426614174000.png';
  const filePath = path.join(sandbox, 'uploads', fileName);
  fs.writeFileSync(filePath, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const media = await fetch(baseUrl + '/uploads/' + fileName);
      assert.equal(media.status, 200);
      await media.arrayBuffer();
      const panel = await fetch(baseUrl + '/painel');
      assert.equal(panel.status, 200);
      await panel.arrayBuffer();
    }

    const blockedMedia = await fetch(baseUrl + '/uploads/' + fileName);
    const blockedPanel = await fetch(baseUrl + '/painel');
    assert.equal(blockedMedia.status, 429);
    assert.equal(blockedPanel.status, 429);
    assert.ok(blockedMedia.headers.get('ratelimit'));
  } finally {
    fs.rmSync(filePath, { force: true });
  }
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

  const player = await request('/api/player/' + screen.body.id);
  assert.equal(player.status, 200);
  assert.match(player.headers.get('cache-control'), /no-store/);
});

test('API rejeita corpos JSON ausentes sem responder erro interno', async () => {
  const group = await json('/api/groups', { method: 'POST' });
  assert.equal(group.response.status, 400);
  assert.match(group.body.error, /obrigatório/i);

  const heartbeat = await json('/api/heartbeat', { method: 'POST' });
  assert.equal(heartbeat.response.status, 400);
  assert.match(heartbeat.body.error, /obrigatória/i);

  const playlist = await json('/api/groups/inexistente/slides', { method: 'POST' });
  assert.equal(playlist.response.status, 404);
  assert.match(playlist.body.error, /ambiente não encontrado/i);

  const unknownHeartbeat = await json('/api/heartbeat', {
    method: 'POST', body: { screen_id: 'inexistente' }
  });
  assert.equal(unknownHeartbeat.response.status, 404);

  const unknownGroup = await json('/api/groups/inexistente', {
    method: 'PUT', body: { name: 'Não existe', color: '#123456' }
  });
  assert.equal(unknownGroup.response.status, 404);

  const unknownScreen = await json('/api/screens/inexistente', {
    method: 'DELETE', body: {}
  });
  assert.equal(unknownScreen.response.status, 404);

  const headers = await request('/api/groups');
  assert.equal(headers.headers.get('x-powered-by'), null);
  assert.equal(headers.headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.headers.get('cache-control'), /no-store/);
});

test('upload falso é rejeitado e removido', async () => {
  const form = new FormData();
  addPanelFields(form, 'Arquivo falso');
  form.set('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'falso.png');
  const response = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(response.status, 415);
  assert.deepEqual(fs.readdirSync(process.env.CORPTV_UPLOADS_DIR), []);
});

test('exclusão de slide também remove sua mídia', async () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const form = new FormData();
  addPanelFields(form, 'Aviso');
  form.set('file', new Blob([png], { type: 'image/png' }), 'aviso.png');
  const created = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(created.status, 200);
  const slide = await created.json();
  const mediaPath = path.join(process.env.CORPTV_UPLOADS_DIR, path.basename(slide.url));
  assert.equal(fs.existsSync(mediaPath), true);

  const removed = await json('/api/slides/' + slide.id, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal(fs.existsSync(mediaPath), false);
});

test('modo do texto do vídeo é salvo, atualizado e entregue ao player', async () => {
  const group = await json('/api/groups', {
    method: 'POST', body: { name: 'Vídeo com texto', color: '#F59E0B' }
  });
  assert.equal(group.response.status, 200);

  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'TV vídeo com texto', group_id: group.body.id }
  });
  assert.equal(screen.response.status, 200);

  const mp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00
  ]);
  const form = new FormData();
  addPanelFields(form, 'Bom dia, equipe!');
  form.set('type', 'vid');
  form.set('duration', '0');
  form.set('video_text_mode', 'timed');
  form.set('video_text_seconds', '4');
  form.set('file', new Blob([mp4], { type: 'video/mp4' }), 'abertura.mp4');

  const createdResponse = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(createdResponse.status, 200);
  const slide = await createdResponse.json();
  assert.equal(slide.video_text_mode, 'timed');
  assert.equal(slide.video_text_seconds, 4);

  const linked = await json('/api/groups/' + group.body.id + '/slides', {
    method: 'POST', body: { slide_id: slide.id }
  });
  assert.equal(linked.response.status, 200);

  const playerResponse = await request('/api/player/' + screen.body.id);
  assert.equal(playerResponse.status, 200);
  const player = await playerResponse.json();
  assert.equal(player.slides[0].video_text_mode, 'timed');
  assert.equal(player.slides[0].video_text_seconds, 4);

  const updated = await json('/api/slides/' + slide.id, {
    method: 'PUT', body: { video_text_mode: 'none', video_text_seconds: 0 }
  });
  assert.equal(updated.response.status, 200);

  const slidesResponse = await request('/api/slides');
  const slides = await slidesResponse.json();
  const saved = slides.find(item => item.id === slide.id);
  assert.equal(saved.video_text_mode, 'none');
  assert.equal(saved.video_text_seconds, 0);

  const invalid = await json('/api/slides/' + slide.id, {
    method: 'PUT', body: { video_text_mode: 'timed', video_text_seconds: 0 }
  });
  assert.equal(invalid.response.status, 400);
});
