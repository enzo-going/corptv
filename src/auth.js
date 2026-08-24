'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const { rateLimit } = require('express-rate-limit');
const {
  hashPassword,
  isLoopback,
  isPrivateNetwork,
  normalizeUsername,
  parseCookies,
  publicUser,
  randomToken,
  safeEqualText,
  tokenHash,
  validatePassword,
  validateUsername,
  verifyPassword
} = require('./security');

const COOKIE_NAME = 'corptv_session';
const ROLES = new Set(['admin', 'editor', 'viewer']);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_PAIR_LIMIT = 5;
const LOGIN_IP_LIMIT = 12;
const failedLogins = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Além do bloqueio progressivo de credenciais inválidas, limita o volume total
// das rotas que consultam sessões, usuários e auditoria. Isso também restringe
// tentativas com credenciais válidas e requisições caras feitas em rajada.
const authRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(process.env.CORPTV_AUTH_REQUESTS_PER_MINUTE, 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ABSOLUTE_SESSION_MS = positiveNumber(process.env.CORPTV_SESSION_HOURS, 8) * 60 * 60 * 1000;
const IDLE_SESSION_MS = positiveNumber(process.env.CORPTV_SESSION_IDLE_MINUTES, 60) * 60 * 1000;

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) return { error: 'O nome deve ter de 2 a 80 caracteres.' };
  return { value: name };
}

function permissionsFor(role) {
  return {
    read: true,
    edit: role === 'admin' || role === 'editor',
    users: role === 'admin',
    audit: role === 'admin'
  };
}

