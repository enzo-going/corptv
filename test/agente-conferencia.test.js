'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const limparTemporario = require('./limpar-temporario');

const ARQUIVO = '11112222-3333-4444-5555-666677778888.mp4';
const MIDIA = Buffer.alloc(200 * 1024, 0x33);
const sha = conteudo => crypto.createHash('sha256').update(conteudo).digest('hex');
const esperarMs = ms => new Promise(r => setTimeout(r, ms));

async function esperar(condicao, descricao, limiteMs = 20000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await esperarMs(100);
  }
  throw new Error('tempo esgotado esperando: ' + descricao);
}

// Servidor de mentira com uma tela e um vídeo; `sha256` é o hash que ele anuncia.
async function iniciar(t, { sha256, estadoAntes, arquivoAntes } = {}) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-conferencia-'));
  t.after(() => limparTemporario(cache));
  if (arquivoAntes) fs.writeFileSync(path.join(cache, ARQUIVO), arquivoAntes);
  if (estadoAntes) fs.writeFileSync(path.join(cache, 'estado.json'), JSON.stringify(estadoAntes));

  const contagem = { downloads: 0 };
  const servidor = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/api/player/sala') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        screen: { id: 'sala', name: 'Sala' },
        slides: [{ id: 's1', type: 'video', duration: 10, url: '/uploads/' + ARQUIVO, sha256 }]
      }));
    }
    if (pathname === '/uploads/' + ARQUIVO) {
      res.setHeader('ETag', '"v1"');
      res.setHeader('Content-Length', MIDIA.length);
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      contagem.downloads++;
      res.writeHead(200);
      return res.end(MIDIA);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));

  const reserva = net.createServer();
  await new Promise(resolve => reserva.listen(0, '127.0.0.1', resolve));
  const porta = reserva.address().port;
  await new Promise(resolve => reserva.close(resolve));

  const agente = spawn(process.execPath, [path.join(__dirname, '../agente/agente.js')], {
    env: {
      ...process.env, CORPTV_CACHE: cache, CORPTV_TELA: 'sala', CORPTV_PORTA: String(porta),
      CORPTV_SERVIDOR: `http://127.0.0.1:${servidor.address().port}`,
      CORPTV_LIMITE_MBPS: '0', CORPTV_JITTER: '0', CORPTV_INTERVALO: '1',
      CORPTV_INTERVALO_REGISTRO: '1', CORPTV_INTERVALO_PLAYER: '60'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (agente.exitCode === null) {
      agente.kill();
      await new Promise(resolve => agente.once('exit', resolve));
    }
  });

  const status = async () => {
    try { return await (await fetch(`http://127.0.0.1:${porta}/status`)).json(); } catch (e) { return null; }
  };
  const estado = () => JSON.parse(fs.readFileSync(path.join(cache, 'estado.json'), 'utf8'));
  const programacao = async () => (await (await fetch(`http://127.0.0.1:${porta}/api/player/x`)).json()).slides;
  return { cache, contagem, status, estado, programacao };
}

test('vídeo que confere com o hash do servidor vai para a TV e o hash fica registrado', async t => {
  const { cache, contagem, estado, programacao } = await iniciar(t, { sha256: sha(MIDIA) });
  await esperar(async () => (await programacao().catch(() => [])).length === 1, 'o vídeo entrar na programação');
  assert.deepEqual(fs.readFileSync(path.join(cache, ARQUIVO)), MIDIA);
  assert.equal(estado()[ARQUIVO].sha256, sha(MIDIA));
  assert.equal(contagem.downloads, 1);
});

test('vídeo que chega com defeito não vai para a TV e, na segunda vez, espera antes de baixar de novo', async t => {
  const { cache, contagem, status, programacao } = await iniciar(t, { sha256: sha('outro conteudo') });
  await esperar(() => contagem.downloads >= 2, 'duas tentativas de download');
  await esperarMs(3500); // mais três ciclos de sincronização

  assert.equal(contagem.downloads, 2, 'depois de dois defeitos seguidos, não pode baixar a cada minuto');
  assert.equal(fs.existsSync(path.join(cache, ARQUIVO)), false, 'arquivo com defeito não pode ir para o lugar');
  assert.equal(fs.existsSync(path.join(cache, ARQUIVO + '.parcial')), false, 'retomar em cima de bytes errados repetiria o erro');
  assert.deepEqual(await programacao(), []);
  assert.equal((await status()).arquivos.length, 0);
});

test('vídeo baixado antes da conferência é conferido no cartão, sem baixar de novo', async t => {
  const { contagem, estado, programacao } = await iniciar(t, {
    sha256: sha(MIDIA),
    arquivoAntes: MIDIA,
    estadoAntes: { [ARQUIVO]: { etag: '"v1"', tamanho: MIDIA.length, em: '2026-01-01T00:00:00.000Z' } }
  });
  await esperar(() => estado()[ARQUIVO].sha256 === sha(MIDIA), 'o hash conferido no cartão ser registrado');
  await esperarMs(1500);
  assert.equal(contagem.downloads, 0, 'conferir no cartão não usa a rede');
  assert.equal((await programacao()).length, 1);
});

test('vídeo guardado com defeito antes da conferência é baixado de novo', async t => {
  const estragado = Buffer.alloc(MIDIA.length, 0x44); // mesmo tamanho, bytes errados
  const { cache, contagem, estado } = await iniciar(t, {
    sha256: sha(MIDIA),
    arquivoAntes: estragado,
    estadoAntes: { [ARQUIVO]: { etag: '"v1"', tamanho: MIDIA.length, em: '2026-01-01T00:00:00.000Z' } }
  });
  await esperar(() => estado()[ARQUIVO].sha256 === sha(MIDIA), 'o vídeo certo ser baixado e registrado');
  assert.equal(contagem.downloads, 1);
  assert.deepEqual(fs.readFileSync(path.join(cache, ARQUIVO)), MIDIA);
});
