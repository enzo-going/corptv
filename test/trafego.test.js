'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { criarMonitor, tipoDaRota, diaLocal } = require('../src/trafego');

// Relógio e conexões simuladas: o monitor só lê socket.bytesWritten/bytesRead.
function ambiente(pasta, inicio) {
  let agora = inicio;
  const monitor = criarMonitor({ pasta, enderecoDoCliente: req => req.cliente, agora: () => agora });
  return {
    monitor,
    avancar(ms) { agora += ms; monitor.tique(); },
    pedido(cliente, caminho, metodo = 'GET') {
      const socket = { bytesWritten: 0, bytesRead: 0 };
      const res = new EventEmitter();
      monitor.middleware({ socket, cliente, path: caminho, method: metodo, headers: {} }, res, () => {});
      return { socket, fim: () => res.emit('finish') };
    }
  };
}

test('conta cada segundo em que os bytes saíram, por cliente e por tipo', async t => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-trafego-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 5 }));
  const inicio = new Date(2026, 9, 7, 10, 0, 0).getTime();
  const a = ambiente(pasta, inicio);
  // Uma TV puxa um vídeo por 3 s (1 MB/s = 8 Mb/s no 2º segundo); o painel, pouca coisa.
  // A cada segundo o monitor lê quanto saiu desde a leitura anterior.
  const video = a.pedido('192.0.2.10', '/uploads/abc.mp4');
  video.socket.bytesWritten += 250000; a.avancar(1000);
  video.socket.bytesWritten += 1000000; a.avancar(1000);
  video.socket.bytesWritten += 250000; a.avancar(1000); video.fim();
  const painel = a.pedido('192.0.2.20', '/api/slides');
  painel.socket.bytesWritten += 5000; painel.socket.bytesRead += 300; painel.fim();
  a.avancar(1000);

  const r = a.monitor.consultar(inicio, inicio + 60000);
  assert.equal(r.total.saida, 1505000);
  assert.equal(r.total.entrada, 300);
  assert.equal(r.total.pedidos, 2);
  // O pico é do segundo, não da média do minuto: é o que derruba uma rede.
  assert.equal(r.pico.mbps, 8);
  assert.equal(r.pico.em, inicio + 2000);
  assert.equal(r.clientes[0].endereco, '192.0.2.10');
  assert.equal(r.clientes[0].saida, 1500000);
  assert.equal(r.tipos.video.saida, 1500000);
  assert.equal(r.tipos.painel.saida, 5000);
  assert.equal(r.passo_min, 1);
  assert.equal(r.serie.length, 1);
});

test('grava minuto a minuto, outra instância lê de volta, e apaga o que passou de 35 dias', async t => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-trafego-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 5 }));
  const inicio = new Date(2026, 9, 7, 9, 0, 0).getTime();
  const velho = path.join(pasta, `trafego-${diaLocal(inicio - 40 * 86400000)}.jsonl`);
  const recente = path.join(pasta, `trafego-${diaLocal(inicio - 3 * 86400000)}.jsonl`);
  fs.writeFileSync(velho, '');
  fs.writeFileSync(recente, '');
  const a = ambiente(pasta, inicio);
  const p = a.pedido('192.0.2.30', '/api/player/tv-1');
  p.socket.bytesWritten += 2048; p.fim();
  a.avancar(3 * 60000);
  const arquivo = path.join(pasta, `trafego-${diaLocal(inicio)}.jsonl`);
  assert.ok(fs.existsSync(arquivo), 'o minuto fechado foi gravado');
  assert.equal(fs.existsSync(velho), false, 'arquivo de mais de 35 dias sai');
  assert.equal(fs.existsSync(recente), true);
  // Linha cortada no meio (queda de energia) é ignorada, não derruba a leitura.
  fs.appendFileSync(arquivo, '{"t":12');
  const outra = ambiente(pasta, inicio + 5 * 60000);
  const r = outra.monitor.consultar(inicio, inicio + 10 * 60000);
  assert.equal(r.total.saida, 2048);
  assert.equal(r.tipos.tv.saida, 2048);
});

test('período longo vira no máximo 720 pontos', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-trafego-'));
  try {
    const inicio = new Date(2026, 9, 1).getTime();
    const a = ambiente(pasta, inicio);
    assert.equal(a.monitor.consultar(inicio, inicio + 86400000).passo_min, 2);
    const semana = a.monitor.consultar(inicio, inicio + 7 * 86400000);
    assert.ok(semana.serie.length <= 720);
    assert.equal(semana.passo_min, 15);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('cada rota cai no tipo certo', () => {
  assert.equal(tipoDaRota('GET', '/uploads/x.mp4'), 'video');
  assert.equal(tipoDaRota('POST', '/api/slides'), 'envio');
  assert.equal(tipoDaRota('POST', '/api/aparelhos/registro'), 'raspberry');
  assert.equal(tipoDaRota('GET', '/pi/preparar.sh'), 'raspberry');
  assert.equal(tipoDaRota('GET', '/api/player/tv-1'), 'tv');
  assert.equal(tipoDaRota('POST', '/api/heartbeat'), 'tv');
  assert.equal(tipoDaRota('GET', '/api/slides'), 'painel');
});

test('a página Rede é do TI, com gráfico acessível, resumo e exportação', () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  assert.ok(painel.includes(`<button class="nav-item" data-admin-only hidden onclick="goTo('rede',this)">`));
  assert.ok(painel.includes("p==='rede')&&(!permissions||!permissions.users)"));
  assert.ok(painel.includes('<div class="page" id="page-rede">'));
  assert.ok(painel.includes('id="rede-exportar" href="/api/trafego/exportar"'));
  assert.ok(painel.includes("svg.setAttribute('role','img');svg.setAttribute('tabindex','0');"), 'gráfico com teclado e leitor de tela');
  assert.ok(painel.includes("if(ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight')return;"));
  // Texto do detalhe por textContent (nome de aparelho vem da rede).
  assert.ok(!/rede-tooltip[^\n]*innerHTML/.test(painel));
  assert.ok(painel.includes("o CorporTV usou em média"));
  // A página para de consultar "agora" quando sai dela.
  assert.ok(painel.includes("if(p==='rede')abrirRede();else fecharRede();"));
});
