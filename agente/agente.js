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
const os = require('os');
const { URL } = require('url');

const CONFIG = {
  // Sem padrão de propósito: um endereço chutado aqui vira tela preta silenciosa
  // no dia em que alguém esquecer de configurar. Melhor recusar a subir.
  servidor: process.env.CORPTV_SERVIDOR,
  // Tela inicial, opcional. Normalmente a tela é escolhida no painel (Telas →
  // Aparelhos); esta variável só vale para quem instalou antes disso ou sem painel.
  tela: process.env.CORPTV_TELA || '',
  porta: parseInt(process.env.CORPTV_PORTA || '8080', 10),
  pasta: process.env.CORPTV_CACHE || path.join(__dirname, 'cache'),
  // Ritmo do download. 2 Mb/s por aparelho: 4 aparelhos = 8 Mb/s, abaixo do
  // teto de 12 Mb/s do servidor. Um vídeo de 106 MB leva ~7 minutos.
  limiteMbps: parseFloat(process.env.CORPTV_LIMITE_MBPS || '2'),
  // De quanto em quanto tempo confere a programação.
  intervaloProgramacaoS: parseInt(process.env.CORPTV_INTERVALO || '60', 10),
  // De quanto em quanto tempo avisa o painel que está ligado e pergunta a tela.
  // Separado da programação: um download longo não pode fazer a Pi parecer
  // desligada, nem atrasar a troca de tela escolhida no painel.
  intervaloRegistroS: parseInt(process.env.CORPTV_INTERVALO_REGISTRO || '15', 10),
  // Espalha o início dos downloads para vários aparelhos não baixarem juntos.
  jitterMaxS: parseInt(process.env.CORPTV_JITTER || '90', 10),
  // De quanto em quanto tempo baixa de novo a página do player.
  intervaloPlayerS: parseInt(process.env.CORPTV_INTERVALO_PLAYER || '600', 10)
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

// ── IDENTIDADE DO APARELHO ───────────────────────────────────────────────────
// Id gerado uma vez e guardado no cache: é por ele que o painel reconhece este
// aparelho e escolhe a tela. A última tela escolhida fica junto, para a TV
// voltar a exibi-la mesmo se ligar sem rede.
const arqAparelho = path.join(CONFIG.pasta, 'aparelho.json');
const aparelho = (() => {
  let salvo = {};
  try { salvo = JSON.parse(fs.readFileSync(arqAparelho, 'utf8')); } catch (e) { /* primeira vez */ }
  return { id: salvo.id || crypto.randomUUID(), tela: typeof salvo.tela === 'string' ? salvo.tela : CONFIG.tela };
})();
let telaAtual = aparelho.tela;

function salvarAparelho() {
  try { fs.writeFileSync(arqAparelho, JSON.stringify({ id: aparelho.id, tela: telaAtual })); } catch (err) {
    log('ERRO', 'nao consegui salvar a identidade do aparelho', { msg: err.message });
  }
}
salvarAparelho();

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
const DOWNLOAD_CANCELADO = 'download cancelado: a tela mudou';
let cancelarDownload = null;

function fecharArquivo(stream) {
  return new Promise(resolve => {
    if (stream.closed) return resolve();
    stream.once('close', resolve);
    stream.destroy();
  });
}

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
  // Troca de tela no painel: quem chamar isto interrompe este download.
  cancelarDownload = () => res.destroy(new Error(DOWNLOAD_CANCELADO));

  // Controle de ritmo que se autocorrige: a cada bloco, calcula quanto tempo
  // o total recebido DEVERIA ter levado no limite configurado e, se chegou
  // rápido demais, pausa a diferença. Como olha o acumulado e não uma janela
  // isolada, o excesso de um bloco é compensado no seguinte e a taxa converge
  // para o valor pedido em vez de ficar sempre um pouco acima.
  try {
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
      // Conexão que cai sem "end": a resposta fecha incompleta.
      res.on('close', () => { if (!res.complete) reject(new Error('conexao interrompida')); });
      saida.on('error', reject);
    });
  } catch (err) {
    res.destroy();
    // Fecha o arquivo em qualquer falha: antes cada queda de rede deixava um
    // descritor aberto, e muitas quedas esgotariam o limite do sistema. O que já
    // foi gravado fica no .parcial para retomar.
    await fecharArquivo(saida);
    throw err;
  } finally {
    cancelarDownload = null;
  }

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
      // Tela trocada ou disco cheio: tentar de novo o mesmo arquivo não resolve.
      if (i === esperas.length || err.message === DOWNLOAD_CANCELADO || err.code === 'ENOSPC') throw err;
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
let sincronizarDeNovo = false; // troca de tela chegou no meio de uma sincronização

