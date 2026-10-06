'use strict';

// Otimização de vídeo no servidor.
//
// Quem publica não é do TI: sobe o vídeo do jeito que saiu da câmera ou da agência
// (no caso real, 641 MB para 4 minutos). Esse arquivo, como veio, não serve para TV:
// tocando direto do servidor, cada tela puxaria ~20 Mb/s (o teto de toda a rede do
// CorporTV é 12 Mb/s); numa Raspberry, a 2 Mb/s, levaria ~45 min para chegar.
//
// Então o servidor converte sozinho para o padrão das TVs — o mesmo do conversor
// manual (ferramentas/Otimizar-Video.bat): até 1280x720, H.264, ~2,8 Mb/s, AAC e
// "início rápido" (faststart). Um vídeo por vez, com prioridade baixa e poucos
// núcleos, porque a máquina é compartilhada. Enquanto converte, o conteúdo fica na
// biblioteca com "otimizando" e não vai para nenhuma TV.
//
// Vídeo que já está no padrão (H.264, até 1080p, até 5 Mb/s, com início rápido)
// passa como veio: sem perder qualidade nem gastar processador.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PADRAO = { largura: 1280, altura: 720, fps: 30, videoK: 2800, maxK: 3000, bufK: 6000, audioK: 128 };
const ACEITA_COMO_VEIO = { maiorLado: 1920, menorLado: 1080, mbps: 5 };

