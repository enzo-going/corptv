const express = require('express');
const path = require('path');
const fs = require('fs');
const { Transform } = require('stream');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { chaveDeLimite } = require('./security');
const db = require('./db');
const { createAudit } = require('./audit');
const { createAuth } = require('./auth');
const { validateGroupInput, validateScreenInput, validateSlideInput } = require('./validation');
const scheduling = require('./scheduling');
const video = require('./video');
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
  legacyHeaders: false, keyGenerator: chaveDeLimite
});
const pageRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(Number(process.env.CORPTV_PAGE_REQUESTS_PER_MINUTE), 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false, keyGenerator: chaveDeLimite
});
const playerRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(Number(process.env.CORPTV_PLAYER_REQUESTS_PER_MINUTE), 120),
  standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: chaveDeLimite
});
const heartbeatRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveInteger(Number(process.env.CORPTV_HEARTBEAT_REQUESTS_PER_MINUTE), 120),
  standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: chaveDeLimite
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

// Vídeo pesado (o real: 641 MB, 4 min) é aceito e otimizado aqui mesmo para o padrão
// das TVs. Sem o ffmpeg no servidor não há como otimizar: o limite volta aos 200 MB
// de antes, para nenhum vídeo bruto chegar às telas.
const videoTools = video.localizarFerramentas(process.env, path.join(__dirname, '..'));
const LIMITE_UPLOAD_MB = videoTools ? positiveInteger(Number(process.env.CORPTV_LIMITE_UPLOAD_MB), 2048) : 200;
const filaVideo = videoTools && video.criarFila({
  ferramentas: videoTools,
  uploadsDir,
  db,
  log,
  novoNome: () => uuidv4() + '.mp4',
  caminhoDaUrl: url => uploadedPathFromUrl(url, uploadsDir),
  removerArquivo: arquivo => removeFile(arquivo, uploadsDir),
  threads: positiveInteger(Number(process.env.CORPTV_FFMPEG_THREADS), 2),
  preset: /^(ultrafast|superfast|veryfast|faster|fast|medium)$/.test(process.env.CORPTV_FFMPEG_PRESET || '')
    ? process.env.CORPTV_FFMPEG_PRESET : 'veryfast',
  limiteMs: 2 * 60 * 60 * 1000
});
log('INFO', videoTools ? 'otimização de vídeo ligada' : 'otimização de vídeo desligada (ffmpeg não encontrado)', {
  ffmpeg: videoTools ? videoTools.ffmpeg : null, limite_upload_mb: LIMITE_UPLOAD_MB
});

// Conteúdo que ainda não pode ir para as TVs: vídeo sendo otimizado ou que falhou.
function emPreparo(slide) {
  return !!(slide && slide.otimizacao && slide.otimizacao.estado !== 'pronto');
}
const STATUS_PREPARO = {
  otimizando: { active: false, reason: 'otimizando', detail: 'o vídeo está sendo otimizado para as TVs' },
  falhou: { active: false, reason: 'falhou', detail: 'não foi possível otimizar o vídeo' }
};
function statusDoConteudo(slide, agenda, now) {
  return emPreparo(slide) ? (STATUS_PREPARO[slide.otimizacao.estado] || STATUS_PREPARO.falhou) : statusAgenda(agenda, now);
}