function nomeLocal(urlRemota) {
  return path.basename(new URL(urlRemota, CONFIG.servidor).pathname);
}

// semEspera: troca de tela feita no painel. A espera aleatória existe para várias
// TVs não baixarem o mesmo vídeo novo ao mesmo tempo; numa troca, é um aparelho só.
async function sincronizar(opcoes = {}) {
  if (sincronizando) {
    if (opcoes.semEspera) sincronizarDeNovo = true;
    return;
  }
  sincronizando = true;
  const tela = telaAtual;
  try {
    if (!tela) { playlistLocal = null; return; }
    const res = await pedir(CONFIG.servidor + '/api/player/' + encodeURIComponent(tela));
    if (res.statusCode !== 200) { res.destroy(); throw new Error('HTTP ' + res.statusCode); }
    const dados = JSON.parse(await lerTudo(res));
    const estado = lerEstado();
    const slides = dados.slides || [];
    const mesmaTela = !!(playlistLocal && playlistLocal.screen && playlistLocal.screen.id === tela);

    // Os ajustes da tela (volume, pedido de recarregar) chegam ao player já,
    // sem esperar o download de uma mídia nova terminar.
    if (mesmaTela && dados.screen) playlistLocal.screen = dados.screen;

    // Antes de baixar, libera o que não está na programação nova nem na TV agora
    // (e downloads pela metade abandonados): disco cheio não pode impedir a própria
    // limpeza, que antes só rodava depois de baixar tudo.
    liberarEspaco(slides);

    for (const slide of slides) {
      // A tela mudou no painel: o resto desta programação perdeu o sentido.
      if (tela !== telaAtual) break;
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
      const jitter = opcoes.semEspera ? 0 : Math.floor(Math.random() * CONFIG.jitterMaxS * 1000);
      if (jitter) { log('INFO', 'aguardando para espalhar a carga', { seg: Math.round(jitter / 1000) }); await esperar(jitter); }

      if (tela !== telaAtual) break;

      // Uma mídia que falha não trava as outras nem a atualização da programação:
      // antes, uma falha aqui pulava direto para "sem contato com o servidor".
      try {
        await baixarComTentativas(urlRemota, destino, tamanho);
        estado[nome] = { etag, tamanho: tamanho || fs.statSync(destino).size, em: new Date().toISOString() };
        salvarEstado(estado);
      } catch (err) {
        if (err.message === DOWNLOAD_CANCELADO) break;
        log('AVISO', 'nao consegui baixar a midia; sigo com o resto', { arquivo: nome, erro: err.message, codigo: err.code || null });
        // Disco cheio: tira também o que está na tela mas saiu da programação.
        if (err.code === 'ENOSPC') limparAntigos(slides);
      }
    }

    // A tela mudou de novo enquanto baixava: esta programação já não vale.
    if (tela !== telaAtual) return;

    // Playlist com caminhos locais: só entra o que já está no disco.
    const prontos = slides.filter(s => !s.url || fs.existsSync(path.join(CONFIG.pasta, nomeLocal(s.url))));
    // Troca de tela com nada da nova pronto ainda: a TV segue na tela anterior em
    // vez de ficar preta com "sem conteúdo" enquanto baixa.
    if (!mesmaTela && prontos.length === 0 && slides.length > 0 && playlistLocal && playlistLocal.slides.length) {
      log('INFO', 'mantendo a tela anterior ate a nova ficar pronta', { tela });
      return;
    }
    playlistLocal = {
      screen: dados.screen,
      // Instante da consulta ao servidor: é dele que conta a validade de cada slide.
      salvo_em: Date.now(),
      slides: prontos.map(s => s.url ? Object.assign({}, s, { url: '/midia/' + nomeLocal(s.url) }) : s)
    };
    try { fs.writeFileSync(arqPlaylist, JSON.stringify(playlistLocal)); } catch (e) {}

    const faltando = slides.length - prontos.length;
    if (faltando > 0) log('INFO', 'programacao parcial', { prontos: prontos.length, baixando: faltando });

    limparAntigos(slides);
  } catch (err) {
    log('AVISO', 'sem contato com o servidor, seguindo com o que esta no disco', { erro: err.message });
    if (!playlistLocal && telaAtual) {
      // Só a cópia da tela atual: se a tela foi trocada, a lista antiga não vale.
      try {
        const salva = JSON.parse(fs.readFileSync(arqPlaylist, 'utf8'));
        if (salva.screen && salva.screen.id === telaAtual) playlistLocal = salva;
      } catch (e) {}
    }
  } finally {
    sincronizando = false;
    if (sincronizarDeNovo) {
      sincronizarDeNovo = false;
      setImmediate(() => sincronizar({ semEspera: true }));
    }
  }
}

