// ─────────────────────────────────────────────────────────────────────────────
// CorporTV — Agente local
//
// Roda no aparelho que fica atrás da TV (Raspberry Pi, mini PC). Faz o papel de
// espelho local do servidor:
//
//   1. Consulta a programação no servidor de tempos em tempos (JSON pequeno).
//   2. Baixa os vídeos para o disco local, DEVAGAR e com retomada.
//   3. Serve tudo em 127.0.0.1 — o navegador toca do disco, sem tocar na rede.
//
// Com isso a exibição não gera tráfego nenhum: o vídeo já está no aparelho.
// O download acontece uma vez, no ritmo configurado, e não se repete enquanto o
// arquivo não mudar no servidor.
//
// O player NÃO precisa de nenhuma alteração: ele continua pedindo
// /api/player/<tela> e /uploads/<arquivo>, só que para o agente, que responde
// com os caminhos locais.
//
// Uso:  node agente.js
// Config: variáveis de ambiente ou o bloco CONFIG abaixo.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const CONFIG = {
  // Sem padrão de propósito: um endereço chutado aqui vira tela preta silenciosa
  // no dia em que alguém esquecer de configurar. Melhor recusar a subir.
  servidor: process.env.CORPTV_SERVIDOR,
  tela: process.env.CORPTV_TELA || 'teste',
  porta: parseInt(process.env.CORPTV_PORTA || '8080', 10),
  pasta: process.env.CORPTV_CACHE || path.join(__dirname, 'cache'),
  // Ritmo do download. 2 Mb/s por aparelho: 4 aparelhos = 8 Mb/s, abaixo do
  // teto de 12 Mb/s do servidor. Um vídeo de 106 MB leva ~7 minutos.
  limiteMbps: parseFloat(process.env.CORPTV_LIMITE_MBPS || '2'),
  // De quanto em quanto tempo confere a programação.
  intervaloProgramacaoS: parseInt(process.env.CORPTV_INTERVALO || '60', 10),
  // Espalha o início dos downloads para vários aparelhos não baixarem juntos.
  jitterMaxS: parseInt(process.env.CORPTV_JITTER || '90', 10),
  heartbeatS: 20
};

if (!CONFIG.servidor) {
  console.error('CORPTV_SERVIDOR nao foi configurado. Exemplo: http://192.168.0.10:3000');
  console.error('No Raspberry Pi, a linha fica em /etc/systemd/system/corptv-agente.service');
  process.exit(1);
}

const LIMITE_BYTES_S = Math.round((CONFIG.limiteMbps * 1e6) / 8);
const arqEstado = path.join(CONFIG.pasta, 'estado.json');
const arqPlaylist = path.join(CONFIG.pasta, 'playlist.json');

fs.mkdirSync(CONFIG.pasta, { recursive: true });