const upload = multer({
  storage,
  limits: {
    fileSize: LIMITE_UPLOAD_MB * 1024 * 1024,
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
          return res.status(413).json({ error: `Arquivo muito grande. O limite é ${LIMITE_UPLOAD_MB} MB.` });
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

// Devolve { active, reason, detail }: o motivo de o slide estar oculto, para o
// painel explicar ao usuário em vez de a tela sumir sem aviso.
// A regra mora em scheduling.js, a versão testada — inclusive a madrugada: "seg
// 22h-06h" vale de segunda à noite até terça de manhã. Antes havia aqui uma cópia
// própria que usava o dia do relógio e errava depois da meia-noite.
function statusAgenda(a, now) {
  return scheduling.slideStatus(a, now || new Date());
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
  res.json(slides.map(s => {
    const item = Object.assign({}, s, { em_uso: usos.get(s.id) || 0 });
    // Andamento da otimização: só existe na memória da fila, não vale gravar no banco.
    if (filaVideo && s.otimizacao && s.otimizacao.estado === 'otimizando') {
      item.otimizacao = Object.assign({}, s.otimizacao, {
        percentual: filaVideo.percentual(s.id), na_fila: filaVideo.posicao(s.id)
      });
    }
    return item;
  }));
});

app.get('/api/slides/:id/arquivo', async (req, res, next) => {
  const slide = await db.slides.findOne({ id: req.params.id });
  if (!slide) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
  if (slide.otimizacao && slide.otimizacao.estado === 'otimizando') {
    return res.status(409).json({ error: 'O vídeo ainda está sendo preparado' });
  }
  const arquivo = ['img', 'vid'].includes(slide.type) && uploadedPathFromUrl(slide.url, uploadsDir);
  if (!arquivo) return res.status(404).json({ error: 'Conteúdo sem arquivo disponível.' });
  let titulo = String(slide.title || '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 120).trim() || 'Conteúdo';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(titulo)) titulo = '_' + titulo;
  res.download(arquivo, titulo + path.extname(arquivo), error => {
    if (!error) return;
    if (!res.headersSent && (error.code === 'ENOENT' || error.status === 404)) {
      res.removeHeader('Content-Disposition');
      return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }
    next(error);
  });
});

// Sem titulo, o painel mostrava tudo como "vid" e ficava impossivel distinguir
// dois videos. Na falta de titulo, usa o nome do arquivo enviado.
function tituloPadrao(title, file) {
  if (title && title.trim()) return title.trim();
  if (!file || !file.originalname) return '';
  return file.originalname.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
}

app.post('/api/slides', handleUpload, async (req, res) => {
  const fields = req.body || {};
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
  const valid = validateSlideInput(fields, { hasFile: Boolean(req.file), fileType: uploadedType });
  if (valid.error) {
    await cleanupUpload();
    return res.status(400).json({ error: valid.error });
  }
  const v = valid.value;
  const doc = {
    id: uuidv4(), title: tituloPadrao(v.title, req.file), body: v.body,
    type: v.type, duration: v.duration,
    bg: v.bg, url: req.file ? '/uploads/' + req.file.filename : null,
    created_at: new Date(),
    video_text_mode: v.video_text_mode,
    video_text_seconds: v.video_text_seconds
  };
  if (uploadedType === 'vid' && filaVideo) {
    try {
      // Caminho conferido (nome UUID dentro da pasta de uploads), como em toda leitura de mídia.
      const arquivoEnviado = uploadedPathFromUrl('/uploads/' + req.file.filename, uploadsDir);
      if (!arquivoEnviado) throw new Error('nome de arquivo inesperado');
      const analise = await video.analisar(videoTools, arquivoEnviado);
      if (analise.modo) {
        doc.otimizacao = {
          estado: 'otimizando', modo: analise.modo, motivos: analise.motivos, hdr: analise.info.hdr,
          duracao_s: Math.round(analise.info.duracaoS), original_mb: +(req.file.size / 1048576).toFixed(1)
        };
      }
    } catch (error) {
      // Sem análise não há garantia de que o arquivo toca ou cabe no padrão das TVs.
      log('AVISO', 'não consegui analisar o vídeo enviado; upload recusado', { arquivo: req.file.filename, msg: error.message });
      await cleanupUpload();
      return res.status(415).json({ error: 'Não foi possível verificar este vídeo. Confira se o MP4 abre corretamente e tente novamente.' });
    }
  }
  try {
    await db.slides.insert(doc);
  } catch (error) {
    await cleanupUpload();
    throw error;
  }
  if (doc.otimizacao) {
    log('INFO', 'vídeo na fila de otimização', { slide: doc.id, mb: doc.otimizacao.original_mb, motivos: doc.otimizacao.motivos });
    filaVideo.enfileirar(doc.id);
  }
  res.json(doc);
});

// Edita apenas o conteudo. Para mudar quando ele toca, use a rota de agenda do
// ambiente (PUT /api/groups/:gid/slides/:sid).
app.put('/api/slides/:id', async (req, res) => {
  const current = await db.slides.findOne({ id: req.params.id });
  if (!current) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  // O tipo não muda na edição: ele vem do arquivo que foi enviado.
  const { type: _tipoIgnorado, ...body } = req.body || {};
  // Antes esta rota gravava título, texto, cor e duração do jeito que chegavam, sem
  // passar pela validação que o cadastro deveria usar.
  const valid = validateSlideInput(body, { partial: true, current });
  if (valid.error) return res.status(400).json({ error: valid.error });
  const set = valid.value;
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nada para alterar' });
  const affected = await db.slides.update({ id: req.params.id }, { $set: set });
  res.json({ ok: true });
});

app.delete('/api/slides/:id', async (req, res) => {
  // Vídeo em otimização: a conversão termina (ou é interrompida) ANTES de ler o
  // conteúdo, para apagar o arquivo que vale agora — o original ou o já convertido.
  if (filaVideo) await filaVideo.cancelar(req.params.id);
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
      status: statusDoConteudo(s, agenda, now)
    });
  }));
  res.json(itens.filter(Boolean));
});

