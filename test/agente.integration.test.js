'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
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
  // Resposta do registro do aparelho; null = servidor antigo, sem a rota (404).
  registro: null,
  registros: 0,
  travarProgramacao: false,
  foraDoAr: false,
  presas: [],
  ultimoRegistro: null,
  telasPedidas: [],
  downloads: 0,
  falhaHead: null,
  atrasoDownloadMs: 0,
  consultasHead: 0
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

    if (pathname === '/api/aparelhos/registro' && servidor.registro) {
      let corpo = '';
      req.on('data', c => { corpo += c; });
      req.on('end', () => {
        servidor.ultimoRegistro = JSON.parse(corpo);
        servidor.registros++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(servidor.registro));
      });
      return;
    }

    if (pathname.startsWith('/api/player/')) {
      servidor.telasPedidas.push(decodeURIComponent(pathname.slice('/api/player/'.length)));
      if (servidor.foraDoAr) { res.writeHead(503); return res.end(); }
      // Programação "travada": simula um download longo segurando a sincronização.
      if (servidor.travarProgramacao) { servidor.presas.push(res); return; }
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
        servidor.consultasHead++;
        if (servidor.falhaHead === 'conexao') return req.socket.destroy();
        if (servidor.falhaHead === 'http') { res.writeHead(503); return res.end(); }
        res.writeHead(200);
        return res.end();
      }
      servidor.downloads++;
      res.writeHead(200);
      if (servidor.atrasoDownloadMs) {
        return setTimeout(() => {
          servidor.foraDoAr = true;
          res.end(servidor.midia);
        }, servidor.atrasoDownloadMs);
      }
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
      CORPTV_INTERVALO_REGISTRO: '1',
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
  limparTemporario(sandbox);
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

test('URL malformada e Range inválido não derrubam o agente', async () => {
  const ruim = await fetch(`http://127.0.0.1:${portaAgente}/%ZZ`);
  assert.equal(ruim.status, 400);
  await ruim.text();
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=x-y', 'bytes=0-1,4-5']) {
    const r = await fetch(`http://127.0.0.1:${portaAgente}/midia/${ARQUIVO}`, { headers: { Range: range } });
    assert.equal(r.status, 416, range);
    await r.text();
  }
  assert.equal((await status()).conteudos_prontos, 1);
  assert.equal(agente.exitCode, null);
});

test('não baixa de novo enquanto o arquivo não muda no servidor', async () => {
  const antes = servidor.downloads;
  assert.equal(antes, 1);

  // Várias sincronizações seguidas (CORPTV_INTERVALO=1) não podem render download.
  await new Promise(resolve => setTimeout(resolve, 3000));

  assert.equal(servidor.downloads, antes);
});

test('só avisa o servidor que a tela está viva quando o player está aberto', async () => {
  // Sem player chamando, o painel não pode mostrar a tela online: o navegador
  // pode estar fechado e a TV preta.
  assert.equal(servidor.heartbeats, 0, 'o agente avisou sozinho, sem o player');

  const res = await fetch(`http://127.0.0.1:${portaAgente}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_id: TELA })
  });
  assert.equal(res.status, 200);

  await esperar(() => servidor.heartbeats > 0, 'o aviso do player chegar ao servidor');
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

test('HEAD sem resposta ou com erro HTTP conserva a mídia registrada sem outro GET', async () => {
  const antes = servidor.downloads;
  const estadoAntes = fs.readFileSync(path.join(cache, 'estado.json'), 'utf8');
  try {
    for (const falha of ['conexao', 'http']) {
      servidor.falhaHead = falha;
      const consultas = servidor.consultasHead;
      await esperar(() => servidor.consultasHead >= consultas + 2, 'duas consultas HEAD com falha');
      assert.equal(servidor.downloads, antes);
      assert.deepEqual(fs.readFileSync(path.join(cache, ARQUIVO)), MIDIA_V2);
      assert.equal(fs.readFileSync(path.join(cache, 'estado.json'), 'utf8'), estadoAntes);
      assert.equal((await status()).conteudos_prontos, 1);
    }
  } finally {
    servidor.falhaHead = null;
  }
});

test('HEAD com falha ainda baixa mídia sem registro ou sem arquivo', async () => {
  const destino = path.join(cache, ARQUIVO);
  const estado = path.join(cache, 'estado.json');
  servidor.falhaHead = 'conexao';
  try {
    let antes = servidor.downloads;
    fs.writeFileSync(estado, '{}');
    await esperar(() => servidor.downloads > antes && JSON.parse(fs.readFileSync(estado, 'utf8'))[ARQUIVO], 'baixar o arquivo sem registro');
    assert.deepEqual(fs.readFileSync(destino), MIDIA_V2);
    antes = servidor.downloads;
    fs.unlinkSync(destino);
    await esperar(() => servidor.downloads > antes && fs.existsSync(destino), 'baixar o arquivo ausente');
    assert.deepEqual(fs.readFileSync(destino), MIDIA_V2);
  } finally {
    servidor.falhaHead = null;
  }
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
    // O aviso se recarrega sozinho: ninguém aperta F5 numa TV.
    assert.match(await pagina(), /http-equiv="refresh"/);

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

test('segue a tela escolhida no painel e avisa quando fica sem tela', async () => {
  // Servidor antigo (sem a rota de registro): seguia na tela da configuração local.
  assert.equal((await status()).tela, TELA);

  servidor.registro = { screen_id: 'refeitorio' };
  await esperar(async () => (await status()).tela === 'refeitorio', 'o agente adotar a tela escolhida no painel');
  await esperar(() => servidor.telasPedidas.includes('refeitorio'), 'o agente pedir a programação da tela nova');

  // O aparelho se apresenta com um id próprio e a tela que tinha na configuração.
  assert.match(servidor.ultimoRegistro.id, /^[0-9a-f-]{36}$/);
  assert.equal(servidor.ultimoRegistro.tela_local, TELA);
  // E informa o próprio IP, para o TI achar a Pi pelo painel.
  assert.ok('ip' in servidor.ultimoRegistro);
  if (servidor.ultimoRegistro.ip !== null) assert.match(servidor.ultimoRegistro.ip, /^(\d{1,3}\.){3}\d{1,3}$/);
  const salvo = JSON.parse(fs.readFileSync(path.join(cache, 'aparelho.json'), 'utf8'));
  assert.equal(salvo.tela, 'refeitorio', 'a escolha tem de sobreviver a um reinício sem rede');
  // A limpeza de mídia antiga não pode levar junto a cópia do player (TV sem rede).
  assert.ok(fs.existsSync(path.join(cache, 'player.html')), 'a limpeza apagou a cópia local do player');

  servidor.registro = { screen_id: null };
  await esperar(async () => (await status()).tela === null, 'o agente ficar sem tela');
  const pagina = await (await fetch(`http://127.0.0.1:${portaAgente}/`)).text();
  assert.match(pagina, /Falta escolher a tela/);
  const lista = await (await fetch(`http://127.0.0.1:${portaAgente}/api/player/x`)).json();
  assert.equal(lista.screen.reload_at, 'aguardando-tela', 'o player aberto precisa recarregar para mostrar o aviso');

  servidor.registro = { screen_id: TELA };
  await esperar(async () => (await status()).tela === TELA, 'o agente voltar para a tela original');
});

test('continua avisando o painel que está ligado mesmo com a sincronização presa', async () => {
  // Antes o aviso vinha de dentro da sincronização: durante um download longo a
  // Pi parava de avisar e o painel a mostrava como desligada.
  servidor.registro = { screen_id: TELA };
  servidor.travarProgramacao = true;
  try {
    await esperar(() => servidor.presas.length > 0, 'a sincronização ficar presa');
    const antes = servidor.registros;
    await esperar(() => servidor.registros >= antes + 2, 'o aviso seguir sozinho com a sincronização presa');
  } finally {
    servidor.travarProgramacao = false;
    for (const res of servidor.presas.splice(0)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(servidor.playlist));
    }
  }
});

