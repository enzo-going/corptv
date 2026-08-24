'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-auth-'));
process.env.CORPTV_DATA_DIR = path.join(sandbox, 'data');
process.env.CORPTV_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.CORPTV_LOG_DIR = path.join(sandbox, 'logs');
process.env.CORPTV_DISABLE_SEED = '1';
process.env.CORPTV_DISABLE_MAINTENANCE = '1';

const db = require('../src/db');
const { app } = require('../src/server');

let server;
let baseUrl;
let admin;

async function send(pathname, { method = 'GET', body, auth, headers = {}, redirect } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (auth) {
    requestHeaders.cookie = auth.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && auth.csrf) requestHeaders['x-csrf-token'] = auth.csrf;
  }
  const response = await fetch(baseUrl + pathname, {
    method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: redirect || 'follow'
  });
  let data = null;
  if ((response.headers.get('content-type') || '').includes('json')) data = await response.json();
  return { response, data };
}

function authFrom(response, data) {
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrf_token, user: data.user };
}

async function login(username, password) {
  const result = await send('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.response.status, 200);
  return authFrom(result.response, result.data);
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

test('inicialização usa código descartável na rede e cria o primeiro administrador', async () => {
  const panel = await send('/painel', { redirect: 'manual' });
  assert.equal(panel.response.status, 302);
  assert.equal(panel.response.headers.get('location'), '/setup');

  const status = await send('/api/setup/status');
  assert.deepEqual(status.data, {
    needs_setup: true, local: true, allowed: true, activation_required: false
  });
  assert.match(status.response.headers.get('cache-control'), /no-store/);
  assert.equal(fs.existsSync(path.join(sandbox, 'logs', 'corptv-setup-code.txt')), true);

  const wrongOrigin = await send('/api/setup', {
    method: 'POST', headers: { origin: 'http://malicioso.example' },
    body: { name: 'TI', username: 'admin-ti', password: 'Senha corporativa forte 2026!' }
  });
  assert.equal(wrongOrigin.response.status, 403);

  const setupAttempts = await Promise.all([
    send('/api/setup', {
      method: 'POST', body: { name: 'Administrador TI', username: 'admin-ti', password: 'Senha corporativa forte 2026!' }
    }),
    send('/api/setup', {
      method: 'POST', body: { name: 'Administrador TI', username: 'admin-ti', password: 'Senha corporativa forte 2026!' }
    })
  ]);
  const setup = setupAttempts.find(result => result.response.status === 201);
  const concurrent = setupAttempts.find(result => result.response.status === 409);
  assert.ok(setup);
  assert.ok(concurrent);
  assert.match(concurrent.data.error, /andamento|concluída/);
  assert.equal(setup.response.status, 201);
  assert.equal(setup.data.user.role, 'admin');
  assert.match(setup.response.headers.get('set-cookie'), /Path=\/;/);
  assert.match(setup.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(setup.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.doesNotMatch(setup.response.headers.get('set-cookie'), /Max-Age/);
  assert.match(setup.response.headers.get('cache-control'), /no-store/);
  assert.equal(fs.existsSync(path.join(sandbox, 'logs', 'corptv-setup-code.txt')), false);
  admin = authFrom(setup.response, setup.data);

  const spoofedHttps = await send('/api/auth/login', {
    method: 'POST', headers: { 'x-forwarded-proto': 'https' },
    body: { username: 'admin-ti', password: 'Senha corporativa forte 2026!' }
  });
  assert.equal(spoofedHttps.response.status, 200);
  assert.doesNotMatch(spoofedHttps.response.headers.get('set-cookie'), /;\s*Secure/i);

  const repeated = await send('/api/setup', {
    method: 'POST', body: { name: 'Outro TI', username: 'outro-ti', password: 'Outra senha corporativa 2026!' }
  });
  assert.equal(repeated.response.status, 409);
});

test('painel e API de gestão exigem sessão, mas player e saúde seguem públicos', async () => {
  const panel = await send('/painel', { redirect: 'manual' });
  assert.equal(panel.response.status, 302);
  assert.match(panel.response.headers.get('location'), /^\/login/);
  assert.equal((await send('/api/groups')).response.status, 401);
  assert.equal((await send('/api/groups', { auth: admin })).response.status, 200);
  assert.equal((await send('/painel/index.html', { redirect: 'manual' })).response.status, 302);
  assert.equal((await send('/painel/index.html', { auth: admin })).response.status, 200);
  assert.equal((await send('/health')).response.status, 200);
  assert.equal((await send('/api/player/tela-inexistente')).response.status, 404);
  assert.equal((await send('/player/tela-inexistente')).response.status, 200);
});

test('CSRF e perfis impedem alterações e acesso de TI fora da permissão', async () => {
  const noCsrf = { ...admin, csrf: '' };
  assert.equal((await send('/api/groups', {
    method: 'POST', body: { name: 'Bloqueado', color: '#123456' }, auth: noCsrf
  })).response.status, 403);

  const viewerCreated = await send('/api/users', {
    method: 'POST', auth: admin,
    body: { name: 'Pessoa Leitora', username: 'leitor', role: 'viewer', password: 'Chave corporativa azul 2026!' }
  });
  assert.equal(viewerCreated.response.status, 201);
  const editorCreated = await send('/api/users', {
    method: 'POST', auth: admin,
    body: { name: 'Pessoa Editora', username: 'editor', role: 'editor', password: 'Chave corporativa verde 2026!' }
  });
  assert.equal(editorCreated.response.status, 201);

  const viewer = await login('leitor', 'Chave corporativa azul 2026!');
  assert.equal((await send('/api/groups', { auth: viewer })).response.status, 200);
  assert.equal((await send('/api/groups', {
    method: 'POST', auth: viewer, body: { name: 'Não autorizado', color: '#123456' }
  })).response.status, 403);
  assert.equal((await send('/api/users', { auth: viewer })).response.status, 403);

  const editor = await login('editor', 'Chave corporativa verde 2026!');
  const group = await send('/api/groups', {
    method: 'POST', auth: editor, body: { name: 'Criado pelo editor', color: '#123456' }
  });
  assert.equal(group.response.status, 200);
  assert.equal((await send('/api/users', { auth: editor })).response.status, 403);
  assert.equal((await send('/api/audit', { auth: editor })).response.status, 403);
});

test('gestão preserva o último administrador e revoga sessões', async () => {
  const users = await send('/api/users', { auth: admin });
  const viewer = users.data.find(user => user.username === 'leitor');
  const selfUpdate = await send('/api/users/' + admin.user.id, {
    method: 'PUT', auth: admin, body: { role: 'viewer' }
  });
  assert.equal(selfUpdate.response.status, 400);

  const viewerSession = await login('leitor', 'Chave corporativa azul 2026!');
  assert.equal((await send('/api/groups', { auth: viewerSession })).response.status, 200);
  const revoked = await send('/api/users/' + viewer.id + '/sessions', { method: 'DELETE', auth: admin });
  assert.equal(revoked.response.status, 200);
  assert.ok(revoked.data.removed >= 1);
  assert.equal((await send('/api/groups', { auth: viewerSession })).response.status, 401);
});

test('falhas e mudanças aparecem na auditoria com cadeia íntegra e sem senhas', async () => {
  const failed = await send('/api/auth/login', {
    method: 'POST', body: { username: 'leitor', password: 'senha-incorreta' }
  });
  assert.equal(failed.response.status, 401);
  assert.equal(failed.data.error, 'Usuário ou senha inválidos.');

  const result = await send('/api/audit?limit=200', { auth: admin });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.integrity.ok, true);
  const actions = new Set(result.data.items.map(item => item.action));
  assert.ok(actions.has('user.bootstrap'));
  assert.ok(actions.has('login.success'));
  assert.ok(actions.has('login.failure'));
  assert.ok(actions.has('group.create'));
  assert.ok(actions.has('authorization.denied'));
  assert.ok(actions.has('session.revoke'));
  assert.doesNotMatch(JSON.stringify(result.data.items), /Chave corporativa|Senha corporativa/);

  const exported = await send('/api/audit/export.csv', { auth: admin });
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-type'), /text\/csv/);
  assert.match(exported.response.headers.get('content-disposition'), /corptv-auditoria\.csv/);
});

test('a verificação de integridade detecta alteração posterior em um evento', async () => {
  await db.audit.update({ seq: 1 }, { $set: { details: { adulterado: true } } });
  const result = await send('/api/audit?limit=10', { auth: admin });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.integrity.ok, false);
  assert.equal(result.data.integrity.broken_at, 1);
});

test('rotas sensíveis limitam rajadas por endereço', async () => {
  let limited = null;
  for (let attempt = 0; attempt < 130 && !limited; attempt += 1) {
    const result = await send('/login', { redirect: 'manual' });
    if (result.response.status === 429) limited = result.response;
  }
  assert.ok(limited, 'o limite compartilhado deveria bloquear a rajada');
  assert.match(limited.headers.get('retry-after') || '', /^\d+$/);
});