app.post('/api/groups/:id/slides', async (req, res) => {
  const body = req.body || {};
  const { slide_id } = body;
  return db.executarEmSerie('vinculos', async () => {
    const grupo = await db.groups.findOne({ id: req.params.id });
    if (!grupo) return res.status(404).json({ error: 'Ambiente não encontrado' });
    if (typeof slide_id !== 'string' || !slide_id.trim()) return res.status(400).json({ error: 'Conteúdo obrigatório' });
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
// Endereço que o painel usa nos links do player. Sem ele, o painel monta o link com o
// endereço pelo qual foi aberto — e quem abre pelo IP distribui links com IP e porta.
// Aceita só esquema + host (+ porta): nada de caminho, que o painel completa sozinho.
function enderecoPublico(valor) {
  // Uma expressão só, sem retrocesso: o host não aceita "/", então as barras finais
  // não disputam caracteres com ele (um replace(/\/+$/) separado era quadrático).
  const achado = /^(https?:\/\/[a-z0-9.-]+(?::\d{1,5})?)\/*$/i.exec(String(valor || '').trim());
  return achado ? achado[1] : null;
}
const ENDERECO_PUBLICO = enderecoPublico(process.env.CORPTV_ENDERECO_PUBLICO);

app.get('/api/config', (req, res) => {
  // O painel confere o tamanho antes de enviar: um arquivo acima do limite avisa na
  // hora, em vez de subir por minutos e ser recusado.
  res.json({ endereco_publico: ENDERECO_PUBLICO, limite_upload_mb: LIMITE_UPLOAD_MB, otimiza_videos: !!filaVideo });
});

app.get('/api/screens', async (req, res) => {
  const screens = await db.screens.find({}).sort({ name: 1 });
  res.json(screens);
});

app.post('/api/screens', async (req, res) => {
  const fields = validateScreenInput(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  return db.executarEmSerie('telas', async () => {
    const group = await db.groups.findOne({ id: fields.value.group_id });
    if (!group) return res.status(404).json({ error: 'Ambiente não encontrado' });
    const slug = await db.uniqueSlug(fields.value.name);
    const doc = { id: slug, volume: 100, ...fields.value, last_seen: null, created_at: new Date() };
    await db.screens.insert(doc);
    res.json(doc);
  });
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

// Pede à TV que recarregue o player. Age na TV, não no indicador: o player compara
// esta marca a cada consulta da programação (30 s) e recarrega quando ela muda.
// Serve para manutenção remota — tela congelada, player antigo, conteúdo preso.
app.post('/api/screens/:id/recarregar', async (req, res) => {
  const reload_at = new Date().toISOString();
  const affected = await db.screens.update({ id: req.params.id }, { $set: { reload_at } });
  if (!affected) return res.status(404).json({ error: 'Tela não encontrada' });
  log('INFO', 'recarga da tela pedida', { screen: req.params.id });
  res.json({ ok: true, reload_at });
});

app.delete('/api/screens/:id', async (req, res) => {
  const removed = await db.screens.remove({ id: req.params.id }, {});
  if (!removed) return res.status(404).json({ error: 'Tela não encontrada' });
  res.json({ ok: true });
});

// ── PLAYER API ────────────────────────────────────────────
app.get('/api/player/:slug', playerRequestLimiter, async (req, res) => {
  const screen = await db.screens.findOne({ id: req.params.slug });
  if (!screen) return res.status(404).json({ error: 'Tela não encontrada' });
  const vinculos = await db.gslides.find({ group_id: screen.group_id }).sort({ position: 1 });
  const now = new Date();
  const itens = await Promise.all(vinculos.map(async v => {
    const agenda = agendaDoVinculo(v);
    if (!statusAgenda(agenda, now).active) return null;
    const slide = await db.slides.findOne({ id: v.slide_id });
    // Vídeo ainda sendo otimizado (ou que falhou) não vai para a TV: o arquivo bruto
    // é justamente o que derrubaria a rede.
    if (emPreparo(slide)) return null;
    // Por quanto tempo uma cópia offline (player ou agente) ainda pode exibir o
    // conteúdo sem falar com o servidor. Sem isso, um conteúdo vencido seguia na
    // TV enquanto a rede estivesse fora. null = a agenda não tem prazo à frente.
    return slide && { ...slide, cache_for_ms: scheduling.activeForMs(agenda, now) };
  }));
  // Telas cadastradas antes do controle de volume não têm o campo: tocam no máximo,
  // como sempre tocaram.
  const volume = Number.isInteger(screen.volume) ? screen.volume : 100;
  res.json({ screen: { ...screen, volume }, slides: itens.filter(Boolean) });
});

// Registra no log quando uma tela aparece ou volta depois de sumir, para dar
// para investigar queda de TV sem gerar uma linha a cada 20 segundos.
const OFFLINE_MS = 60000;
const lastBeat = new Map();

app.post('/api/heartbeat', heartbeatRequestLimiter, async (req, res) => {
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

// ── APARELHOS (Raspberry Pi, mini PC) ─────────────────────
// Cada aparelho atrás de uma TV se registra sozinho a cada minuto, com um id que
// ele mesmo gerou, e recebe de volta qual tela deve exibir. Assim a Pi é
// preparada com um comando igual para todas e a tela se escolhe no painel.
const ID_APARELHO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMITE_APARELHOS = 500;
const aparelhoLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: chaveDeLimite });

function nomeAparelho(valor) {
  return String(valor || '').replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'aparelho';
}

async function telaExiste(id) {
  return typeof id === 'string' && id !== '' && !!(await db.screens.findOne({ id }));
}

app.post('/api/aparelhos/registro', aparelhoLimiter, async (req, res) => {
  const { id, nome, tela_local, ip: ipInformado } = req.body || {};
  // O IP que a Pi informa (o servidor vê o nginx, não a Pi). Só o formato; o
  // resto é ignorado para nada estranho chegar ao painel.
  const ip = typeof ipInformado === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(ipInformado) ? ipInformado : null;
  if (typeof id !== 'string' || !ID_APARELHO.test(id)) return res.status(400).json({ error: 'Aparelho inválido' });
  return db.executarEmSerie('aparelhos', async () => {
    const agora = new Date().toISOString();
    let aparelho = await db.devices.findOne({ id });
    if (!aparelho) {
      if (await db.devices.count({}) >= LIMITE_APARELHOS) return res.status(429).json({ error: 'Aparelhos demais cadastrados' });
      // Aparelho instalado antes desta versão já tinha a tela na configuração local:
      // entra no painel com ela, sem ninguém precisar escolher de novo.
      const screen_id = (await telaExiste(tela_local)) ? tela_local : null;
      aparelho = { id, name: nomeAparelho(nome), ip, screen_id, last_seen: agora, created_at: agora };
      await db.devices.insert(aparelho);
      log('INFO', 'aparelho novo', { aparelho: id, nome: aparelho.name, tela: screen_id });
    } else {
      await db.devices.update({ id }, { $set: { last_seen: agora, name: nomeAparelho(nome), ip } });
    }
    // Tela apagada no painel: o aparelho volta a "aguardando tela".
    const screen_id = (await telaExiste(aparelho.screen_id)) ? aparelho.screen_id : null;
    res.json({ screen_id });
  });
});

// Consultar e mexer nos aparelhos é do TI, como Usuários e Auditoria: o painel já
// escondia a página, mas a API aceitava qualquer perfil de edição.
app.get('/api/aparelhos', auth.requireRole('admin'), async (req, res) => {
  res.json(await db.devices.find({}).sort({ name: 1 }));
});

app.put('/api/aparelhos/:id', auth.requireRole('admin'), async (req, res) => {
  const screen_id = req.body && req.body.screen_id;
  if (screen_id !== null && !(await telaExiste(screen_id))) return res.status(400).json({ error: 'Escolha uma tela que exista' });
  const affected = await db.devices.update({ id: req.params.id }, { $set: { screen_id } });
  if (!affected) return res.status(404).json({ error: 'Aparelho não encontrado' });
  log('INFO', 'tela do aparelho escolhida no painel', { aparelho: req.params.id, tela: screen_id });
  res.json({ ok: true });
});

app.delete('/api/aparelhos/:id', auth.requireRole('admin'), async (req, res) => {
  const removed = await db.devices.remove({ id: req.params.id }, {});
  if (!removed) return res.status(404).json({ error: 'Aparelho não encontrado' });
  res.json({ ok: true });
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
        status: statusDoConteudo(slide, agenda, now)
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
// ── RASPBERRY PI ──────────────────────────────────────────
// O painel mostra, em cada tela, o comando que prepara uma Pi nova. O script e os
// arquivos do agente saem daqui, na mesma versão do servidor: ninguém precisa
// lembrar onde está o script nem buscar no repositório. Nada disso é segredo (o
// agente é o mesmo do repositório), por isso fica público como o player.
const PASTA_AGENTE = path.join(__dirname, '../agente');
const ARQUIVOS_PI = new Set(['agente.js', 'corptv-agente.service', 'iniciar-quiosque.sh', 'corptv-quiosque.desktop']);
// Limite próprio: preparar várias Pis seguidas não pode esbarrar no limite das páginas.
const piRequestLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: chaveDeLimite });

app.get('/pi/preparar.sh', piRequestLimiter, (req, res) => {
  // O endereço vai para dentro de um script que roda como root na Pi: só aceita
  // esquema + host validado, nunca o cabeçalho Host cru.
  const servidor = ENDERECO_PUBLICO || enderecoPublico(`${req.protocol}://${req.get('host')}`);
  if (!servidor) return res.status(400).type('text/plain').send('Endereço do servidor inválido\n');
  const script = fs.readFileSync(path.join(PASTA_AGENTE, 'preparar-pi.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace('__SERVIDOR__', servidor);
  res.set('Cache-Control', 'no-store').type('text/x-shellscript; charset=utf-8').send(script);
});

app.get('/pi/agente/:arquivo', piRequestLimiter, (req, res) => {
  if (!ARQUIVOS_PI.has(req.params.arquivo)) return res.status(404).type('text/plain').send('Não encontrado\n');
  const conteudo = fs.readFileSync(path.join(PASTA_AGENTE, req.params.arquivo), 'utf8').replace(/\r\n/g, '\n');
  res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(conteudo);
});

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
    if (filaVideo) {
      filaVideo.retomar().catch(err => log('ERRO', 'falha ao retomar a otimização de vídeos', { msg: err.message }));
    }
    log('INFO', 'CorporTV iniciado', { porta: PORT, pid: process.pid });
    console.log(`\n🖥️  CorporTV rodando em http://localhost:${PORT}`);
    console.log(`   Painel : http://localhost:${PORT}/painel`);
    console.log(`   Player : http://localhost:${PORT}/player/<slug-da-tela>\n`);
  });

  // Envio de vídeo grande por Wi-Fi passa fácil dos 5 min que o Node dá por padrão
  // para receber uma requisição inteira (quem acessa direto na porta 3000, sem o
  // nginx). O cabeçalho continua com prazo curto (headersTimeout).
  server.requestTimeout = 60 * 60 * 1000;

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

module.exports = { app, iniciar, enderecoPublico };