// Apaga a mídia (e o download pela metade dela, ".parcial") que o filtro mandar.
// Só mídia: a pasta também guarda a identidade do aparelho, a programação e a
// cópia do player que deixa a TV funcionar sem rede — apagar isso fazia a Pi
// "esquecer" quem é e perder o player offline a cada troca de conteúdo.
function removerMidias(remover) {
  let removidos = 0;
  for (const arq of fs.readdirSync(CONFIG.pasta)) {
    const base = arq.endsWith('.parcial') ? arq.slice(0, -'.parcial'.length) : arq;
    if (!TIPOS[path.extname(base).toLowerCase()] || !remover(base)) continue;
    try { fs.unlinkSync(path.join(CONFIG.pasta, arq)); removidos++; } catch (e) {}
  }
  if (removidos) {
    const estado = lerEstado();
    Object.keys(estado).forEach(k => { if (remover(k)) delete estado[k]; });
    salvarEstado(estado);
  }
  return removidos;
}

// Remove mídia que saiu da programação, para o disco não encher com o tempo.
function limparAntigos(slides) {
  const usados = new Set(slides.filter(s => s.url).map(s => nomeLocal(s.url)));
  const removidos = removerMidias(nome => !usados.has(nome));
  if (removidos) log('INFO', 'midia antiga removida', { arquivos: removidos });
}

// Antes de baixar: guarda só o que a programação nova usa e o que está na TV agora
// (numa troca de tela, a anterior segue no ar até a nova ficar pronta).
function liberarEspaco(slides) {
  const manter = new Set(slides.filter(s => s.url).map(s => nomeLocal(s.url)));
  if (playlistLocal) playlistLocal.slides.filter(s => s.url).forEach(s => manter.add(path.basename(s.url)));
  const removidos = removerMidias(nome => !manter.has(nome));
  if (removidos) log('INFO', 'espaco liberado antes de baixar', { arquivos: removidos });
}