// ── FERRAMENTAS ──────────────────────────────────────────
// Procura o ffmpeg/ffprobe na ordem: variável de ambiente, pasta runtime\ do
// CorporTV (fora do Git, como o node.exe próprio) e o PATH do sistema.
// CORPTV_FFMPEG=desligado desliga a otimização (e o limite de envio volta a 200 MB).
function localizarFerramentas(env, raizApp) {
  const ambiente = env || process.env;
  if (/^(0|off|desligad[oa]|nao|não)$/i.test(String(ambiente.CORPTV_FFMPEG || '').trim())) return null;
  const funciona = programa => {
    try {
      const r = spawnSync(programa, ['-version'], { timeout: 15000, windowsHide: true, stdio: 'ignore' });
      return r.status === 0;
    } catch (e) {
      return false;
    }
  };
  const achar = (nome, variavel) => {
    const exe = process.platform === 'win32' ? nome + '.exe' : nome;
    const candidatos = [ambiente[variavel], raizApp && path.join(raizApp, 'runtime', exe), nome].filter(Boolean);
    return candidatos.find(funciona) || null;
  };
  const ffmpeg = achar('ffmpeg', 'CORPTV_FFMPEG');
  const ffprobe = ffmpeg && achar('ffprobe', 'CORPTV_FFPROBE');
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

// ── ANÁLISE ──────────────────────────────────────────────
function rodar(programa, args, limiteMs) {
  return new Promise((resolve, reject) => {
    const filho = spawn(programa, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    const timer = setTimeout(() => filho.kill(), limiteMs);
    filho.stdout.on('data', d => { saida += d; });
    filho.stderr.on('data', d => { erro = (erro + d).slice(-4000); });
    filho.on('error', err => { clearTimeout(timer); reject(err); });
    filho.on('close', codigo => {
      clearTimeout(timer);
      if (codigo === 0) resolve(saida);
      else reject(new Error(erro.trim().split('\n').pop() || 'saiu com código ' + codigo));
    });
  });
}

async function sondar(ferramentas, arquivo) {
  const json = await rodar(ferramentas.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', arquivo], 60000);
  const dados = JSON.parse(json);
  const fluxos = dados.streams || [];
  const video = fluxos.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = fluxos.find(s => s.codec_type === 'audio');
  if (!video) throw new Error('o arquivo não tem vídeo');
  const formato = dados.format || {};
  const duracao = parseFloat(formato.duration || video.duration) || 0;
  const tamanho = parseInt(formato.size, 10) || 0;
  const bps = parseInt(formato.bit_rate, 10) || (duracao ? (tamanho * 8) / duracao : 0);
  return {
    codec: video.codec_name || '',
    largura: video.width || 0,
    altura: video.height || 0,
    pixFmt: video.pix_fmt || '',
    audio: audio ? audio.codec_name : null,
    duracaoS: duracao,
    mbps: +(bps / 1e6).toFixed(2)
  };
}

// "Início rápido": o índice do vídeo (moov) vem antes dos dados (mdat). Sem isso o
// navegador precisa do arquivo inteiro antes do primeiro quadro.
async function inicioRapido(arquivo) {
  const fh = await fs.promises.open(arquivo, 'r');
  try {
    const { size } = await fh.stat();
    const cab = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      const { bytesRead } = await fh.read(cab, 0, 16, pos);
      if (bytesRead < 8) break;
      let tam = cab.readUInt32BE(0);
      const tipo = cab.toString('latin1', 4, 8);
      if (tipo === 'moov') return true;
      if (tipo === 'mdat') return false;
      if (tam === 1) {
        if (bytesRead < 16) break;
        tam = Number(cab.readBigUInt64BE(8));
      } else if (tam === 0) {
        break;
      }
      if (tam < 8) break;
      pos += tam;
    }
    return false;
  } finally {
    await fh.close();
  }
}

// Decide o que fazer com o vídeo: nada, só reorganizar (rápido, sem recomprimir) ou
// converter. Devolve também os motivos, para o log e para o painel.
function plano(info, comInicioRapido) {
  const motivos = [];
  const maior = Math.max(info.largura, info.altura);
  const menor = Math.min(info.largura, info.altura);
  if (info.codec !== 'h264') motivos.push('formato ' + (info.codec || 'desconhecido'));
  if (maior > ACEITA_COMO_VEIO.maiorLado || menor > ACEITA_COMO_VEIO.menorLado) motivos.push(`resolução ${info.largura}x${info.altura}`);
  if (info.mbps > ACEITA_COMO_VEIO.mbps) motivos.push(`${info.mbps} Mb/s`);
  if (info.pixFmt && info.pixFmt !== 'yuv420p') motivos.push('cor ' + info.pixFmt);
  if (info.audio && !['aac', 'mp3'].includes(info.audio)) motivos.push('áudio ' + info.audio);
  if (motivos.length) return { modo: 'converter', motivos };
  if (!comInicioRapido) return { modo: 'reorganizar', motivos: ['sem início rápido'] };
  return { modo: null, motivos: [] };
}

async function analisar(ferramentas, arquivo) {
  const info = await sondar(ferramentas, arquivo);
  return Object.assign({ info }, plano(info, await inicioRapido(arquivo)));
}

// ── CONVERSÃO ────────────────────────────────────────────
function argumentos(entrada, saida, modo, threads) {
  const inicio = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', String(threads), '-i', entrada,
    '-map', '0:v:0', '-map', '0:a:0?'];
  const fim = ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', saida];
  if (modo === 'reorganizar') return [...inicio, '-c', 'copy', ...fim];
  return [...inicio,
    // Cabe em 1280x720 sem distorcer: vídeo de celular em pé vira 405x720, não 1280x2276.
    '-vf', `scale=w=${PADRAO.largura}:h=${PADRAO.altura}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-r', String(PADRAO.fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
    '-b:v', PADRAO.videoK + 'k', '-maxrate', PADRAO.maxK + 'k', '-bufsize', PADRAO.bufK + 'k',
    '-threads', String(threads),
    '-c:a', 'aac', '-b:a', PADRAO.audioK + 'k', '-ar', '44100', '-ac', '2',
    ...fim];
}

// Lê o "-progress pipe:1" do ffmpeg (linhas chave=valor) e devolve o percentual.
function lerProgresso(texto, duracaoS) {
  const achados = [...String(texto).matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)];
  if (!achados.length || !duracaoS) return null;
  const us = parseInt(achados[achados.length - 1][1], 10);
  return Math.max(0, Math.min(99, Math.floor((us / 1e6 / duracaoS) * 100)));
}

function converter(ferramentas, entrada, saida, opcoes) {
  const { modo, duracaoS, threads, aoProgresso, limiteMs } = opcoes;
  return new Promise((resolve, reject) => {
    const filho = spawn(ferramentas.ffmpeg, argumentos(entrada, saida, modo, threads),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // A máquina é compartilhada (no CAMPS, o controlador de domínio): o CorporTV
    // nunca disputa processador de igual para igual com os outros serviços.
    try { os.setPriority(filho.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* sem permissão: segue */ }
    let erro = '';
    let resto = '';
    const timer = setTimeout(() => { filho.kill(); }, limiteMs);
    filho.stdout.on('data', d => {
      resto = (resto + d).slice(-2000);
      const p = lerProgresso(resto, duracaoS);
      if (p !== null && aoProgresso) aoProgresso(p);
    });
    filho.stderr.on('data', d => { erro = (erro + d).slice(-4000); });
    filho.on('error', err => { clearTimeout(timer); reject(err); });
    filho.on('close', (codigo, sinal) => {
      clearTimeout(timer);
      if (codigo === 0) return resolve();
      const ultima = erro.trim().split('\n').pop();
      reject(new Error(sinal ? 'conversão interrompida' : (ultima || 'ffmpeg saiu com código ' + codigo)));
    });
    opcoes.aoIniciar && opcoes.aoIniciar(filho);
  });
}

// ── FILA ─────────────────────────────────────────────────
// Um vídeo por vez. O estado mora no próprio conteúdo (slide.otimizacao), então
// sobrevive a reinício do servidor: o que estava "otimizando" volta para a fila.
function criarFila({ ferramentas, uploadsDir, db, log, novoNome, caminhoDaUrl, removerArquivo, threads, limiteMs }) {
  const fila = [];
  const progresso = new Map();
  let atual = null;

  async function falhou(id, motivo) {
    await db.slides.update({ id }, { $set: { 'otimizacao.estado': 'falhou', 'otimizacao.erro': motivo } });
  }

  async function processar(id) {
    const slide = await db.slides.findOne({ id });
    if (!slide || !slide.otimizacao || slide.otimizacao.estado !== 'otimizando') return;
    const entrada = caminhoDaUrl(slide.url);
    if (!entrada || !fs.existsSync(entrada)) return falhou(id, 'o arquivo enviado não foi encontrado no servidor');

    const nome = novoNome();
    const saida = path.join(uploadsDir, nome);
    const temporario = saida + '.otimizando';
    const inicio = Date.now();
    const de = fs.statSync(entrada).size;
    progresso.set(id, 0);
    try {
      let duracaoS = slide.otimizacao.duracao_s;
      if (!duracaoS) duracaoS = (await sondar(ferramentas, entrada)).duracaoS;
      await converter(ferramentas, entrada, temporario, {
        modo: slide.otimizacao.modo, duracaoS, threads, limiteMs,
        aoProgresso: p => progresso.set(id, p),
        aoIniciar: filho => {
          atual.filho = filho;
          atual.fim = new Promise(resolve => filho.once('close', resolve));
        }
      });
      const resultado = await sondar(ferramentas, temporario);
      if (duracaoS && Math.abs(resultado.duracaoS - duracaoS) > Math.max(2, duracaoS * 0.02)) {
        throw new Error(`a duração mudou na conversão (${Math.round(duracaoS)} s → ${Math.round(resultado.duracaoS)} s)`);
      }
      fs.renameSync(temporario, saida);
      const para = fs.statSync(saida).size;
      // Excluído durante a conversão: não sobra arquivo para trás.
      if (!(await db.slides.findOne({ id }))) {
        await removerArquivo(saida).catch(() => {});
        await removerArquivo(entrada).catch(() => {});
        return;
      }
      await db.slides.update({ id }, { $set: {
        url: '/uploads/' + nome,
        otimizacao: {
          estado: 'pronto', modo: slide.otimizacao.modo,
          de_mb: +(de / 1048576).toFixed(1), para_mb: +(para / 1048576).toFixed(1),
          segundos: Math.round((Date.now() - inicio) / 1000), em: new Date()
        }
      } });
      await removerArquivo(entrada).catch(err => log('AVISO', 'não consegui apagar o vídeo original', { slide: id, msg: err.message }));
      log('INFO', 'vídeo otimizado', {
        slide: id, modo: slide.otimizacao.modo, de_mb: +(de / 1048576).toFixed(1),
        para_mb: +(para / 1048576).toFixed(1), seg: Math.round((Date.now() - inicio) / 1000)
      });
    } catch (err) {
      try { fs.unlinkSync(temporario); } catch (e) { /* não chegou a criar */ }
      // Excluído durante a conversão: no Windows o original ainda estava aberto pelo
      // ffmpeg quando a exclusão tentou apagá-lo, então apaga agora.
      if (!(await db.slides.findOne({ id }))) {
        await removerArquivo(entrada).catch(() => {});
        return;
      }
      if (atual && atual.cancelado) return;
      log('AVISO', 'não consegui otimizar o vídeo', { slide: id, msg: err.message });
      await falhou(id, String(err.message || 'erro desconhecido').slice(0, 300));
    } finally {
      progresso.delete(id);
    }
  }

  async function proxima() {
    if (atual || !fila.length) return;
    atual = { id: fila.shift(), filho: null, cancelado: false };
    try {
      await processar(atual.id);
    } catch (err) {
      log('ERRO', 'falha na fila de otimização', { slide: atual.id, msg: err.message });
    } finally {
      atual = null;
      setImmediate(proxima);
    }
  }

  return {
    enfileirar(id) {
      if (!fila.includes(id) && !(atual && atual.id === id)) fila.push(id);
      setImmediate(proxima);
    },
    // Conteúdo excluído: tira da fila ou interrompe a conversão em andamento. Resolve
    // quando o ffmpeg já fechou o arquivo (no Windows, antes disso ele não sai do disco).
    async cancelar(id) {
      const i = fila.indexOf(id);
      if (i >= 0) fila.splice(i, 1);
      if (atual && atual.id === id) {
        atual.cancelado = true;
        if (atual.filho) {
          const fim = atual.fim;
          atual.filho.kill();
          await Promise.race([fim, new Promise(r => setTimeout(r, 10000))]);
        }
      }
    },
    percentual(id) { return progresso.has(id) ? progresso.get(id) : null; },
    posicao(id) { return atual && atual.id === id ? 0 : (fila.indexOf(id) >= 0 ? fila.indexOf(id) + 1 : null); },
    ocupada() { return !!atual || fila.length > 0; },
    // Depois de reiniciar: apaga conversões pela metade e retoma o que estava na fila.
    async retomar() {
      for (const arq of fs.readdirSync(uploadsDir)) {
        if (arq.endsWith('.otimizando')) { try { fs.unlinkSync(path.join(uploadsDir, arq)); } catch (e) { /* em uso */ } }
      }
      const pendentes = await db.slides.find({ 'otimizacao.estado': 'otimizando' }).sort({ created_at: 1 });
      pendentes.forEach(s => this.enfileirar(s.id));
      if (pendentes.length) log('INFO', 'retomando otimização de vídeos', { quantidade: pendentes.length });
    }
  };
}

module.exports = { PADRAO, ACEITA_COMO_VEIO, localizarFerramentas, sondar, inicioRapido, plano, analisar, argumentos, lerProgresso, converter, criarFila };