function cookieHeader(token, secure) {
  const attributes = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookieHeader(secure) {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function isSecureRequest(req) {
  return req.secure;
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch (_) { return false; }
}

function attemptsFor(key) {
  const now = Date.now();
  const attempts = (failedLogins.get(key) || []).filter(ts => now - ts < LOGIN_WINDOW_MS);
  if (attempts.length) failedLogins.set(key, attempts);
  else failedLogins.delete(key);
  return attempts;
}

function loginBlocked(ip, username) {
  return attemptsFor('pair:' + ip + ':' + username).length >= LOGIN_PAIR_LIMIT ||
    attemptsFor('ip:' + ip).length >= LOGIN_IP_LIMIT;
}

function registerLoginFailure(ip, username) {
  const now = Date.now();
  for (const key of ['pair:' + ip + ':' + username, 'ip:' + ip]) {
    const attempts = attemptsFor(key);
    attempts.push(now);
    failedLogins.set(key, attempts);
  }
}

function clearLoginFailures(ip, username) {
  failedLogins.delete('pair:' + ip + ':' + username);
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function createAuth({ app, db, audit, log, setupCodeFile }) {
  const loginFile = path.join(__dirname, '../public/login/index.html');
  const dummyHashPromise = hashPassword('CorporTV-dummy-password-value');
  let setupCode = null;
  let setupCodePromise = null;
  let setupCreationInProgress = false;

  function normalizeSetupCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function generateSetupCode() {
    let compact = '';
    while (compact.length < 12) compact += randomToken(18).toUpperCase().replace(/[^A-Z0-9]/g, '');
    compact = compact.slice(0, 12);
    return compact.match(/.{1,4}/g).join('-');
  }

  async function ensureSetupCode() {
    if (setupCode) return setupCode;
    if (setupCodePromise) return setupCodePromise;
    setupCodePromise = (async () => {
      if (await userCount() !== 0) return null;
      if (setupCodeFile && fs.existsSync(setupCodeFile)) {
        const stored = String(fs.readFileSync(setupCodeFile, 'utf8')).trim();
        if (normalizeSetupCode(stored).length >= 10) setupCode = stored;
      }
      if (!setupCode) {
        setupCode = generateSetupCode();
        if (setupCodeFile) {
          fs.mkdirSync(path.dirname(setupCodeFile), { recursive: true });
          fs.writeFileSync(setupCodeFile, setupCode + '\n', { encoding: 'utf8', mode: 0o600 });
        }
        log('INFO', 'código de ativação inicial gerado', { arquivo: setupCodeFile || null });
      }
      return setupCode;
    })();
    try {
      return await setupCodePromise;
    } finally {
      setupCodePromise = null;
    }
  }

  function removeSetupCode() {
    setupCode = null;
    if (!setupCodeFile || !fs.existsSync(setupCodeFile)) return;
    try { fs.unlinkSync(setupCodeFile); } catch (error) {
      log('ERRO', 'não foi possível remover o código de ativação usado', { msg: error.message });
    }
  }

  db.ready.then(async () => {
    if (await userCount() === 0) await ensureSetupCode();
    else removeSetupCode();
  }).catch(error => log('ERRO', 'falha ao preparar ativação inicial', { msg: error.message }));

  async function userCount() {
    await db.ready;
    return db.users.count({});
  }

  async function createSession(req, res, user) {
    const token = randomToken();
    const now = Date.now();
    const session = {
      id: uuidv4(),
      user_id: user.id,
      token_hash: tokenHash(token),
      csrf_token: randomToken(),
      created_at: new Date(now).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + ABSOLUTE_SESSION_MS).toISOString(),
      ip: String(req.ip || '').slice(0, 80),
      user_agent: String(req.get('user-agent') || '').slice(0, 300)
    };
    await db.sessions.insert(session);
    const sessions = await db.sessions.find({ user_id: user.id }).sort({ created_at: -1 });
    if (sessions.length > 5) {
      await db.sessions.remove({ id: { $in: sessions.slice(5).map(item => item.id) } }, { multi: true });
    }
    res.set('Set-Cookie', cookieHeader(token, isSecureRequest(req)));
    return session;
  }

  async function resolveSession(req) {
    if (req.authResolved) return req.session || null;
    req.authResolved = true;
    const token = parseCookies(req.get('cookie'))[COOKIE_NAME];
    if (!token) return null;
    const session = await db.sessions.findOne({ token_hash: tokenHash(token) });
    if (!session) return null;
    const now = Date.now();
    const expired = new Date(session.expires_at).getTime() <= now;
    const idle = now - new Date(session.last_seen_at || session.created_at).getTime() > IDLE_SESSION_MS;
    if (expired || idle) {
      await db.sessions.remove({ id: session.id }, {});
      return null;
    }
    const user = await db.users.findOne({ id: session.user_id, active: { $ne: false } });
    if (!user) {
      await db.sessions.remove({ id: session.id }, {});
      return null;
    }
    if (now - new Date(session.last_seen_at || 0).getTime() > 5 * 60 * 1000) {
      const lastSeen = new Date(now).toISOString();
      await db.sessions.update({ id: session.id }, { $set: { last_seen_at: lastSeen } });
      session.last_seen_at = lastSeen;
    }
    req.session = session;
    req.user = user;
    return session;
  }

  async function requireSession(req, res, next) {
    await db.ready;
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: 'Autenticação necessária' });
    next();
  }

  function requireRole(role) {
    return async (req, res, next) => {
      await requireSession(req, res, async () => {
        if (req.user.role === role) return next();
        await audit.fromRequest(req, {
          action: 'authorization.denied', entity_type: 'api', entity_id: req.originalUrl, outcome: 'denied'
        });
        res.status(403).json({ error: 'Você não tem permissão para esta ação' });
      });
    };
  }

  async function requireCsrf(req, res, next) {
    if (!sameOrigin(req) || !req.session || !safeEqualText(req.get('x-csrf-token'), req.session.csrf_token)) {
      await audit.fromRequest(req, {
        action: 'csrf.rejected', entity_type: 'security', entity_id: req.originalUrl, outcome: 'denied'
      });
      return res.status(403).json({ error: 'Requisição de segurança inválida. Atualize a página e tente novamente.' });
    }
    next();
  }

  async function requirePanelPage(req, res, next) {
    await db.ready;
    if (await userCount() === 0) {
      if (isPrivateNetwork(req)) return res.redirect('/setup');
      return res.redirect('/login?setup=required');
    }
    const session = await resolveSession(req);
    if (!session) return res.redirect('/login?next=%2Fpainel');
    res.set('Cache-Control', 'no-store');
    next();
  }

  async function requireManagementApi(req, res, next) {
    if (req.path === '/heartbeat' || req.path.startsWith('/player/')) return next();
    await requireSession(req, res, async () => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.user.role === 'viewer') {
          await audit.fromRequest(req, {
            action: 'authorization.denied', entity_type: 'api', entity_id: req.originalUrl, outcome: 'denied'
          });
          return res.status(403).json({ error: 'Seu perfil possui acesso somente para leitura' });
        }
        return requireCsrf(req, res, next);
      }
      next();
    });
  }

  function classifyMutation(req) {
    // req.url e restaurada pelo Express depois que o middleware montado em
    // /api chama next(); originalUrl permanece estável até a resposta async.
    const cleanPath = String(req.originalUrl || req.path).split('?')[0].replace(/^\/api\/?/, '');
    const parts = cleanPath.split('/').filter(Boolean);
    const method = req.method.toLowerCase();
    if (parts[0] === 'slides') return { action: `content.${method === 'post' ? 'create' : method === 'put' ? 'update' : 'delete'}`, entity_type: 'content', entity_id: parts[1] };
    if (parts[0] === 'screens') return { action: `screen.${method === 'post' ? 'create' : method === 'put' ? 'update' : 'delete'}`, entity_type: 'screen', entity_id: parts[1] };
    if (parts[0] === 'groups' && parts[2] === 'slides') {
      return {
        action: method === 'put' ? 'schedule.update' : method === 'post' ? 'content.assign' : 'content.unassign',
        entity_type: 'group_content', entity_id: [parts[1], parts[3]].filter(Boolean).join(':')
      };
    }
    if (parts[0] === 'groups') return { action: `group.${method === 'post' ? 'create' : method === 'put' ? 'update' : 'delete'}`, entity_type: 'group', entity_id: parts[1] };
    return { action: 'management.' + method, entity_type: parts[0] || 'api', entity_id: parts[1] };
  }

  function auditManagementMutation(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const originalJson = res.json.bind(res);
    let sent = false;
    res.json = function auditedJson(body) {
      if (sent) return originalJson(body);
      sent = true;
      const classification = classifyMutation(req);
      const bodyKeys = req.body && typeof req.body === 'object'
        ? Object.keys(req.body).filter(key => !/pass|senha|token|secret/i.test(key))
        : [];
      const outcome = res.statusCode >= 400 ? 'failure' : 'success';
      audit.fromRequest(req, {
        ...classification,
        outcome,
        details: { method: req.method, status: res.statusCode, changed_fields: bodyKeys, upload: !!req.file }
      }).catch(error => log('ERRO', 'falha ao registrar auditoria', { msg: error.message }))
        .finally(() => originalJson(body));
      return res;
    };
    next();
  }

  app.get('/api/setup/status', authRequestLimiter, async (req, res) => {
    const local = isLoopback(req);
    const allowed = isPrivateNetwork(req);
    res.set('Cache-Control', 'no-store');
    res.json({ needs_setup: await userCount() === 0, local, allowed, activation_required: allowed && !local });
  });

  app.post('/api/setup', authRequestLimiter, async (req, res) => {
    await db.ready;
    if (!isPrivateNetwork(req)) return res.status(403).json({ error: 'A configuração inicial só é permitida pela rede interna.' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Origem inválida.' });
    if (setupCreationInProgress) return res.status(409).json({ error: 'A configuração inicial já está em andamento.' });
    setupCreationInProgress = true;
    try {
      if (await userCount() !== 0) return res.status(409).json({ error: 'A configuração inicial já foi concluída.' });
      if (!isLoopback(req)) {
        const usernameForLimit = '__initial_setup__';
        const ip = String(req.ip || '');
        if (loginBlocked(ip, usernameForLimit)) {
          return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
        }
        const expected = await ensureSetupCode();
        if (!safeEqualText(normalizeSetupCode(req.body && req.body.setup_code), normalizeSetupCode(expected))) {
          registerLoginFailure(ip, usernameForLimit);
          await audit.fromRequest(req, {
            actor: null, action: 'setup.failure', entity_type: 'authentication', outcome: 'failure'
          });
          return res.status(403).json({ error: 'Código de ativação inválido.' });
        }
        clearLoginFailures(ip, usernameForLimit);
      }
      const username = validateUsername(req.body && req.body.username);
      const name = cleanName(req.body && req.body.name);
      const password = validatePassword(req.body && req.body.password, username.value);
      const error = username.error || name.error || password.error;
      if (error) return res.status(400).json({ error });
      const now = new Date().toISOString();
      const user = {
        id: uuidv4(), username: username.value, name: name.value, role: 'admin', active: true,
        password_hash: await hashPassword(password.value), created_at: now, updated_at: now,
        password_changed_at: now, last_login_at: null
      };
      await db.users.insert(user);
      await audit.fromRequest(req, {
        actor: user, action: 'user.bootstrap', entity_type: 'user', entity_id: user.id,
        details: { username: user.username, role: user.role }
      });
      removeSetupCode();
      const session = await createSession(req, res, user);
      res.status(201).json({ user: publicUser(user), csrf_token: session.csrf_token });
    } finally {
      setupCreationInProgress = false;
    }
  });

  app.post('/api/auth/login', authRequestLimiter, async (req, res) => {
    await db.ready;
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Origem inválida.' });
    const username = normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');
    const ip = String(req.ip || '');
    if (loginBlocked(ip, username)) {
      await audit.fromRequest(req, {
        actor: null, action: 'login.blocked', entity_type: 'authentication', outcome: 'denied', details: { username }
      });
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
    }
    const user = await db.users.findOne({ username });
    const encoded = user ? user.password_hash : await dummyHashPromise;
    const valid = await verifyPassword(password, encoded);
    if (!user || user.active === false || !valid) {
      registerLoginFailure(ip, username);
      await audit.fromRequest(req, {
        actor: user ? publicUser(user) : null, action: 'login.failure', entity_type: 'authentication',
        outcome: 'failure', details: { username }
      });
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }
    clearLoginFailures(ip, username);
    const now = new Date().toISOString();
    await db.users.update({ id: user.id }, { $set: { last_login_at: now } });
    user.last_login_at = now;
    const session = await createSession(req, res, user);
    await audit.fromRequest(req, {
      actor: user, action: 'login.success', entity_type: 'authentication', entity_id: user.id
    });
    res.json({ user: publicUser(user), csrf_token: session.csrf_token, permissions: permissionsFor(user.role) });
  });

  app.get('/api/auth/me', authRequestLimiter, requireSession, (req, res) => {
    res.json({ user: publicUser(req.user), csrf_token: req.session.csrf_token, permissions: permissionsFor(req.user.role) });
  });

  app.post('/api/auth/logout', authRequestLimiter, requireSession, requireCsrf, async (req, res) => {
    await db.sessions.remove({ id: req.session.id }, {});
    await audit.fromRequest(req, { action: 'logout', entity_type: 'authentication', entity_id: req.user.id });
    res.set('Set-Cookie', clearCookieHeader(isSecureRequest(req)));
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', authRequestLimiter, requireSession, requireCsrf, async (req, res) => {
    const current = String((req.body && req.body.current_password) || '');
    const password = validatePassword(req.body && req.body.new_password, req.user.username);
    if (password.error) return res.status(400).json({ error: password.error });
    if (!await verifyPassword(current, req.user.password_hash)) {
      await audit.fromRequest(req, { action: 'password.change', entity_type: 'user', entity_id: req.user.id, outcome: 'failure' });
      return res.status(400).json({ error: 'A senha atual está incorreta.' });
    }
    const now = new Date().toISOString();
    await db.users.update({ id: req.user.id }, { $set: {
      password_hash: await hashPassword(password.value), password_changed_at: now, updated_at: now
    } });
    await db.sessions.remove({ user_id: req.user.id }, { multi: true });
    const session = await createSession(req, res, req.user);
    await audit.fromRequest(req, { action: 'password.change', entity_type: 'user', entity_id: req.user.id });
    res.json({ ok: true, csrf_token: session.csrf_token });
  });

  app.get('/api/users', authRequestLimiter, requireRole('admin'), async (req, res) => {
    const [users, sessions] = await Promise.all([
      db.users.find({}).sort({ name: 1 }),
      db.sessions.find({ expires_at: { $gt: new Date().toISOString() } })
    ]);
    const counts = new Map();
    sessions.forEach(session => counts.set(session.user_id, (counts.get(session.user_id) || 0) + 1));
    res.json(users.map(user => ({ ...publicUser(user), active_sessions: counts.get(user.id) || 0 })));
  });

  app.post('/api/users', authRequestLimiter, requireRole('admin'), requireCsrf, async (req, res) => {
    const username = validateUsername(req.body && req.body.username);
    const name = cleanName(req.body && req.body.name);
    const role = String((req.body && req.body.role) || 'viewer');
    const password = validatePassword(req.body && req.body.password, username.value);
    const error = username.error || name.error || (!ROLES.has(role) && 'Perfil inválido.') || password.error;
    if (error) return res.status(400).json({ error });
    if (await db.users.findOne({ username: username.value })) return res.status(409).json({ error: 'Este nome de usuário já existe.' });
    const now = new Date().toISOString();
    const user = {
      id: uuidv4(), username: username.value, name: name.value, role, active: true,
      password_hash: await hashPassword(password.value), created_at: now, updated_at: now,
      password_changed_at: now, last_login_at: null
    };
    await db.users.insert(user);
    await audit.fromRequest(req, {
      action: 'user.create', entity_type: 'user', entity_id: user.id,
      details: { username: user.username, role: user.role }
    });
    res.status(201).json(publicUser(user));
  });

  app.put('/api/users/:id', authRequestLimiter, requireRole('admin'), requireCsrf, async (req, res) => {
    const target = await db.users.findOne({ id: req.params.id });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const name = req.body && req.body.name !== undefined ? cleanName(req.body.name) : { value: target.name };
    const role = req.body && req.body.role !== undefined ? String(req.body.role) : target.role;
    const active = req.body && req.body.active !== undefined ? req.body.active === true : target.active !== false;
    if (name.error) return res.status(400).json({ error: name.error });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Perfil inválido.' });
    if (target.id === req.user.id && (role !== 'admin' || !active)) {
      return res.status(400).json({ error: 'Você não pode remover o próprio acesso administrativo.' });
    }
    if (target.role === 'admin' && target.active !== false && (role !== 'admin' || !active)) {
      const admins = await db.users.count({ role: 'admin', active: { $ne: false } });
      if (admins <= 1) return res.status(400).json({ error: 'O sistema precisa manter ao menos um administrador ativo.' });
    }
    const updatedAt = new Date().toISOString();
    await db.users.update({ id: target.id }, { $set: { name: name.value, role, active, updated_at: updatedAt } });
    if (!active || role !== target.role) await db.sessions.remove({ user_id: target.id }, { multi: true });
    await audit.fromRequest(req, {
      action: 'user.update', entity_type: 'user', entity_id: target.id,
      details: { username: target.username, old_role: target.role, role, active }
    });
    res.json({ ...publicUser({ ...target, name: name.value, role, active, updated_at: updatedAt }) });
  });

  app.post('/api/users/:id/reset-password', authRequestLimiter, requireRole('admin'), requireCsrf, async (req, res) => {
    const target = await db.users.findOne({ id: req.params.id });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Altere sua própria senha pela página Minha conta.' });
    const password = validatePassword(req.body && req.body.password, target.username);
    if (password.error) return res.status(400).json({ error: password.error });
    const now = new Date().toISOString();
    await db.users.update({ id: target.id }, { $set: {
      password_hash: await hashPassword(password.value), password_changed_at: now, updated_at: now
    } });
    await db.sessions.remove({ user_id: target.id }, { multi: true });
    await audit.fromRequest(req, {
      action: 'password.reset', entity_type: 'user', entity_id: target.id,
      details: { username: target.username }
    });
    res.json({ ok: true });
  });

  app.delete('/api/users/:id/sessions', authRequestLimiter, requireRole('admin'), requireCsrf, async (req, res) => {
    const target = await db.users.findOne({ id: req.params.id });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Use Sair para encerrar a própria sessão.' });
    const removed = await db.sessions.remove({ user_id: target.id }, { multi: true });
    await audit.fromRequest(req, {
      action: 'session.revoke', entity_type: 'user', entity_id: target.id,
      details: { username: target.username, sessions: removed }
    });
    res.json({ ok: true, removed });
  });

  function auditQuery(req) {
    const query = {};
    if (req.query.action) query.action = new RegExp(String(req.query.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (req.query.outcome && ['success', 'failure', 'denied'].includes(req.query.outcome)) query.outcome = req.query.outcome;
    if (req.query.actor) query['actor.username'] = new RegExp(String(req.query.actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (req.query.from || req.query.to) {
      query.ts = {};
      if (req.query.from) query.ts.$gte = new Date(req.query.from + 'T00:00:00').toISOString();
      if (req.query.to) query.ts.$lte = new Date(req.query.to + 'T23:59:59.999').toISOString();
    }
    return query;
  }

  app.get('/api/audit', authRequestLimiter, requireRole('admin'), async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    let query;
    try { query = auditQuery(req); } catch (_) { return res.status(400).json({ error: 'Filtro de data inválido.' }); }
    const [items, total, integrity] = await Promise.all([
      db.audit.find(query).sort({ seq: -1 }).skip(offset).limit(limit),
      db.audit.count(query),
      audit.verify()
    ]);
    res.json({ items, total, limit, offset, integrity });
    audit.fromRequest(req, { action: 'audit.read', entity_type: 'audit', details: { total, offset, limit } }).catch(() => {});
  });

  app.get('/api/audit/export.csv', authRequestLimiter, requireRole('admin'), async (req, res) => {
    let query;
    try { query = auditQuery(req); } catch (_) { return res.status(400).json({ error: 'Filtro de data inválido.' }); }
    const items = await db.audit.find(query).sort({ seq: -1 });
    const header = ['sequencia', 'data', 'usuario', 'nome', 'perfil', 'acao', 'entidade', 'identificador', 'resultado', 'ip', 'detalhes'];
    const rows = items.map(item => [
      item.seq, item.ts, item.actor && item.actor.username, item.actor && item.actor.name,
      item.actor && item.actor.role, item.action, item.entity_type, item.entity_id,
      item.outcome, item.ip, JSON.stringify(item.details || {})
    ].map(csvCell).join(','));
    await audit.fromRequest(req, { action: 'audit.export', entity_type: 'audit', details: { records: items.length } });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="corptv-auditoria.csv"',
      'Cache-Control': 'no-store'
    });
    res.send('\uFEFF' + header.map(csvCell).join(',') + '\n' + rows.join('\n'));
  });

  app.get('/login', authRequestLimiter, async (req, res) => {
    if (await userCount() === 0 && isPrivateNetwork(req)) return res.redirect('/setup');
    if (await resolveSession(req)) return res.redirect('/painel');
    res.set('Cache-Control', 'no-store');
    res.sendFile(loginFile);
  });

  app.get('/setup', authRequestLimiter, async (req, res) => {
    if (await userCount() !== 0) return res.redirect('/painel');
    if (!isPrivateNetwork(req)) return res.redirect('/login?setup=required');
    res.set('Cache-Control', 'no-store');
    res.sendFile(loginFile);
  });

  return {
    auditManagementMutation,
    requireManagementApi,
    requirePanelPage,
    resolveSession
  };
}

module.exports = { createAuth, permissionsFor };
