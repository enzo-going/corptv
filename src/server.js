const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('./db');
const {
  activeForMs,
  scheduleFromBody,
  slideActive,
  slideStatus,
  validarAgendamento
} = require('./scheduling');
const {
  validateGroupInput,
  validateScreenInput,
  validateSlideInput
} = require('./validation');
const {
  acceptsUpload,
  inspectStoredUpload,
  removeFile,
  uploadedPathFromUrl
} = require('./uploads');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();
const uploadsDir = path.resolve(process.env.CORPTV_UPLOADS_DIR || path.join(__dirname, '../public/uploads'));
const logDir = path.resolve(process.env.CORPTV_LOG_DIR || path.join(__dirname, '../logs'));
const accessLog = path.join(logDir, 'corptv-media-access.log');

// Log com carimbo de tempo no stdout. O gerenciador do processo pode redirecionar
// a saída; o log de mídia fica no diretório configurado por CORPTV_LOG_DIR.
function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
  (level === 'ERRO' ? console.error : console.log)(line);
}

// O Express 4 nao captura rejeicao de promise em handler async: a excecao vira
// unhandledRejection e o Node 15+ derruba o processo inteiro, apagando todas as
// TVs. Em vez de alterar as rotas uma a uma, envolvemos os metodos do app para
// que qualquer rejeicao seja encaminhada ao middleware de erro do fim do arquivo.
['get', 'post', 'put', 'delete'].forEach(method => {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (!handlers.length) return original(routePath); // app.get('port') = leitura de config
    return original(routePath, ...handlers.map(h =>
      typeof h === 'function' && h.length < 4
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
        : h
    ));
  };
});

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  db.ready.then(() => next(), next);
});
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// Registra somente transferencias de midia. O log ajuda a investigar uma TV
// sem registrar o corpo dos arquivos nem aumentar perceptivelmente o trafego.
app.use('/uploads', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      range: req.headers.range || null,
      bytes: res.getHeader('Content-Length') || null,
      contentRange: res.getHeader('Content-Range') || null,
      ms: Date.now() - started
    }) + '\n';
    fs.appendFile(accessLog, line, () => {});
  });
  next();
});

// Os nomes de upload sao UUIDs e nunca sao sobrescritos. Cache longo evita
// que uma TV baixe novamente o mesmo video a cada abertura do player.
app.use('/uploads', express.static(uploadsDir, {
  acceptRanges: true,
  etag: true,
  maxAge: '30d',
  immutable: true
}));
app.use(express.static(path.join(__dirname, '../public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4']);
const upload = multer({
  storage,
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 1,
    fields: 10,
    parts: 11,
    fieldNameSize: 64,
    fieldSize: 2048
  },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.has(extension) && acceptsUpload(file)) return cb(null, true);
    const error = new Error('Formato nao permitido. Use JPG, PNG, WEBP ou MP4.');
    error.code = 'INVALID_FILE_TYPE';
    cb(error);
  }
});

// Tratamento de erro de upload (arquivo muito grande, etc)
function handleUpload(req, res, next) {
  const up = upload.single('file');
  up(req, res, (err) => {
    if (err) {
      const respond = () => {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Arquivo muito grande. Limite: 200MB. Otimize o video antes do envio.' });
        }
        if (err.code === 'INVALID_FILE_TYPE') {
          return res.status(415).json({ error: err.message });
        }
        if (err instanceof multer.MulterError) {
          return res.status(400).json({ error: 'Upload inválido: ' + err.message });
        }
        return res.status(500).json({ error: 'Erro no upload: ' + err.message });
      };
      return Promise.resolve(req.file && removeFile(req.file.path)).catch(error => {
        log('ERRO', 'não foi possível limpar upload rejeitado', { msg: error.message });
      }).finally(respond);
    }
    next();
  });
}

// ── GRUPOS ───────────────────────────────────────────────
app.get('/api/groups', async (req, res) => {
  const groups = await db.groups.find({}).sort({ name: 1 });
  res.json(groups);
});