// ── HEARTBEAT ────────────────────────────────────────────────────────────────
// Só repassa o aviso que o player manda: "Online" no painel tem de querer dizer
// "a TV está exibindo". Se o agente avisasse sozinho, o painel mostraria a tela
// online com o navegador fechado e a TV preta.
// IP deste aparelho na rede local, para o TI achar a Pi pelo painel (Aparelhos)
// em vez de adivinhar. Cabo antes de Wi-Fi; nunca o endereço interno.
function ipLocal() {
  const redes = os.networkInterfaces();
  const cabo = nome => /^(eth|en)/.test(nome) ? 0 : 1;
  const nomes = Object.keys(redes).sort((a, b) => cabo(a) - cabo(b));
  for (const nome of nomes) {
    for (const r of redes[nome] || []) {
      if ((r.family === 'IPv4' || r.family === 4) && !r.internal) return r.address;
    }
  }
  return null;
}

// ── REGISTRO NO PAINEL ───────────────────────────────────────────────────────
// A cada 15 s o aparelho diz ao servidor que está ligado e pergunta qual tela deve
// exibir. Servidor antigo (sem essa rota) ou fora do ar: segue com a última tela
// conhecida. Trocou a tela no painel: sincroniza na hora, sem esperar o ciclo.
async function registrar() {
  try {
    const corpo = JSON.stringify({ id: aparelho.id, nome: os.hostname(), ip: ipLocal(), tela_local: CONFIG.tela });
    const res = await pedir(CONFIG.servidor + '/api/aparelhos/registro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      corpo
    });
    if (res.statusCode !== 200) { res.resume(); return; }
    const nova = JSON.parse(await lerTudo(res)).screen_id || '';
    if (nova === telaAtual) return;
    log('INFO', nova ? 'tela escolhida no painel' : 'painel tirou a tela deste aparelho', { de: telaAtual || null, para: nova || null });
    telaAtual = nova;
    // Sem tela: aviso de "escolha a tela". Com tela nova: a anterior segue no ar
    // até a nova estar pronta (ver sincronizar).
    if (!nova) playlistLocal = null;
    salvarAparelho();
    // Um download da tela anterior não serve mais: interrompe e começa a nova já.
    if (cancelarDownload) cancelarDownload();
    sincronizar({ semEspera: true });
  } catch (e) { /* sem servidor: segue com a última tela conhecida */ }
}

