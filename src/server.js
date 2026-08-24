const express = require('express');
const path = require('path');
const fs = require('fs');
const { Transform } = require('stream');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const { createAudit } = require('./audit');
const { createAuth } = require('./auth');
const { validateGroupInput, validateScreenInput } = require('./validation');
const {
  acceptsUpload,
  inspectStoredUpload,
  removeFile,
  uploadedPathFromUrl
} = require('./uploads');

const app = express();
if (process.env.CORPTV_TRUST_PROXY === '1') app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();
// Os caminhos configuráveis permitem testar a aplicação contra uma cópia
// descartável dos dados, sem tocar no banco, nos uploads ou nos logs reais.
const uploadsDir = path.resolve(process.env.CORPTV_UPLOADS_DIR || path.join(__dirname, '../public/uploads'));
const logDir = path.resolve(process.env.CORPTV_LOG_DIR || path.join(__dirname, '../logs'));
const accessLog = path.join(logDir, 'corptv-media-access.log');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const mediaRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(Number(process.env.CORPTV_MEDIA_REQUESTS_PER_MINUTE), 600),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const pageRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(Number(process.env.CORPTV_PAGE_REQUESTS_PER_MINUTE), 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

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
  req.requestId = uuidv4();
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Request-Id': req.requestId,
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  });
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Não atende a API enquanto os quatro bancos ainda estiverem carregando.
  Promise.resolve(db.ready).then(() => next(), next);
});
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// Autenticacao protege apenas o painel e a API de gestao. Player, heartbeat,
// midias e health continuam publicos para as TV boxes funcionarem sem conta.
const audit = createAudit(db);
const auth = createAuth({
  app, db, audit, log,
  setupCodeFile: path.join(logDir, 'corptv-setup-code.txt')
});
app.use('/api', auth.requireManagementApi);
app.use('/api', auth.auditManagementMutation);

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

// ── ENTREGA DE MÍDIA COM RITMO CONTROLADO ────────────────
// O navegador da TV nao baixa o video na velocidade da reproducao (~2,9 Mb/s):
// baixa o mais rapido que a rede permitir. Medimos UMA tela puxando 11,7 Mb/s,
// o arquivo inteiro em 76 segundos. Esse pico e o que assusta a rede.
//
// Aqui a entrega e paginada no tempo: manda um pouco mais rapido que a
// reproducao, o suficiente para o buffer encher com folga, sem rajada. O QoS
// da maquina continua sendo a rede de seguranca do total; isto controla cada
// conexao individualmente.
//
// Ajustavel sem mexer no codigo: CORPTV_LIMITE_MBPS (0 = sem limite).
const LIMITE_MBPS = process.env.CORPTV_LIMITE_MBPS !== undefined
  ? parseFloat(process.env.CORPTV_LIMITE_MBPS)
  : 4.5; // ~1,5x a taxa do video de 2,9 Mb/s
const LIMITE_BYTES_S = Math.round((LIMITE_MBPS * 1e6) / 8);

const TIPOS = {
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp'
};

// Deixa passar no maximo `bytesPorSegundo`, em fatias de 100ms. Fatias curtas
// evitam que a TV veja a conexao "parada" e desista.
function limitador(bytesPorSegundo) {
  const JANELA = 100;
  const cota = Math.max(1024, Math.round(bytesPorSegundo * JANELA / 1000));
  let usado = 0;
  let inicio = Date.now();
  return new Transform({
    transform(pedaco, _enc, pronto) {
      const enviar = (buf) => {
        if (!buf.length) return pronto();
        const agora = Date.now();
        if (agora - inicio >= JANELA) { inicio = agora; usado = 0; }
        const espaco = cota - usado;
        if (espaco <= 0) {
          setTimeout(() => enviar(buf), Math.max(1, JANELA - (agora - inicio)));
          return;
        }
        const fatia = buf.subarray(0, espaco);
        usado += fatia.length;
        this.push(fatia);
        const resto = buf.subarray(fatia.length);
        if (resto.length) setTimeout(() => enviar(resto), Math.max(1, JANELA - (Date.now() - inicio)));
        else pronto();
      };
      enviar(pedaco);
    }
  });
}