app.post('/api/groups', async (req, res) => {
  const fields = validateGroupInput(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const doc = { id: uuidv4(), ...fields.value, created_at: new Date() };
  await db.groups.insert(doc);
  res.json(doc);
});

app.put('/api/groups/:id', async (req, res) => {
  const fields = validateGroupInput(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const affected = await db.groups.update({ id: req.params.id }, { $set: fields.value });
  if (!affected) return res.status(404).json({ error: 'Grupo não encontrado' });
  res.json({ ok: true });
});

app.delete('/api/groups/:id', async (req, res) => {
  const group = await db.groups.findOne({ id: req.params.id });
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  const screens = await db.screens.find({ group_id: req.params.id });
  if (screens.length) return res.status(400).json({ error: 'Mova as telas antes de remover o grupo' });
  await db.gslides.remove({ group_id: req.params.id }, { multi: true });
  await db.groups.remove({ id: req.params.id }, {});
  res.json({ ok: true });
});

// ── AGENDAMENTO DOS SLIDES ────────────────────────────────
// A regra fica em scheduling.js para ser usada pelo servidor e coberta por
// testes unitários sem precisar iniciar a aplicação ou acessar o banco.

// ── SLIDES ───────────────────────────────────────────────
// Cada slide sai com o status calculado aqui, para o painel nao repetir a
// regra de calendario e nunca divergir do que o player realmente recebe.
app.get('/api/slides', async (req, res) => {
  const slides = await db.slides.find({}).sort({ created_at: -1 });
  const now = new Date();
  res.json(slides.map(s => Object.assign({}, s, { status: slideStatus(s, now) })));
});

app.post('/api/slides', handleUpload, async (req, res) => {
  const cleanupUpload = () => req.file && removeFile(req.file.path);
  let uploadedType = null;
  if (req.file) {
    let result;
    try {
      result = await inspectStoredUpload(req.file.path, req.file);
    } catch (error) {
      await cleanupUpload();
      throw error;
    }
    if (!result.ok) {
      await cleanupUpload();
      return res.status(415).json({ error: result.error });
    }
    uploadedType = result.type;
  }
  const fields = validateSlideInput(req.body, { hasFile: Boolean(req.file), fileType: uploadedType });
  if (fields.error) {
    await cleanupUpload();
    return res.status(400).json({ error: fields.error });
  }
  const agendamento = scheduleFromBody(req.body);
  const invalido = validarAgendamento(agendamento, req.body);
  if (invalido) {
    await cleanupUpload();
    return res.status(400).json({ error: invalido });
  }
  const doc = {
    id: uuidv4(), ...fields.value,
    url: req.file ? '/uploads/' + req.file.filename : null,
    created_at: new Date(),
    ...agendamento
  };
  try {
    await db.slides.insert(doc);
  } catch (error) {
    await cleanupUpload();
    throw error;
  }
  res.json(doc);
});

// Edita texto/duracao e, principalmente, o agendamento de um slide ja existente
// (ex: colocar prazo num video de evento sem precisar reenviar o arquivo).
app.put('/api/slides/:id', async (req, res) => {
  const current = await db.slides.findOne({ id: req.params.id });
  if (!current) return res.status(404).json({ error: 'Slide não encontrado' });
  const fields = validateSlideInput(req.body, { partial: true, current });
  if (fields.error) return res.status(400).json({ error: fields.error });
  const set = scheduleFromBody(req.body);
  const invalido = validarAgendamento(set, req.body);
  if (invalido) return res.status(400).json({ error: invalido });
  Object.assign(set, fields.value);
  const affected = await db.slides.update({ id: req.params.id }, { $set: set });
  const atualizado = await db.slides.findOne({ id: req.params.id });
  res.json({ ok: true, status: slideStatus(atualizado) });
});

app.delete('/api/slides/:id', async (req, res) => {
  const slide = await db.slides.findOne({ id: req.params.id });
  if (!slide) return res.status(404).json({ error: 'Slide não encontrado' });
  await db.gslides.remove({ slide_id: req.params.id }, { multi: true });
  await db.slides.remove({ id: req.params.id }, {});
  const mediaPath = uploadedPathFromUrl(slide.url, uploadsDir);
  if (mediaPath) {
    try {
      await removeFile(mediaPath);
    } catch (error) {
      log('ERRO', 'não foi possível remover mídia órfã', { slide: slide.id, msg: error.message });
    }
  }
  res.json({ ok: true });
});

// ── PLAYLIST DO GRUPO ────────────────────────────────────
app.get('/api/groups/:id/slides', async (req, res) => {
  const gs = await db.gslides.find({ group_id: req.params.id }).sort({ position: 1 });
  const slides = await Promise.all(gs.map(g => db.slides.findOne({ id: g.slide_id })));
  res.json(slides.filter(Boolean));
});

app.post('/api/groups/:id/slides', async (req, res) => {
  const { slide_id } = req.body;
  const [group, slide] = await Promise.all([
    db.groups.findOne({ id: req.params.id }),
    db.slides.findOne({ id: slide_id })
  ]);
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!slide) return res.status(404).json({ error: 'Slide não encontrado' });
  const exists = await db.gslides.findOne({ group_id: req.params.id, slide_id });
  if (exists) return res.status(400).json({ error: 'Slide já na playlist' });
  const all = await db.gslides.find({ group_id: req.params.id });
  await db.gslides.insert({ group_id: req.params.id, slide_id, position: all.length + 1 });
  res.json({ ok: true });
});

app.delete('/api/groups/:id/slides/:slide_id', async (req, res) => {
  await db.gslides.remove({ group_id: req.params.id, slide_id: req.params.slide_id }, {});
  res.json({ ok: true });
});

// ── TELAS ────────────────────────────────────────────────
app.get('/api/screens', async (req, res) => {
  const screens = await db.screens.find({}).sort({ name: 1 });
  res.json(screens);
});

app.post('/api/screens', async (req, res) => {
  const fields = validateScreenInput(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const group = await db.groups.findOne({ id: fields.value.group_id });
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  const slug = await db.uniqueSlug(fields.value.name);
  const doc = { id: slug, ...fields.value, last_seen: null, created_at: new Date() };
  await db.screens.insert(doc);
  res.json(doc);
});

app.put('/api/screens/:id', async (req, res) => {
  const fields = validateScreenInput(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const group = await db.groups.findOne({ id: fields.value.group_id });
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  const affected = await db.screens.update({ id: req.params.id }, { $set: fields.value });
  if (!affected) return res.status(404).json({ error: 'Tela não encontrada' });
  res.json({ ok: true });
});

app.delete('/api/screens/:id', async (req, res) => {
  const removed = await db.screens.remove({ id: req.params.id }, {});
  if (!removed) return res.status(404).json({ error: 'Tela não encontrada' });
  res.json({ ok: true });
});

// ── PLAYER API ────────────────────────────────────────────
app.get('/api/player/:slug', async (req, res) => {
  const screen = await db.screens.findOne({ id: req.params.slug });
  if (!screen) return res.status(404).json({ error: 'Tela não encontrada' });
  const gs = await db.gslides.find({ group_id: screen.group_id }).sort({ position: 1 });
  const slides = await Promise.all(gs.map(g => db.slides.findOne({ id: g.slide_id })));
  const now = new Date();
  const activeSlides = slides
    .filter(Boolean)
    .filter(slide => slideActive(slide, now))
    .map(slide => Object.assign({}, slide, {
      url: uploadedPathFromUrl(slide.url, uploadsDir) ? slide.url : null,
      cache_for_ms: activeForMs(slide, now)
    }));
  res.json({ screen, slides: activeSlides, server_time: now.toISOString() });
});

// Registra no log quando uma tela aparece ou volta depois de sumir, para dar
// para investigar queda de TV sem gerar uma linha a cada 20 segundos.
const OFFLINE_MS = 60000;
const lastBeat = new Map();

app.post('/api/heartbeat', async (req, res) => {
  const { screen_id } = req.body;
  if (!screen_id || typeof screen_id !== 'string') {
    return res.status(400).json({ error: 'Tela obrigatória' });
  }
  const screen = await db.screens.findOne({ id: screen_id });
  if (!screen) return res.status(404).json({ error: 'Tela não encontrada' });
  const now = Date.now();
  const previous = lastBeat.get(screen_id);
  if (!previous) log('INFO', 'tela conectou', { screen: screen_id });
  else if (now - previous > OFFLINE_MS) {
    log('INFO', 'tela reconectou', { screen: screen_id, fora_s: Math.round((now - previous) / 1000) });
  }
  lastBeat.set(screen_id, now);
  await db.screens.update({ id: screen_id }, { $set: { last_seen: new Date().toISOString() } });
  res.json({ ok: true, ts: Date.now() });
});

// ── PROGRAMAÇÃO ───────────────────────────────────────────
// Responde "o que esta no ar, em qual tela, e o que esta oculto por que".
// Usado pela Visao geral do painel.
app.get('/api/programacao', async (req, res) => {
  const now = new Date();
  // Quatro consultas no total, independente de quantas telas existirem: o
  // cruzamento e feito em memoria. Evita repetir consulta por tela.
  const [screens, groups, vinculos, todosSlides] = await Promise.all([
    db.screens.find({}).sort({ name: 1 }),
    db.groups.find({}),
    db.gslides.find({}),
    db.slides.find({})
  ]);

  const slidePorId = new Map(todosSlides.map(s => [s.id, s]));
  const playlistPorGrupo = new Map();
  vinculos
    .slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0))
    .forEach(v => {
      const slide = slidePorId.get(v.slide_id);
      if (!slide) return;
      if (!playlistPorGrupo.has(v.group_id)) playlistPorGrupo.set(v.group_id, []);
      playlistPorGrupo.get(v.group_id).push(slide);
    });

  res.json(screens.map(screen => {
    const grupo = groups.find(g => g.id === screen.group_id);
    const itens = (playlistPorGrupo.get(screen.group_id) || []).map(s => ({
      id: s.id,
      title: s.title || (s.type === 'vid' ? 'Vídeo' : s.type === 'img' ? 'Imagem' : 'Slide sem título'),
      type: s.type,
      status: slideStatus(s, now)
    }));
    return {
      screen_id: screen.id,
      screen_name: screen.name,
      group_name: grupo ? grupo.name : 'Sem grupo',
      online: !!screen.last_seen && (now - new Date(screen.last_seen)) < 60000,
      no_ar: itens.filter(i => i.status.active),
      ocultos: itens.filter(i => !i.status.active)
    };
  }));
});

// ── SAÚDE ─────────────────────────────────────────────────
// Consulta barata (count numa colecao ja carregada em memoria pelo NeDB).
// Serve para conferir de fora se o servico esta de pe apos reboot/atualizacao.
app.get('/health', async (req, res) => {
  try {
    const screens = await db.screens.count({});
    res.json({
      status: 'ok',
      uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
      screens,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: 'banco indisponivel' });
  }
});

// ── HTML ──────────────────────────────────────────────────
app.get('/player/:slug', (req, res) => res.sendFile(path.join(__dirname, '../public/player/index.html')));
app.get('/painel', (req, res) => res.sendFile(path.join(__dirname, '../public/painel/index.html')));
app.get('/', (req, res) => res.redirect('/painel'));

// ── ERRO ──────────────────────────────────────────────────
// Ultimo middleware: registra o erro completo no log e devolve mensagem
// generica, sem stack trace, para quem chamou. Mantem o processo vivo.
app.use((err, req, res, next) => {
  // Erro que ja traz codigo 4xx veio do proprio Express (Range invalido, URL
  // malformada). E falha de quem chamou, nao do servidor: devolve o codigo
  // certo (ex.: 416) e nao polui o log. So 5xx vira "erro interno".
  const codigo = err && (err.status || err.statusCode);
  const doCliente = Number.isInteger(codigo) && codigo >= 400 && codigo < 500;

  if (!doCliente) {
    log('ERRO', 'falha ao tratar requisicao', {
      method: req.method, path: req.originalUrl, msg: err && err.message
    });
    if (err && err.stack) console.error(err.stack);
  }

  if (res.headersSent) return next(err);
  res.status(doCliente ? codigo : 500)
     .json({ error: doCliente ? (err.message || 'Requisição inválida') : 'Erro interno no servidor' });
});

let server = null;

function startServer(port = PORT) {
  if (server) return server;
  server = app.listen(port, () => {
    const actualPort = server.address().port;
    log('INFO', 'CorporTV iniciado', { porta: actualPort, pid: process.pid });
    console.log(`\n🖥️  CorporTV rodando em http://localhost:${actualPort}`);
    console.log(`   Painel : http://localhost:${actualPort}/painel`);
    console.log(`   Player : http://localhost:${actualPort}/player/<slug-da-tela>\n`);
  });
  return server;
}

// Encerramento gracioso: para de aceitar conexoes e deixa as respostas em
// andamento terminarem antes de sair (evita cortar o download de um video).
function shutdown(signal, exitProcess = true) {
  log('INFO', 'encerrando', { signal });
  if (!server) {
    db.stopMaintenance();
    if (exitProcess) process.exit(0);
    return;
  }
  server.close(() => {
    server = null;
    db.stopMaintenance();
    if (exitProcess) process.exit(0);
  });
  if (exitProcess) setTimeout(() => process.exit(0), 10000).unref();
}

// Rede de seguranca. Com as rotas ja encaminhando erros para o middleware
// acima, cair aqui indica falha inesperada: registra e sai com codigo != 0
// para a tarefa agendada reiniciar o servico em vez de ficar num estado ruim.
function registerProcessHandlers() {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', reason => {
    log('ERRO', 'unhandledRejection', { msg: reason && reason.message ? reason.message : String(reason) });
  });
  process.on('uncaughtException', err => {
    log('ERRO', 'uncaughtException - encerrando para reiniciar', { msg: err.message });
    console.error(err.stack);
    process.exit(1);
  });
}

if (require.main === module) {
  startServer();
  registerProcessHandlers();
}

module.exports = { app, shutdown, startServer };