async function heartbeat() {
  // Avisa a tela que está de fato na TV: numa troca, a anterior segue no ar até a
  // nova ficar pronta, e o painel não pode dar a nova como exibindo antes da hora.
  const exibida = playlistLocal && playlistLocal.screen && playlistLocal.screen.id ? playlistLocal.screen.id : telaAtual;
  if (!exibida) return;
  try {
    const corpo = JSON.stringify({ screen_id: exibida });
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
const arqPlayer = path.join(CONFIG.pasta, 'player.html');

// Baixa de novo a página do player de tempos em tempos. Antes ela era lida uma
// vez só, quando o agente subia: qualquer correção publicada no servidor só
// chegava à TV reiniciando o aparelho. O navegador pega a versão nova no
// recarregamento da meia-noite (ou num reinício).
async function atualizarPlayer() {
  try {
    // A página do player é a mesma para qualquer tela.
    const res = await pedir(CONFIG.servidor + '/player/' + encodeURIComponent(telaAtual || 'aparelho'));
    if (res.statusCode !== 200) { res.destroy(); return false; }
    const html = await lerTudo(res);
    if (html !== paginaPlayer) {
      const primeira = paginaPlayer === null;
      paginaPlayer = html;
      fs.writeFileSync(arqPlayer, html);
      if (!primeira) log('INFO', 'pagina do player atualizada', { bytes: Buffer.byteLength(html) });
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function obterPlayer() {
  if (paginaPlayer) return paginaPlayer;
  if (await atualizarPlayer()) return paginaPlayer;
  try {
    paginaPlayer = fs.readFileSync(arqPlayer, 'utf8');
    return paginaPlayer;
  } catch (e) { /* sem cópia local */ }
  // Sem servidor e sem cópia: mostra o aviso, mas não o guarda. Antes ele ficava
  // fixo na memória e a TV seguia no erro mesmo depois de o servidor voltar. E a
  // própria página tenta de novo a cada 30 s: sem isso, o navegador ficava no aviso
  // para sempre, porque ninguém recarrega a TV.
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"></head>' +
    '<body style="margin:0;background:#000"><h1 style="color:#fff;font-family:sans-serif;padding:24px">' +
    'CorporTV: sem contato com o servidor e sem cópia local do player. Tentando de novo a cada 30 segundos.</h1></body></html>';
}

// Sem rede, a Pi segue na última programação — mas só com o que ainda está dentro
// da validade que o servidor mandou (cache_for_ms, contada da consulta). Conteúdo
// vencido sai da TV mesmo com a rede fora. Online isso não muda nada: a programação
// é renovada a cada minuto.
function programacaoValida(p) {
  if (!p || !p.salvo_em) return p;
  const agora = Date.now();
  const slides = p.slides.filter(s => s.cache_for_ms === null || s.cache_for_ms === undefined ||
                                      p.salvo_em + s.cache_for_ms > agora);
  return slides.length === p.slides.length ? p : Object.assign({}, p, { slides });
}

function paginaAguardando() {
  const nome = os.hostname().replace(/[^\w .-]/g, '');
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">' +
    '<title>CorporTV</title></head><body style="margin:0;height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#000;color:#fff;font-family:sans-serif;text-align:center">' +
    '<div><h1 style="font-size:48px;margin:0 0 16px">CorporTV</h1>' +
    '<p style="font-size:28px">Este aparelho (<b>' + nome + '</b>) está pronto.</p>' +
    '<p style="font-size:24px;color:#aaa">Falta escolher a tela: no painel, Telas → Aparelhos.</p></div></body></html>';
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const caminho = decodeURIComponent(u.pathname);

  // A programação: sempre a versão local, com os arquivos que já estão no disco.
  if (caminho.startsWith('/api/player/')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // Sem tela: a marca de recarga muda e o player aberto recarrega, caindo no aviso
    // de "aguardando tela" em vez de ficar numa lista vazia.
    if (!telaAtual) return res.end(JSON.stringify({ screen: { id: '', reload_at: 'aguardando-tela' }, slides: [] }));
    return res.end(JSON.stringify(programacaoValida(playlistLocal) || { screen: { id: telaAtual }, slides: [] }));
  }

  // Heartbeat: o player chama a cada 20 s; repassamos ao servidor.
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
      aparelho: aparelho.id, nome: os.hostname(), ip: ipLocal(),
      tela: telaAtual || null, servidor: CONFIG.servidor,
      limite_mbps: CONFIG.limiteMbps,
      baixando: sincronizando,
      conteudos_prontos: playlistLocal ? playlistLocal.slides.length : 0,
      arquivos
    }, null, 2));
  }

  // Ainda sem tela escolhida: a TV mostra como resolver, e confere de novo sozinha.
  if (!telaAtual) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(paginaAguardando());
  }

  // Qualquer outra coisa: o player.
  const html = await obterPlayer();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});

servidor.listen(CONFIG.porta, '127.0.0.1', () => {
  log('INFO', 'agente iniciado', {
    aparelho: aparelho.id, tela: telaAtual || null, servidor: CONFIG.servidor,
    endereco: 'http://127.0.0.1:' + CONFIG.porta,
    limite_mbps: CONFIG.limiteMbps, cache: CONFIG.pasta
  });
  // Primeiro descobre a tela no painel, depois sincroniza.
  registrar().finally(() => sincronizar());
  setInterval(registrar, CONFIG.intervaloRegistroS * 1000);
  setInterval(sincronizar, CONFIG.intervaloProgramacaoS * 1000);
  atualizarPlayer();
  setInterval(atualizarPlayer, CONFIG.intervaloPlayerS * 1000);
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
