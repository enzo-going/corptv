'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const agenteJs = path.join(__dirname, '../agente/agente.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-agente-'));
const cache = path.join(sandbox, 'cache');

const ARQUIVO = 'aabbccdd-1111-2222-3333-444455556666.mp4';
const TELA = 'recepcao';

// Mídia de mentira: previsível e grande o bastante para não caber num pacote só.
const MIDIA_V1 = Buffer.alloc(256 * 1024, 0x11);
const MIDIA_V2 = Buffer.alloc(300 * 1024, 0x22);

const servidor = {
  midia: MIDIA_V1,
  etag: '"v1"',
  playlist: null,
  paginaPlayer: '<html><body>player v1</body></html>',
  heartbeats: 0,
  downloads: 0
};

function playlistCom(arquivo) {
  return {
    screen: { id: TELA, name: 'Recepção', volume: 40 },
    slides: arquivo
      ? [{ id: 's1', type: 'video', duration: 10, url: '/uploads/' + arquivo }]
      : []
  };
}

let http1;
let urlServidor;
let portaAgente;
let agente;

async function portaLivre() {
  const s = net.createServer();
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', resolve);
  });
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}

async function esperar(condicao, descricao, limiteMs = 20000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('tempo esgotado esperando: ' + descricao);
}

async function status() {
  const resposta = await fetch(`http://127.0.0.1:${portaAgente}/status`);
  return resposta.json();
}

