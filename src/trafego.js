'use strict';

// Monitor de tráfego do próprio CorporTV.
//
// Por quê: numa versão antiga, uma TV abrindo o sistema pelo navegador coincidiu com
// uma queda de rede em parte da empresa, e nunca deu para saber se a culpa era dele.
// Se a rede cair de novo, a primeira suspeita vai ser o CorporTV. Com isto dá para
// responder com números: quanto o CorporTV mandou, para quem e em que segundo.
//
// O que mede: tudo o que o servidor do CorporTV envia e recebe (TVs, Raspberrys,
// painel, envio de vídeos). A cada segundo lê o contador de bytes da conexão de cada
// resposta em andamento, então um vídeo longo entra no segundo em que os bytes saíram,
// e não de uma vez no fim. Fica gravado minuto a minuto, um arquivo por dia, por 35
// dias. NÃO mede o resto da rede — só o que passa pelo CorporTV.

const fs = require('fs');
const path = require('path');

const DIAS_GUARDADOS = 35;
const CLIENTES_POR_MINUTO = 20;
const MAX_PONTOS = 720;
const PASSOS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240];

function tipoDaRota(metodo, caminho) {
  if (caminho.startsWith('/uploads/') || /^\/api\/slides\/[^/]+\/arquivo$/.test(caminho)) return 'video';
  if (metodo === 'POST' && caminho === '/api/slides') return 'envio';
  if (caminho.startsWith('/pi/') || caminho === '/api/aparelhos/registro') return 'raspberry';
  if (caminho.startsWith('/api/player/') || caminho === '/api/heartbeat' || caminho.startsWith('/player/')) return 'tv';
  return 'painel';
}