function log(nivel, msg, extra) {
  const linha = `[${new Date().toISOString()}] ${nivel} ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
  (nivel === 'ERRO' ? console.error : console.log)(linha);
}

// ── ESTADO EM DISCO ──────────────────────────────────────────────────────────
// Guarda, por arquivo, a "versão" que temos (ETag do servidor) e o tamanho.
// É assim que sabemos se precisa baixar de novo.
function lerEstado() {
  try { return JSON.parse(fs.readFileSync(arqEstado, 'utf8')); } catch (e) { return {}; }
}
function salvarEstado(e) {
  try { fs.writeFileSync(arqEstado, JSON.stringify(e, null, 2)); } catch (err) {
    log('ERRO', 'nao consegui salvar o estado', { msg: err.message });
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function pedir(url, opcoes) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, Object.assign({ timeout: 20000 }, opcoes || {}), resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('tempo esgotado')); });
    if (opcoes && opcoes.corpo) req.write(opcoes.corpo);
    req.end();
  });
}

function lerTudo(res) {
  return new Promise((resolve, reject) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', c => d += c);
    res.on('end', () => resolve(d));
    res.on('error', reject);
  });
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// ── DOWNLOAD COM RITMO, RETOMADA E TENTATIVAS ────────────────────────────────
// Baixa para um arquivo .parcial e só renomeia no fim. Se cair no meio, na
// próxima tentativa retoma de onde parou usando Range — não recomeça do zero.
async function baixarArquivo(urlRemota, destino, tamanhoEsperado) {
  const parcial = destino + '.parcial';
  let jaTemos = 0;
  try { jaTemos = fs.statSync(parcial).size; } catch (e) { jaTemos = 0; }
  if (jaTemos > 0 && tamanhoEsperado && jaTemos >= tamanhoEsperado) {
    try { fs.unlinkSync(parcial); } catch (e) {}
    jaTemos = 0;
  }

  const cabecalhos = jaTemos > 0 ? { Range: 'bytes=' + jaTemos + '-' } : {};
  const res = await pedir(urlRemota, { method: 'GET', headers: cabecalhos });

  if (jaTemos > 0 && res.statusCode !== 206) {
    // Servidor não aceitou retomar: recomeça limpo.
    res.destroy();
    try { fs.unlinkSync(parcial); } catch (e) {}
    return baixarArquivo(urlRemota, destino, tamanhoEsperado);
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.destroy();
    throw new Error('HTTP ' + res.statusCode);
  }

  if (jaTemos > 0) log('INFO', 'retomando download', { arquivo: path.basename(destino), de: jaTemos });

  const saida = fs.createWriteStream(parcial, { flags: jaTemos > 0 ? 'a' : 'w' });
  const inicio = Date.now();
  let recebido = 0;

  // Controle de ritmo que se autocorrige: a cada bloco, calcula quanto tempo
  // o total recebido DEVERIA ter levado no limite configurado e, se chegou
  // rápido demais, pausa a diferença. Como olha o acumulado e não uma janela
  // isolada, o excesso de um bloco é compensado no seguinte e a taxa converge
  // para o valor pedido em vez de ficar sempre um pouco acima.
  await new Promise((resolve, reject) => {
    res.on('data', pedaco => {
      recebido += pedaco.length;
      saida.write(pedaco);
      if (LIMITE_BYTES_S <= 0) return;
      const devidoMs = (recebido / LIMITE_BYTES_S) * 1000;
      const decorridoMs = Date.now() - inicio;
      const atraso = Math.round(devidoMs - decorridoMs);
      if (atraso > 0) {
        res.pause();
        setTimeout(() => res.resume(), atraso);
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
    saida.on('error', reject);
  });

  await new Promise(r => saida.end(r));

  const total = jaTemos + recebido;
  if (tamanhoEsperado && total !== tamanhoEsperado) {
    throw new Error('tamanho nao confere: ' + total + ' de ' + tamanhoEsperado);
  }

  // No Windows, renomear por cima de um arquivo que o navegador está lendo
  // falha com EPERM/EBUSY (no Linux não). Na prática quase não acontece — cada
  // upload no servidor gera um nome UUID novo — mas se acontecer, tenta de novo
  // por alguns segundos em vez de perder o download inteiro.
  let renomeado = false;
  for (let tentativa = 0; tentativa < 10 && !renomeado; tentativa++) {
    try { fs.renameSync(parcial, destino); renomeado = true; }
    catch (err) {
      if (tentativa === 9) throw new Error('nao consegui substituir o arquivo em uso: ' + err.code);
      await esperar(1000);
    }
  }
  const seg = (Date.now() - inicio) / 1000;
  log('INFO', 'download concluido', {
    arquivo: path.basename(destino),
    mb: +(total / 1048576).toFixed(1),
    seg: +seg.toFixed(1),
    mbps: +((recebido * 8) / seg / 1e6).toFixed(2)
  });
  return total;
}

// Tenta várias vezes, esperando cada vez mais entre elas (1s, 2s, 5s, 10s, 30s).
async function baixarComTentativas(urlRemota, destino, tamanho) {
  const esperas = [1000, 2000, 5000, 10000, 30000];
  for (let i = 0; i <= esperas.length; i++) {
    try {
      return await baixarArquivo(urlRemota, destino, tamanho);
    } catch (err) {
      if (i === esperas.length) throw err;
      log('AVISO', 'download falhou, vou tentar de novo', {
        arquivo: path.basename(destino), erro: err.message, proxima_em_s: esperas[i] / 1000
      });
      await esperar(esperas[i]);
    }
  }
}

// ── SINCRONIZAÇÃO ────────────────────────────────────────────────────────────
let playlistLocal = null;   // playlist já com caminhos locais
let sincronizando = false;

function nomeLocal(urlRemota) {
  return path.basename(new URL(urlRemota, CONFIG.servidor).pathname);
}

async function sincronizar() {
  if (sincronizando) return;
  sincronizando = true;
  try {
    const res = await pedir(CONFIG.servidor + '/api/player/' + encodeURIComponent(CONFIG.tela));
    if (res.statusCode !== 200) { res.destroy(); throw new Error('HTTP ' + res.statusCode); }
    const dados = JSON.parse(await lerTudo(res));
    const estado = lerEstado();
    const slides = dados.slides || [];

    for (const slide of slides) {
      if (!slide.url) continue;
      const nome = nomeLocal(slide.url);
      const destino = path.join(CONFIG.pasta, nome);
      const urlRemota = CONFIG.servidor + slide.url;

      // HEAD barato: descobre versão (ETag) e tamanho sem baixar nada.
      let etag = null, tamanho = null;
      try {
        const h = await pedir(urlRemota, { method: 'HEAD' });
        h.resume();
        etag = h.headers.etag || null;
        tamanho = h.headers['content-length'] ? parseInt(h.headers['content-length'], 10) : null;
      } catch (e) {
        log('AVISO', 'nao consegui consultar a midia', { arquivo: nome, erro: e.message });
      }

      const temArquivo = fs.existsSync(destino);
      const tamanhoLocal = temArquivo ? fs.statSync(destino).size : 0;
      const registro = estado[nome];
      const atualizado = temArquivo && registro && registro.etag === etag &&
                         (!tamanho || tamanhoLocal === tamanho);

      if (atualizado) continue;

      if (temArquivo) log('INFO', 'midia mudou no servidor, baixando de novo', { arquivo: nome });
      else log('INFO', 'midia nova, baixando', { arquivo: nome, mb: tamanho ? +(tamanho / 1048576).toFixed(1) : '?' });

      // Espalha o início: com vários aparelhos, evita todos baixarem juntos.
      const jitter = Math.floor(Math.random() * CONFIG.jitterMaxS * 1000);
      if (jitter) { log('INFO', 'aguardando para espalhar a carga', { seg: Math.round(jitter / 1000) }); await esperar(jitter); }

      await baixarComTentativas(urlRemota, destino, tamanho);
      estado[nome] = { etag, tamanho: tamanho || fs.statSync(destino).size, em: new Date().toISOString() };
      salvarEstado(estado);
    }

    // Playlist com caminhos locais: só entra o que já está no disco.
    const prontos = slides.filter(s => !s.url || fs.existsSync(path.join(CONFIG.pasta, nomeLocal(s.url))));
    playlistLocal = {
      screen: dados.screen,
      slides: prontos.map(s => s.url ? Object.assign({}, s, { url: '/midia/' + nomeLocal(s.url) }) : s)
    };
    try { fs.writeFileSync(arqPlaylist, JSON.stringify(playlistLocal)); } catch (e) {}

    const faltando = slides.length - prontos.length;
    if (faltando > 0) log('INFO', 'programacao parcial', { prontos: prontos.length, baixando: faltando });

    limparAntigos(slides);
  } catch (err) {
    log('AVISO', 'sem contato com o servidor, seguindo com o que esta no disco', { erro: err.message });
    if (!playlistLocal) {
      try { playlistLocal = JSON.parse(fs.readFileSync(arqPlaylist, 'utf8')); } catch (e) {}
    }
  } finally {
    sincronizando = false;
  }
}

// Remove mídia que saiu da programação, para o disco não encher com o tempo.
function limparAntigos(slides) {
  const usados = new Set(slides.filter(s => s.url).map(s => nomeLocal(s.url)));
  let removidos = 0;
  for (const arq of fs.readdirSync(CONFIG.pasta)) {
    if (arq === 'estado.json' || arq === 'playlist.json') continue;
    if (arq.endsWith('.parcial')) continue;
    if (!usados.has(arq)) {
      try { fs.unlinkSync(path.join(CONFIG.pasta, arq)); removidos++; } catch (e) {}
    }
  }
  if (removidos) {
    const estado = lerEstado();
    Object.keys(estado).forEach(k => { if (!usados.has(k)) delete estado[k]; });
    salvarEstado(estado);
    log('INFO', 'midia antiga removida', { arquivos: removidos });
  }
}

// ── HEARTBEAT ────────────────────────────────────────────────────────────────
// Continua avisando o servidor que a tela está viva, para o painel mostrar online.
async function heartbeat() {
  try {
    const corpo = JSON.stringify({ screen_id: CONFIG.tela });
    const res = await pedir(CONFIG.servidor + '/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      corpo
    });
    res.resume();
  } catch (e) { /* servidor fora do ar: silencioso, tenta de novo depois */ }
}

// ── SERVIDOR LOCAL ───────────────────────────────────────────────────────────
const TIPOS = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
let paginaPlayer = null;

async function obterPlayer() {
  if (paginaPlayer) return paginaPlayer;
  const cache = path.join(CONFIG.pasta, 'player.html');
  try {
    const res = await pedir(CONFIG.servidor + '/player/' + encodeURIComponent(CONFIG.tela));
    if (res.statusCode === 200) {
      paginaPlayer = await lerTudo(res);
      fs.writeFileSync(cache, paginaPlayer);
      return paginaPlayer;
    }
    res.destroy();
  } catch (e) { /* usa a copia local */ }
  try { paginaPlayer = fs.readFileSync(cache, 'utf8'); } catch (e) {
    paginaPlayer = '<h1 style="color:#fff;background:#000;font-family:sans-serif">CorporTV: sem contato com o servidor e sem cópia local do player.</h1>';
  }
  return paginaPlayer;
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const caminho = decodeURIComponent(u.pathname);

  // A programação: sempre a versão local, com os arquivos que já estão no disco.
  if (caminho.startsWith('/api/player/')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(playlistLocal || { screen: { id: CONFIG.tela }, slides: [] }));
  }

  // Heartbeat: o player continua chamando; repassamos ao servidor.
  if (caminho === '/api/heartbeat') {
    req.resume();
    heartbeat();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  // Mídia: direto do disco, na velocidade do disco. Zero rede.
  if (caminho.startsWith('/midia/')) {
    const nome = path.basename(caminho);
    const arquivo = path.join(CONFIG.pasta, nome);
    const ext = path.extname(nome).toLowerCase();
    if (!TIPOS[ext] || !fs.existsSync(arquivo)) { res.writeHead(404); return res.end(); }
    const info = fs.statSync(arquivo);
    let inicio = 0, fim = info.size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        if (m[1] === '') inicio = Math.max(0, info.size - parseInt(m[2], 10));
        else { inicio = parseInt(m[1], 10); if (m[2] !== '') fim = Math.min(parseInt(m[2], 10), info.size - 1); }
      }
      if (isNaN(inicio) || inicio > fim || inicio >= info.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + info.size });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': TIPOS[ext], 'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + inicio + '-' + fim + '/' + info.size,
        'Content-Length': fim - inicio + 1
      });
    } else {
      res.writeHead(200, { 'Content-Type': TIPOS[ext], 'Accept-Ranges': 'bytes', 'Content-Length': info.size });
    }
    if (req.method === 'HEAD') return res.end();
    const leitura = fs.createReadStream(arquivo, { start: inicio, end: fim });
    res.on('close', () => leitura.destroy());
    return leitura.pipe(res);
  }

  // Situação do agente, para conferir de fora.
  if (caminho === '/status') {
    const estado = lerEstado();
    const arquivos = Object.keys(estado).map(k => ({
      arquivo: k, mb: +(estado[k].tamanho / 1048576).toFixed(1),
      no_disco: fs.existsSync(path.join(CONFIG.pasta, k))
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      tela: CONFIG.tela, servidor: CONFIG.servidor,
      limite_mbps: CONFIG.limiteMbps,
      baixando: sincronizando,
      conteudos_prontos: playlistLocal ? playlistLocal.slides.length : 0,
      arquivos
    }, null, 2));
  }

  // Qualquer outra coisa: o player.
  const html = await obterPlayer();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});

servidor.listen(CONFIG.porta, '127.0.0.1', () => {
  log('INFO', 'agente iniciado', {
    tela: CONFIG.tela, servidor: CONFIG.servidor,
    endereco: 'http://127.0.0.1:' + CONFIG.porta,
    limite_mbps: CONFIG.limiteMbps, cache: CONFIG.pasta
  });
  sincronizar();
  setInterval(sincronizar, CONFIG.intervaloProgramacaoS * 1000);
  heartbeat();
  setInterval(heartbeat, CONFIG.heartbeatS * 1000);
});

function encerrar(sinal) {
  log('INFO', 'encerrando', { sinal });
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('uncaughtException', err => {
  log('ERRO', 'falha inesperada - encerrando para reiniciar', { msg: err.message });
  console.error(err.stack);
  process.exit(1);
});