test.before(async () => {
  servidor.playlist = playlistCom(ARQUIVO);

  http1 = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');

    if (pathname.startsWith('/api/player/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(servidor.playlist));
    }

    if (pathname === '/api/heartbeat') {
      req.resume();
      servidor.heartbeats++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }

    if (pathname.startsWith('/player/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(servidor.paginaPlayer);
    }

    if (pathname === '/uploads/' + ARQUIVO) {
      res.setHeader('ETag', servidor.etag);
      res.setHeader('Content-Length', servidor.midia.length);
      res.setHeader('Accept-Ranges', 'bytes');
      if (req.method === 'HEAD') {
        res.writeHead(200);
        return res.end();
      }
      servidor.downloads++;
      res.writeHead(200);
      return res.end(servidor.midia);
    }

    res.writeHead(404);
    res.end();
  });

  http1.listen(0, '127.0.0.1');
  await new Promise(resolve => http1.once('listening', resolve));
  urlServidor = `http://127.0.0.1:${http1.address().port}`;
  portaAgente = await portaLivre();

  agente = spawn(process.execPath, [agenteJs], {
    env: {
      ...process.env,
      CORPTV_SERVIDOR: urlServidor,
      CORPTV_TELA: TELA,
      CORPTV_PORTA: String(portaAgente),
      CORPTV_CACHE: cache,
      CORPTV_LIMITE_MBPS: '0',   // sem limite: o teste não pode depender do relógio
      CORPTV_JITTER: '0',        // sem espera aleatória
      CORPTV_INTERVALO: '1',     // sincroniza a cada segundo
      CORPTV_INTERVALO_PLAYER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await esperar(async () => {
    try {
      return (await status()).conteudos_prontos === 1;
    } catch (e) {
      return false;
    }
  }, 'o agente baixar a mídia e publicar a programação');
});

test.after(async () => {
  if (agente && agente.exitCode === null) {
    agente.kill();
    await new Promise(resolve => agente.once('exit', resolve));
  }
  await new Promise(resolve => http1.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('guarda a mídia inteira no disco antes de publicá-la', async () => {
  const noDisco = fs.readFileSync(path.join(cache, ARQUIVO));
  assert.deepEqual(noDisco, MIDIA_V1);

  const situacao = await status();
  assert.equal(situacao.tela, TELA);
  assert.equal(situacao.arquivos.length, 1);
  assert.equal(situacao.arquivos[0].no_disco, true);
});

test('reescreve a programação para o endereço local, sem apontar para o servidor', async () => {
  const resposta = await fetch(`http://127.0.0.1:${portaAgente}/api/player/${TELA}`);
  const playlist = await resposta.json();

  assert.equal(playlist.slides.length, 1);
  assert.equal(playlist.slides[0].url, '/midia/' + ARQUIVO);
  assert.doesNotMatch(JSON.stringify(playlist), /\/uploads\//);
});

test('repassa ao player o volume que o painel definiu para a tela', async () => {
  const resposta = await fetch(`http://127.0.0.1:${portaAgente}/api/player/${TELA}`);
  const playlist = await resposta.json();
  assert.equal(playlist.screen.volume, 40);
});

test('serve a mídia do disco, com Range, sem tocar no servidor', async () => {
  const antes = servidor.downloads;

  const inteiro = await fetch(`http://127.0.0.1:${portaAgente}/midia/${ARQUIVO}`);
  assert.equal(inteiro.status, 200);
  assert.equal(inteiro.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await inteiro.arrayBuffer()), MIDIA_V1);

  const pedaco = await fetch(`http://127.0.0.1:${portaAgente}/midia/${ARQUIVO}`, {
    headers: { Range: 'bytes=0-99' }
  });
  assert.equal(pedaco.status, 206);
  assert.equal((await pedaco.arrayBuffer()).byteLength, 100);

  assert.equal(servidor.downloads, antes, 'exibir não pode gerar download novo');
});

test('não baixa de novo enquanto o arquivo não muda no servidor', async () => {
  const antes = servidor.downloads;
  assert.equal(antes, 1);

  // Várias sincronizações seguidas (CORPTV_INTERVALO=1) não podem render download.
  await new Promise(resolve => setTimeout(resolve, 3000));

  assert.equal(servidor.downloads, antes);
});

test('avisa o servidor que a tela está viva', () => {
  assert.ok(servidor.heartbeats > 0, 'nenhum heartbeat chegou ao servidor');
});

test('baixa de novo quando o ETag muda', async () => {
  servidor.midia = MIDIA_V2;
  servidor.etag = '"v2"';

  await esperar(
    () => servidor.downloads === 2,
    'o agente perceber o ETag novo e baixar outra vez'
  );

  await esperar(
    () => fs.readFileSync(path.join(cache, ARQUIVO)).length === MIDIA_V2.length,
    'a mídia nova chegar ao disco'
  );
  assert.deepEqual(fs.readFileSync(path.join(cache, ARQUIVO)), MIDIA_V2);
});

test('apaga do disco a mídia que saiu da programação', async () => {
  servidor.playlist = playlistCom(null);

  await esperar(
    () => !fs.existsSync(path.join(cache, ARQUIVO)),
    'o agente limpar a mídia que saiu da programação'
  );

  const situacao = await status();
  assert.equal(situacao.conteudos_prontos, 0);
});

test('recusa subir sem CORPTV_SERVIDOR, em vez de tentar um endereço chutado', async () => {
  const env = { ...process.env, CORPTV_CACHE: path.join(sandbox, 'cache-sem-servidor') };
  delete env.CORPTV_SERVIDOR;

  const semServidor = spawn(process.execPath, [agenteJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let erro = '';
  semServidor.stderr.on('data', pedaco => { erro += pedaco; });

  const codigo = await new Promise(resolve => semServidor.once('exit', resolve));
  assert.equal(codigo, 1);
  assert.match(erro, /CORPTV_SERVIDOR/);
});

test('baixa de novo a página do player quando ela muda no servidor', async () => {
  // Antes a página era lida uma vez só: correção publicada no servidor só
  // chegava à TV reiniciando o aparelho.
  const pagina = async () => (await fetch(`http://127.0.0.1:${portaAgente}/`)).text();
  assert.match(await pagina(), /player v1/);
  servidor.paginaPlayer = '<html><body>player v2</body></html>';
  await esperar(async () => /player v2/.test(await pagina()), 'o agente trazer a página nova do player');
});

test('não fica preso no aviso de erro quando o servidor volta', async () => {
  // Pi que liga antes do servidor, sem cópia local do player: o aviso de erro
  // ficava guardado na memória e a TV seguia nele depois de o servidor voltar.
  const portaServidor = await portaLivre();
  const portaOutroAgente = await portaLivre();
  const outro = spawn(process.execPath, [agenteJs], {
    env: {
      ...process.env,
      CORPTV_SERVIDOR: `http://127.0.0.1:${portaServidor}`,
      CORPTV_TELA: TELA,
      CORPTV_PORTA: String(portaOutroAgente),
      CORPTV_CACHE: path.join(sandbox, 'cache-servidor-fora'),
      CORPTV_JITTER: '0',
      CORPTV_INTERVALO: '1',
      CORPTV_INTERVALO_PLAYER: '1'
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const pagina = async () => {
    try { return await (await fetch(`http://127.0.0.1:${portaOutroAgente}/`)).text(); } catch (e) { return ''; }
  };
  try {
    await esperar(async () => /sem contato com o servidor/.test(await pagina()), 'o agente responder sem servidor');

    const voltou = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>player de volta</body></html>');
    });
    await new Promise(resolve => voltou.listen(portaServidor, '127.0.0.1', resolve));
    try {
      await esperar(async () => /player de volta/.test(await pagina()), 'a TV sair do aviso quando o servidor volta');
    } finally {
      voltou.closeAllConnections();
      await new Promise(resolve => voltou.close(resolve));
    }
  } finally {
    outro.kill();
    await new Promise(resolve => outro.once('exit', resolve));
  }
});