function diaLocal(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function criarMonitor({ pasta, enderecoDoCliente, agora = () => Date.now(), log = () => {} }) {
  fs.mkdirSync(pasta, { recursive: true });
  const ativos = new Set();
  const minutos = new Map();
  const ultimos = [];
  let segundo = { t: Math.floor(agora() / 1000) * 1000, saida: 0, entrada: 0 };
  let ultimaLimpeza = 0;

  function minutoDe(t) { return Math.floor(t / 60000) * 60000; }

  function bucket(t) {
    let b = minutos.get(t);
    if (!b) {
      b = { t, saida: 0, entrada: 0, pedidos: 0, pico_bps: 0, pico_em: null, clientes: new Map(), tipos: {} };
      minutos.set(t, b);
    }
    return b;
  }

  function fecharSegundo(novo) {
    const bps = (segundo.saida + segundo.entrada) * 8;
    const b = bucket(minutoDe(segundo.t));
    if (bps > b.pico_bps) { b.pico_bps = bps; b.pico_em = segundo.t; }
    ultimos.push(segundo);
    while (ultimos.length > 60) ultimos.shift();
    segundo = { t: novo, saida: 0, entrada: 0 };
  }

  function somar(info, saida, entrada) {
    if (!saida && !entrada) return;
    const t = agora();
    const s = Math.floor(t / 1000) * 1000;
    if (s !== segundo.t) fecharSegundo(s);
    segundo.saida += saida;
    segundo.entrada += entrada;
    const b = bucket(minutoDe(t));
    b.saida += saida;
    b.entrada += entrada;
    const c = b.clientes.get(info.cliente) || { saida: 0, entrada: 0, pedidos: 0 };
    c.saida += saida;
    c.entrada += entrada;
    b.clientes.set(info.cliente, c);
    const tipo = b.tipos[info.tipo] || (b.tipos[info.tipo] = { saida: 0, entrada: 0 });
    tipo.saida += saida;
    tipo.entrada += entrada;
  }

  function amostrar(info) {
    const w = info.socket.bytesWritten || 0;
    const r = info.socket.bytesRead || 0;
    const dw = Math.max(0, w - info.w);
    const dr = Math.max(0, r - info.r);
    info.w = w;
    info.r = r;
    somar(info, dw, dr);
  }

  function middleware(req, res, next) {
    const socket = req.socket;
    if (!socket) return next();
    const info = {
      socket,
      cliente: enderecoDoCliente(req) || 'desconhecido',
      tipo: tipoDaRota(req.method, req.path),
      w: socket.bytesWritten || 0,
      r: socket.bytesRead || 0
    };
    ativos.add(info);
    const b = bucket(minutoDe(agora()));
    b.pedidos++;
    const c = b.clientes.get(info.cliente) || { saida: 0, entrada: 0, pedidos: 0 };
    c.pedidos++;
    b.clientes.set(info.cliente, c);
    let terminou = false;
    const terminar = () => {
      if (terminou) return;
      terminou = true;
      amostrar(info);
      ativos.delete(info);
    };
    res.on('finish', terminar);
    res.on('close', terminar);
    next();
  }

  function linhaDoMinuto(b) {
    const clientes = [...b.clientes.entries()]
      .sort((x, y) => (y[1].saida + y[1].entrada) - (x[1].saida + x[1].entrada))
      .slice(0, CLIENTES_POR_MINUTO)
      .map(([ip, c]) => [ip, c.saida, c.entrada, c.pedidos]);
    return { t: b.t, saida: b.saida, entrada: b.entrada, pedidos: b.pedidos, pico_bps: b.pico_bps, pico_em: b.pico_em, tipos: b.tipos, clientes };
  }

  // Grava os minutos já fechados (com um minuto de folga para o último segundo) e
  // apaga arquivos mais velhos que 35 dias.
  function gravar(tudo) {
    const limite = tudo ? Infinity : minutoDe(agora()) - 60000;
    const porDia = new Map();
    for (const [t, b] of minutos) {
      if (t >= limite) continue;
      const dia = diaLocal(t);
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(JSON.stringify(linhaDoMinuto(b)));
      minutos.delete(t);
    }
    for (const [dia, linhas] of porDia) {
      try {
        fs.appendFileSync(path.join(pasta, `trafego-${dia}.jsonl`), linhas.join('\n') + '\n');
      } catch (err) {
        log('ERRO', 'nao consegui gravar o trafego', { dia, msg: err.message });
      }
    }
    if (agora() - ultimaLimpeza > 3600000) {
      ultimaLimpeza = agora();
      const corte = diaLocal(agora() - DIAS_GUARDADOS * 86400000);
      for (const arq of fs.readdirSync(pasta)) {
        const m = /^trafego-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(arq);
        if (m && m[1] < corte) { try { fs.unlinkSync(path.join(pasta, arq)); } catch (e) { /* tenta na próxima */ } }
      }
    }
  }

  function tique() {
    for (const info of ativos) amostrar(info);
    const s = Math.floor(agora() / 1000) * 1000;
    if (s !== segundo.t) fecharSegundo(s);
    gravar(false);
  }

  let timer = null;
  function iniciar() {
    if (!timer) { timer = setInterval(tique, 1000); timer.unref(); }
  }
  function parar() {
    if (timer) { clearInterval(timer); timer = null; }
    tique();
    gravar(true);
  }

  function lerMinutos(de, ate) {
    const lista = [];
    for (let d = minutoDe(de) - 86400000; d <= ate + 86400000; d += 86400000) {
      const arq = path.join(pasta, `trafego-${diaLocal(d)}.jsonl`);
      if (!fs.existsSync(arq)) continue;
      for (const linha of fs.readFileSync(arq, 'utf8').split('\n')) {
        if (!linha) continue;
        try {
          const m = JSON.parse(linha);
          if (m.t >= de && m.t < ate) lista.push(m);
        } catch (e) { /* linha cortada por queda de energia: ignora */ }
      }
    }
    for (const b of minutos.values()) if (b.t >= de && b.t < ate) lista.push(linhaDoMinuto(b));
    // O mesmo minuto pode aparecer mais de uma vez (o serviço reiniciou no meio dele):
    // soma as partes.
    const porMinuto = new Map();
    for (const m of lista) {
      const ja = porMinuto.get(m.t);
      if (!ja) {
        const tipos = Object.fromEntries(Object.entries(m.tipos || {}).map(([k, v]) => [k, { ...v }]));
        porMinuto.set(m.t, { ...m, tipos, clientes: [...(m.clientes || [])] });
        continue;
      }
      ja.saida += m.saida; ja.entrada += m.entrada; ja.pedidos += m.pedidos || 0;
      if ((m.pico_bps || 0) > (ja.pico_bps || 0)) { ja.pico_bps = m.pico_bps; ja.pico_em = m.pico_em; }
      ja.clientes.push(...(m.clientes || []));
      for (const [tipo, v] of Object.entries(m.tipos || {})) {
        const x = ja.tipos[tipo] || (ja.tipos[tipo] = { saida: 0, entrada: 0 });
        x.saida += v.saida; x.entrada += v.entrada;
      }
    }
    return [...porMinuto.values()].sort((a, b) => a.t - b.t);
  }

  // Resumo de um período: série (no máximo 720 pontos), totais, pico, clientes e tipos.
  function consultar(de, ate) {
    const lista = lerMinutos(de, ate);
    const minutosNoPeriodo = Math.max(1, Math.ceil((ate - de) / 60000));
    const passo = PASSOS_MIN.find(p => minutosNoPeriodo / p <= MAX_PONTOS) || PASSOS_MIN[PASSOS_MIN.length - 1];
    const passoMs = passo * 60000;
    // Intervalos no relógio cheio (10:40, 10:45...), e não a partir do segundo em que
    // a consulta começou: o pico das 10:42 aparece no ponto das 10:42.
    const base = Math.floor(de / passoMs) * passoMs;
    const pontos = new Map();
    const total = { saida: 0, entrada: 0, pedidos: 0 };
    let pico = { bps: 0, em: null };
    const clientes = new Map();
    const tipos = {};
    for (const m of lista) {
      const t = base + Math.floor((m.t - base) / passoMs) * passoMs;
      const p = pontos.get(t) || { t, bytes: 0, pico_bps: 0 };
      p.bytes += m.saida + m.entrada;
      p.pico_bps = Math.max(p.pico_bps, m.pico_bps || 0);
      pontos.set(t, p);
      total.saida += m.saida;
      total.entrada += m.entrada;
      total.pedidos += m.pedidos || 0;
      if ((m.pico_bps || 0) > pico.bps) pico = { bps: m.pico_bps, em: m.pico_em || m.t };
      for (const [ip, s, e, n] of m.clientes || []) {
        const c = clientes.get(ip) || { endereco: ip, saida: 0, entrada: 0, pedidos: 0 };
        c.saida += s; c.entrada += e; c.pedidos += n;
        clientes.set(ip, c);
      }
      for (const [tipo, v] of Object.entries(m.tipos || {})) {
        const x = tipos[tipo] || (tipos[tipo] = { saida: 0, entrada: 0 });
        x.saida += v.saida; x.entrada += v.entrada;
      }
    }
    const serie = [];
    for (let t = base; t < ate; t += passoMs) {
      const p = pontos.get(t);
      const bytes = p ? p.bytes : 0;
      serie.push({ t, media_mbps: +((bytes * 8) / (passo * 60) / 1e6).toFixed(3), pico_mbps: +((p ? p.pico_bps : 0) / 1e6).toFixed(3), mb: +(bytes / 1048576).toFixed(2) });
    }
    return {
      de, ate, passo_min: passo,
      total: { ...total, mb: +((total.saida + total.entrada) / 1048576).toFixed(1), media_mbps: +(((total.saida + total.entrada) * 8) / ((ate - de) / 1000) / 1e6).toFixed(3) },
      pico: { mbps: +(pico.bps / 1e6).toFixed(3), em: pico.em },
      clientes: [...clientes.values()].sort((a, b) => (b.saida + b.entrada) - (a.saida + a.entrada)).slice(0, 15),
      tipos,
      serie,
      minutos: lista
    };
  }

  function agoraResumo() {
    const lista = ultimos.slice(-60);
    const dez = lista.slice(-10);
    const bytes = dez.reduce((s, x) => s + x.saida + x.entrada, 0);
    return {
      mbps: +((bytes * 8) / Math.max(1, dez.length) / 1e6).toFixed(3),
      ultimos: lista.map(x => ({ t: x.t, mbps: +(((x.saida + x.entrada) * 8) / 1e6).toFixed(3) })),
      conexoes: ativos.size
    };
  }

  return { middleware, iniciar, parar, consultar, agoraResumo, tique, tipoDaRota };
}

module.exports = { criarMonitor, tipoDaRota, diaLocal };