test('sem rede, a Pi tira da tela o conteúdo que venceu', async () => {
  const lista = async () => (await (await fetch(`http://127.0.0.1:${portaAgente}/api/player/x`)).json()).slides;
  // Um texto curto, sem mídia: a validade vale igual e não depende de download.
  const original = servidor.playlist;
  servidor.playlist = { screen: { id: TELA }, slides: [{ id: 'aviso', type: 'txt', title: 'Aviso', duration: 5, cache_for_ms: 1500 }] };
  try {
    await esperar(async () => (await lista()).some(s => s.id === 'aviso' && s.cache_for_ms > 0 && s.cache_for_ms <= 1500), 'o agente receber a validade do servidor');
    servidor.foraDoAr = true;
    await esperar(async () => (await lista()).length === 0, 'o conteúdo vencido sair da tela com a rede fora', 10000);
  } finally {
    servidor.foraDoAr = false;
    servidor.playlist = original;
  }
  // Com a rede de volta, a Pi segue de novo o que o servidor mandar.
  await esperar(async () => (await lista()).length === original.slides.length, 'a programação voltar com a rede');
});

test('download pela metade abandonado não fica ocupando o disco', async () => {
  servidor.playlist = playlistCom(ARQUIVO);
  await esperar(() => fs.existsSync(path.join(cache, ARQUIVO)), 'a mídia da programação estar no disco');
  const abandonado = path.join(cache, 'abandonado-0000.mp4.parcial');
  fs.writeFileSync(abandonado, Buffer.alloc(1024));
  await esperar(() => !fs.existsSync(abandonado), 'a limpeza apagar o .parcial que não é da programação');
  assert.ok(fs.existsSync(path.join(cache, ARQUIVO)), 'a mídia da programação tem de continuar');
});

test('download demorado não renova o prazo recebido antes da queda da rede', async () => {
  const original = servidor.playlist;
  servidor.playlist = playlistCom(ARQUIVO);
  servidor.playlist.slides[0].cache_for_ms = 1000;
  servidor.atrasoDownloadMs = 1600;
  fs.unlinkSync(path.join(cache, ARQUIVO));
  fs.writeFileSync(path.join(cache, 'estado.json'), '{}');
  try {
    await esperar(() => {
      if (!fs.existsSync(path.join(cache, ARQUIVO))) return false;
      const p = JSON.parse(fs.readFileSync(path.join(cache, 'playlist.json'), 'utf8'));
      return p.slides.some(s => s.cache_for_ms === 1000);
    }, 'baixar a mídia cuja validade acabou durante o download', 60000);
    const p = await (await fetch(`http://127.0.0.1:${portaAgente}/api/player/x`)).json();
    assert.deepEqual(p.slides, []);
  } finally {
    servidor.atrasoDownloadMs = 0;
    servidor.foraDoAr = false;
    servidor.playlist = original;
  }
});