app.get('/uploads/:arquivo', mediaRequestLimiter, (req, res, next) => {
  // Impede sair da pasta de uploads (path traversal) com nome manipulado.
  const nome = path.basename(req.params.arquivo);
  const caminho = path.join(uploadsDir, nome);
  const ext = path.extname(nome).toLowerCase();
  if (!TIPOS[ext]) return next();

  fs.stat(caminho, (erro, info) => {
    if (erro || !info.isFile()) return next();

    const etag = 'W/"' + info.size.toString(16) + '-' + info.mtimeMs.toString(16) + '"';
    const modificado = info.mtime.toUTCString();

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', TIPOS[ext]);
    // Nomes de upload sao UUID e nunca mudam: a TV baixa uma vez por mes.
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', modificado);

    if (req.headers['if-none-match'] === etag ||
        (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(modificado))) {
      return res.status(304).end();
    }

    let inicio = 0;
    let fim = info.size - 1;
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', 'bytes */' + info.size);
        return res.status(416).end();
      }
      if (m[1] === '') {
        const ultimos = parseInt(m[2], 10);
        if (!ultimos) { res.setHeader('Content-Range', 'bytes */' + info.size); return res.status(416).end(); }
        inicio = Math.max(0, info.size - ultimos);
      } else {
        inicio = parseInt(m[1], 10);
        if (m[2] !== '') fim = Math.min(parseInt(m[2], 10), info.size - 1);
      }
      if (isNaN(inicio) || isNaN(fim) || inicio > fim || inicio >= info.size) {
        res.setHeader('Content-Range', 'bytes */' + info.size);
        return res.status(416).end();
      }
      res.status(206).setHeader('Content-Range', 'bytes ' + inicio + '-' + fim + '/' + info.size);
    }

    const tamanho = fim - inicio + 1;
    res.setHeader('Content-Length', tamanho);
    if (req.method === 'HEAD') return res.end();

    const leitura = fs.createReadStream(caminho, { start: inicio, end: fim });
    const encerrar = () => { leitura.destroy(); };
    res.on('close', encerrar);
    leitura.on('error', () => { encerrar(); res.destroy(); });

    if (LIMITE_BYTES_S > 0) leitura.pipe(limitador(LIMITE_BYTES_S)).pipe(res);
    else leitura.pipe(res);
  });
});
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
    fields: 12,
    parts: 14,
    fieldNameSize: 64,
    fieldSize: 2048
  },
  fileFilter: (req, file, cb) => {
    if (allowedExtensions.has(path.extname(file.originalname).toLowerCase()) && acceptsUpload(file)) {
      return cb(null, true);
    }
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
      return Promise.resolve(req.file && removeFile(req.file.path, uploadsDir)).catch(error => {
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
  const fields = validateGroupInput(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const doc = { id: uuidv4(), ...fields.value, created_at: new Date() };
  await db.groups.insert(doc);
  res.json(doc);
});

app.put('/api/groups/:id', async (req, res) => {
  const fields = validateGroupInput(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const affected = await db.groups.update({ id: req.params.id }, { $set: fields.value });
  if (!affected) return res.status(404).json({ error: 'Ambiente não encontrado' });
  res.json({ ok: true });
});

app.delete('/api/groups/:id', async (req, res) => {
  const group = await db.groups.findOne({ id: req.params.id });
  if (!group) return res.status(404).json({ error: 'Ambiente não encontrado' });
  const screens = await db.screens.find({ group_id: req.params.id });
  if (screens.length) return res.status(400).json({ error: 'Mova as telas antes de remover o grupo' });
  await db.gslides.remove({ group_id: req.params.id }, { multi: true });
  await db.groups.remove({ id: req.params.id }, {});
  res.json({ ok: true });
});

// ── AGENDAMENTO DOS SLIDES ────────────────────────────────
// Cada slide pode ter uma janela de exibicao opcional. Sem nenhum campo
// preenchido o slide aparece sempre (comportamento antigo, retrocompativel).
//   starts_at / expires_at : data-hora ISO. Fora da faixa, o slide some da tela.
//   days       : dias da semana (0=domingo ... 6=sabado). Vazio = todos os dias.
//   time_start / time_end  : faixa de horario "HH:MM". Se o fim for menor que o
//                            inicio, entende-se que a faixa cruza a meia-noite.
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function parseDays(value) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr.map(v => parseInt(v, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 6);
}

// Converte para ISO com seguranca: data vazia ou invalida vira null (sem
// agendamento) em vez de derrubar a requisicao com "Invalid time value".
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Interpreta a data SEMPRE no fuso do servidor. Cuidado: new Date('2026-08-14')
// no JavaScript vale meia-noite UTC, que aqui cai no dia 13 as 21h. Por isso a
// data e montada campo a campo.
//   fimDoDia=false -> 00:00:00 do dia (inicio da janela)
//   fimDoDia=true  -> 23:59:59 do dia (fim da janela, o dia inteiro conta)
// Aceita 'AAAA-MM-DD' (formato novo, so data) e 'AAAA-MM-DDTHH:MM' (dados antigos).
function parseDataLocal(valor, fimDoDia) {
  if (!valor) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(valor));
  if (!m) {
    const solto = new Date(valor);
    return isNaN(solto.getTime()) ? null : solto.toISOString();
  }
  const [, ano, mes, dia, hora, min] = m;
  const d = hora !== undefined
    ? new Date(+ano, +mes - 1, +dia, +hora, +min, 0, 0)
    : fimDoDia
      ? new Date(+ano, +mes - 1, +dia, 23, 59, 59, 999)
      : new Date(+ano, +mes - 1, +dia, 0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function scheduleFromBody(body = {}) {
  return {
    starts_at: parseDataLocal(body.starts_at, false),
    expires_at: parseDataLocal(body.expires_at, true),
    days: parseDays(body.days),
    time_start: body.time_start || null,
    time_end: body.time_end || null
  };
}

// Extrai os campos de agenda de um vinculo conteudo<->ambiente, com padroes.
function agendaDoVinculo(v) {
  return {
    starts_at: v.starts_at || null,
    expires_at: v.expires_at || null,
    days: Array.isArray(v.days) ? v.days : [],
    time_start: v.time_start || null,
    time_end: v.time_end || null
  };
}

function temAgenda(a) {
  return !!(a && (a.starts_at || a.expires_at || (a.days && a.days.length) || a.time_start || a.time_end));
}

// Fonte unica da regra de calendario. Devolve o motivo de o slide estar oculto
// para o painel poder explicar ao usuario, em vez de a tela sumir sem aviso.
// Retorna { active: bool, reason: string|null }.
const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function statusAgenda(a, now) {
  now = now || new Date();

  if (a.starts_at && now < new Date(a.starts_at)) {
    return { active: false, reason: 'aguardando', detail: 'ainda não chegou a data de início' };
  }
  if (a.expires_at && now > new Date(a.expires_at)) {
    return { active: false, reason: 'expirado', detail: 'o prazo já passou' };
  }
  if (Array.isArray(a.days) && a.days.length && a.days.indexOf(now.getDay()) === -1) {
    const nomes = a.days.slice().sort((x, y) => x - y).map(d => DIAS_CURTOS[d]).join('/');
    return { active: false, reason: 'fora_do_dia', detail: 'só toca ' + nomes };
  }
  const start = toMinutes(a.time_start);
  const end = toMinutes(a.time_end);
  if (start !== null && end !== null) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const dentro = start <= end
      ? (mins >= start && mins <= end)
      : (mins >= start || mins <= end); // faixa que cruza a meia-noite (22:00-06:00)
    if (!dentro) {
      return { active: false, reason: 'fora_do_horario', detail: 'só toca das ' + a.time_start + ' às ' + a.time_end };
    }
  }
  return { active: true, reason: null, detail: null };
}

// Recusa combinacoes que nunca tocariam, para o conteudo nao sumir da tela sem
// explicacao. Com data sem hora, "de 14/08 ate 14/08" e valido e significa
// "so nesse dia" (00:00 as 23:59).
function validarAgendamento(a) {
  if (a.starts_at && a.expires_at && new Date(a.expires_at) < new Date(a.starts_at)) {
    return 'A data de expiração é anterior à data de início.';
  }
  const ts = toMinutes(a.time_start);
  const te = toMinutes(a.time_end);
  if (a.time_start && !a.time_end) return 'Informe também o horário de fim.';
  if (a.time_end && !a.time_start) return 'Informe também o horário de início.';
  if (ts !== null && te !== null && ts === te) {
    return 'O horário de início e de fim são iguais: o conteúdo nunca apareceria.';
  }
  return null;
}

// ── CONTEÚDO (biblioteca) ────────────────────────────────
// O agendamento NAO mora aqui: ele vive no vinculo conteudo<->ambiente, porque
// o mesmo video pode ter prazos diferentes em cada lugar.
app.get('/api/slides', async (req, res) => {
  const slides = await db.slides.find({}).sort({ created_at: -1 });
  const vinculos = await db.gslides.find({});
  const usos = new Map();
  vinculos.forEach(v => usos.set(v.slide_id, (usos.get(v.slide_id) || 0) + 1));
  res.json(slides.map(s => Object.assign({}, s, { em_uso: usos.get(s.id) || 0 })));
});

// Sem titulo, o painel mostrava tudo como "vid" e ficava impossivel distinguir
// dois videos. Na falta de titulo, usa o nome do arquivo enviado.
function tituloPadrao(title, file) {
  if (title && title.trim()) return title.trim();
  if (!file || !file.originalname) return '';
  return file.originalname.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
}

const VIDEO_TEXT_MODES = new Set(['none', 'fixed', 'timed']);
function textoDoVideo(body, type, current) {
  if (type !== 'vid') return { video_text_mode: 'none', video_text_seconds: 0 };
  const mode = body.video_text_mode === undefined
    ? ((current && current.video_text_mode) || 'fixed')
    : body.video_text_mode;
  if (!VIDEO_TEXT_MODES.has(mode)) return { error: 'Modo do texto do vídeo inválido.' };
  if (mode !== 'timed') return { video_text_mode: mode, video_text_seconds: 0 };
  const seconds = parseInt(
    body.video_text_seconds === undefined
      ? ((current && current.video_text_seconds) || 5)
      : body.video_text_seconds,
    10
  );
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    return { error: 'O texto temporário deve ficar entre 1 e 300 segundos.' };
  }
  return { video_text_mode: mode, video_text_seconds: seconds };
}

app.post('/api/slides', handleUpload, async (req, res) => {
  const fields = req.body || {};
  const { title, body, type, duration, bg } = fields;
  const cleanupUpload = () => req.file && removeFile(req.file.path, uploadsDir);
  let uploadedType = null;
  if (req.file) {
    let inspection;
    try {
      inspection = await inspectStoredUpload(req.file.path, req.file, uploadsDir);
    } catch (error) {
      await cleanupUpload();
      throw error;
    }
    if (!inspection.ok) {
      await cleanupUpload();
      return res.status(415).json({ error: inspection.error });
    }
    uploadedType = inspection.type;
  }
  if (!title && !req.file) return res.status(400).json({ error: 'Título ou arquivo obrigatório' });
  const slideType = uploadedType || type || 'txt';
  const videoText = textoDoVideo(fields, slideType);
  if (videoText.error) {
    await cleanupUpload();
    return res.status(400).json({ error: videoText.error });
  }
  const doc = {
    id: uuidv4(), title: tituloPadrao(title, req.file), body: body || '',
    type: slideType, duration: slideType === 'vid' ? 0 : (parseInt(duration) || 8),
    bg: bg || '#111111', url: req.file ? '/uploads/' + req.file.filename : null,
    created_at: new Date(),
    video_text_mode: videoText.video_text_mode,
    video_text_seconds: videoText.video_text_seconds
  };
  try {
    await db.slides.insert(doc);
  } catch (error) {
    await cleanupUpload();
    throw error;
  }
  res.json(doc);
});

// Edita apenas o conteudo. Para mudar quando ele toca, use a rota de agenda do
// ambiente (PUT /api/groups/:gid/slides/:sid).
app.put('/api/slides/:id', async (req, res) => {
  const current = await db.slides.findOne({ id: req.params.id });
  if (!current) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  const body = req.body || {};
  const set = {};
  if (body.title !== undefined) set.title = body.title;
  if (body.body !== undefined) set.body = body.body;
  if (body.duration !== undefined) set.duration = parseInt(body.duration) || 8;
  if (body.bg !== undefined) set.bg = body.bg;
  if (body.video_text_mode !== undefined || body.video_text_seconds !== undefined) {
    const videoText = textoDoVideo(body, current.type, current);
    if (videoText.error) return res.status(400).json({ error: videoText.error });
    set.video_text_mode = videoText.video_text_mode;
    set.video_text_seconds = videoText.video_text_seconds;
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nada para alterar' });
  const affected = await db.slides.update({ id: req.params.id }, { $set: set });
  res.json({ ok: true });
});

app.delete('/api/slides/:id', async (req, res) => {
  const slide = await db.slides.findOne({ id: req.params.id });
  if (!slide) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  await db.gslides.remove({ slide_id: req.params.id }, { multi: true });
  await db.slides.remove({ id: req.params.id }, {});
  const mediaPath = uploadedPathFromUrl(slide.url, uploadsDir);
  if (mediaPath) {
    try {
      await removeFile(mediaPath, uploadsDir);
    } catch (error) {
      log('ERRO', 'não foi possível remover mídia órfã', { slide: slide.id, msg: error.message });
    }
  }
  res.json({ ok: true });
});

// ── PROGRAMAÇÃO DO AMBIENTE ──────────────────────────────
// Cada item devolve o conteudo + a agenda daquele ambiente + o status agora.
app.get('/api/groups/:id/slides', async (req, res) => {
  const vinculos = await db.gslides.find({ group_id: req.params.id }).sort({ position: 1 });
  const now = new Date();
  const itens = await Promise.all(vinculos.map(async v => {
    const s = await db.slides.findOne({ id: v.slide_id });
    if (!s) return null;
    const agenda = agendaDoVinculo(v);
    return Object.assign({}, s, agenda, {
      agendado: temAgenda(agenda),
      status: statusAgenda(agenda, now)
    });
  }));
  res.json(itens.filter(Boolean));
});

app.post('/api/groups/:id/slides', async (req, res) => {
  const body = req.body || {};
  const { slide_id } = body;
  const grupo = await db.groups.findOne({ id: req.params.id });
  if (!grupo) return res.status(404).json({ error: 'Ambiente não encontrado' });
  const slide = await db.slides.findOne({ id: slide_id });
  if (!slide) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  const exists = await db.gslides.findOne({ group_id: req.params.id, slide_id });
  if (exists) return res.status(400).json({ error: 'Este conteúdo já está no ambiente' });

  const agenda = scheduleFromBody(body);
  const invalido = validarAgendamento(agenda);
  if (invalido) return res.status(400).json({ error: invalido });

  const all = await db.gslides.find({ group_id: req.params.id });
  await db.gslides.insert(Object.assign(
    { group_id: req.params.id, slide_id, position: all.length + 1 },
    agenda
  ));
  log('INFO', 'conteudo adicionado ao ambiente', {
    ambiente: grupo.name, conteudo: slide.title || slide.type, agendado: temAgenda(agenda)
  });
  res.json({ ok: true, status: statusAgenda(agenda) });
});

// Define QUANDO este conteudo toca NESTE ambiente. E a rota que sustenta o
// "agendar para um lugar": o mesmo video pode ter prazos diferentes em cada um.
app.put('/api/groups/:gid/slides/:sid', async (req, res) => {
  const vinculo = await db.gslides.findOne({ group_id: req.params.gid, slide_id: req.params.sid });
  if (!vinculo) return res.status(404).json({ error: 'Conteúdo não está neste ambiente' });

  const agenda = scheduleFromBody(req.body || {});
  const invalido = validarAgendamento(agenda);
  if (invalido) return res.status(400).json({ error: invalido });

  await db.gslides.update({ _id: vinculo._id }, { $set: agenda });
  const status = statusAgenda(agenda);
  log('INFO', 'agenda alterada', {
    ambiente: req.params.gid, conteudo: req.params.sid,
    agendado: temAgenda(agenda), no_ar: status.active
  });
  res.json({ ok: true, status });
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
  const fields = validateScreenInput(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const group = await db.groups.findOne({ id: fields.value.group_id });
  if (!group) return res.status(404).json({ error: 'Ambiente não encontrado' });
  const slug = await db.uniqueSlug(fields.value.name);
  const doc = { id: slug, ...fields.value, last_seen: null, created_at: new Date() };
  await db.screens.insert(doc);
  res.json(doc);
});

app.put('/api/screens/:id', async (req, res) => {
  const fields = validateScreenInput(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const group = await db.groups.findOne({ id: fields.value.group_id });
  if (!group) return res.status(404).json({ error: 'Ambiente não encontrado' });
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
  const vinculos = await db.gslides.find({ group_id: screen.group_id }).sort({ position: 1 });
  const now = new Date();
  const itens = await Promise.all(vinculos.map(async v => {
    if (!statusAgenda(agendaDoVinculo(v), now).active) return null;
    return db.slides.findOne({ id: v.slide_id });
  }));
  res.json({ screen, slides: itens.filter(Boolean) });
});

// Registra no log quando uma tela aparece ou volta depois de sumir, para dar
// para investigar queda de TV sem gerar uma linha a cada 20 segundos.
const OFFLINE_MS = 60000;
const lastBeat = new Map();

app.post('/api/heartbeat', async (req, res) => {
  const { screen_id } = req.body || {};
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
      // O status vem da agenda DAQUELE ambiente, nao do conteudo em si.
      const agenda = agendaDoVinculo(v);
      playlistPorGrupo.get(v.group_id).push({
        id: slide.id,
        title: slide.title || (slide.type === 'vid' ? 'Vídeo' : slide.type === 'img' ? 'Imagem' : 'Sem título'),
        type: slide.type,
        agendado: temAgenda(agenda),
        status: statusAgenda(agenda, now)
      });
    });

  res.json(screens.map(screen => {
    const grupo = groups.find(g => g.id === screen.group_id);
    const itens = playlistPorGrupo.get(screen.group_id) || [];
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
    await db.ready;
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
app.get('/player/:slug', pageRequestLimiter, (req, res) => res.sendFile(path.join(__dirname, '../public/player/index.html')));
app.use('/painel', pageRequestLimiter, (req, res, next) => {
  Promise.resolve(auth.requirePanelPage(req, res, next)).catch(next);
});
app.get(['/painel', '/painel/', '/painel/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/painel/index.html'));
});
app.get('/', (req, res) => res.redirect('/painel'));
app.use(express.static(path.join(__dirname, '../public')));

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

// ── MIGRAÇÃO ──────────────────────────────────────────────
// O agendamento passou a viver no vinculo conteudo<->ambiente. Antes ele ficava
// no proprio slide e valia em todo lugar. Esta rotina copia o que existia para
// cada ambiente onde o conteudo esta e limpa o campo antigo. Roda uma vez: na
// segunda execucao nao ha mais nada com agenda no slide e ela nao faz nada.
async function migrarAgendaParaVinculos() {
  const slides = await db.slides.find({});
  const antigos = slides.filter(temAgenda);
  if (!antigos.length) return;

  let vinculosAtualizados = 0;
  for (const s of antigos) {
    const vinculos = await db.gslides.find({ slide_id: s.id });
    for (const v of vinculos) {
      if (temAgenda(agendaDoVinculo(v))) continue; // ja tem agenda propria: preserva
      await db.gslides.update({ _id: v._id }, {
        $set: {
          starts_at: s.starts_at || null,
          expires_at: s.expires_at || null,
          days: Array.isArray(s.days) ? s.days : [],
          time_start: s.time_start || null,
          time_end: s.time_end || null
        }
      });
      vinculosAtualizados++;
    }
    await db.slides.update({ id: s.id }, {
      $unset: { starts_at: true, expires_at: true, days: true, time_start: true, time_end: true }
    });
  }
  log('INFO', 'agenda migrada para os ambientes', {
    conteudos: antigos.length, vinculos: vinculosAtualizados
  });
}

// Importar este módulo não abre uma porta. Isso permite testar a aplicação em
// processo isolado; somente `node src/server.js` chama iniciar().
function iniciar() {
  const server = app.listen(PORT, async () => {
    try {
      await db.ready;
      await migrarAgendaParaVinculos();
    } catch (err) {
      log('ERRO', 'falha na migracao da agenda', { msg: err.message });
    }
    log('INFO', 'CorporTV iniciado', { porta: PORT, pid: process.pid });
    console.log(`\n🖥️  CorporTV rodando em http://localhost:${PORT}`);
    console.log(`   Painel : http://localhost:${PORT}/painel`);
    console.log(`   Player : http://localhost:${PORT}/player/<slug-da-tela>\n`);
  });

  // Encerramento gracioso: para de aceitar conexoes e deixa as respostas em
  // andamento terminarem antes de sair (evita cortar o download de um video).
  function shutdown(signal) {
    log('INFO', 'encerrando', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Erros inesperados ficam registrados; exceções não capturadas encerram o
  // processo para que a tarefa agendada e o watchdog façam a recuperação.
  process.on('unhandledRejection', reason => {
    log('ERRO', 'unhandledRejection', { msg: reason && reason.message ? reason.message : String(reason) });
  });
  process.on('uncaughtException', err => {
    log('ERRO', 'uncaughtException - encerrando para reiniciar', { msg: err.message });
    console.error(err.stack);
    process.exit(1);
  });

  return server;
}

if (require.main === module) iniciar();

module.exports = { app, iniciar };
