'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-api-'));
process.env.CORPTV_DATA_DIR = path.join(sandbox, 'data');
process.env.CORPTV_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.CORPTV_LOG_DIR = path.join(sandbox, 'logs');
process.env.CORPTV_DISABLE_SEED = '1';
process.env.CORPTV_DISABLE_MAINTENANCE = '1';
// Este arquivo usa assinaturas sintéticas; conversões reais ficam em video.integration.test.js.
process.env.CORPTV_FFMPEG = 'desligado';
process.env.CORPTV_MEDIA_REQUESTS_PER_MINUTE = '2';
process.env.CORPTV_PAGE_REQUESTS_PER_MINUTE = '2';
process.env.CORPTV_ENDERECO_PUBLICO = 'http://corportv/';

const db = require('../src/db');
const { app, enderecoPublico } = require('../src/server');

let server;
let baseUrl;
let authCookie = '';
let csrfToken = '';

function addPanelFields(form, title) {
  form.set('title', title);
  form.set('body', '');
  form.set('type', 'img');
  form.set('duration', '8');
  form.set('bg', '#111111');
  form.set('starts_at', '');
  form.set('expires_at', '');
  form.set('days', '');
  form.set('time_start', '');
  form.set('time_end', '');
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authCookie) headers.cookie = authCookie;
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(options.method || 'GET')) headers['x-csrf-token'] = csrfToken;
  return fetch(baseUrl + pathname, { ...options, headers });
}

async function json(pathname, options) {
  const response = await request(pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options && options.headers) },
    body: options && options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  await db.ready;
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(baseUrl + '/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Administrador dos testes', username: 'test-admin', password: 'Senha segura de testes 2026!' })
  });
  assert.equal(setup.status, 201);
  authCookie = setup.headers.get('set-cookie').split(';')[0];
  csrfToken = (await setup.json()).csrf_token;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.stopMaintenance();
  limparTemporario(sandbox);
});

test('limita leituras de mídia e páginas por endereço', async () => {
  const fileName = '123e4567-e89b-12d3-a456-426614174000.png';
  const filePath = path.join(sandbox, 'uploads', fileName);
  fs.writeFileSync(filePath, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const media = await fetch(baseUrl + '/uploads/' + fileName);
      assert.equal(media.status, 200);
      await media.arrayBuffer();
      const panel = await fetch(baseUrl + '/painel');
      assert.equal(panel.status, 200);
      await panel.arrayBuffer();
    }

    const blockedMedia = await fetch(baseUrl + '/uploads/' + fileName);
    const blockedPanel = await fetch(baseUrl + '/painel');
    assert.equal(blockedMedia.status, 429);
    assert.equal(blockedPanel.status, 429);
    assert.ok(blockedMedia.headers.get('ratelimit'));
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('API valida relações, entradas e impede cache de programação', async () => {
  const invalid = await json('/api/groups', { method: 'POST', body: { name: '', color: '#123456' } });
  assert.equal(invalid.response.status, 400);

  const createdGroup = await json('/api/groups', {
    method: 'POST', body: { name: ' Recepção ', color: '#AABBCC' }
  });
  assert.equal(createdGroup.response.status, 200);
  assert.equal(createdGroup.body.name, 'Recepção');

  const missingGroup = await json('/api/screens', {
    method: 'POST', body: { name: 'TV sem grupo', group_id: 'inexistente' }
  });
  assert.equal(missingGroup.response.status, 404);

  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'Recepção Principal', group_id: createdGroup.body.id }
  });
  assert.equal(screen.response.status, 200);

  const player = await request('/api/player/' + screen.body.id);
  assert.equal(player.status, 200);
  assert.match(player.headers.get('cache-control'), /no-store/);
});

test('o volume da tela chega ao player e sobrevive à edição do nome', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Refeitório', color: '#123456' } });
  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'TV do Refeitório', group_id: group.body.id }
  });
  assert.equal(screen.body.volume, 100);

  const player = async () => (await request('/api/player/' + screen.body.id)).json();
  assert.equal((await player()).screen.volume, 100);

  const ajuste = await json('/api/screens/' + screen.body.id, {
    method: 'PUT', body: { name: 'TV do Refeitório', group_id: group.body.id, volume: 35 }
  });
  assert.equal(ajuste.response.status, 200);
  assert.equal((await player()).screen.volume, 35);

  // Renomear sem mandar o volume não pode devolver a TV ao máximo.
  await json('/api/screens/' + screen.body.id, {
    method: 'PUT', body: { name: 'TV Refeitório', group_id: group.body.id }
  });
  assert.equal((await player()).screen.volume, 35);

  const invalido = await json('/api/screens/' + screen.body.id, {
    method: 'PUT', body: { name: 'TV Refeitório', group_id: group.body.id, volume: 150 }
  });
  assert.equal(invalido.response.status, 400);
  assert.equal((await player()).screen.volume, 35);
});

test('tela cadastrada antes do controle de volume segue tocando no máximo', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Sala antiga', color: '#654321' } });
  await db.screens.insert({
    id: 'tela-sem-volume', name: 'Tela sem volume', group_id: group.body.id, last_seen: null, created_at: new Date()
  });
  const player = await (await request('/api/player/tela-sem-volume')).json();
  assert.equal(player.screen.volume, 100);
});

test('recarregar tela deixa uma marca nova para o player e fica na auditoria', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Sala de recarga', color: '#224466' } });
  const screen = await json('/api/screens', { method: 'POST', body: { name: 'TV Recarga', group_id: group.body.id } });
  const marca = async () => (await (await request('/api/player/' + screen.body.id)).json()).screen.reload_at;

  assert.equal(await marca(), undefined);

  const pedido = await json('/api/screens/' + screen.body.id + '/recarregar', { method: 'POST', body: {} });
  assert.equal(pedido.response.status, 200);
  assert.equal(await marca(), pedido.body.reload_at);

  // Editar a tela depois não pode apagar a marca, senão o player recarregaria de novo.
  await json('/api/screens/' + screen.body.id, {
    method: 'PUT', body: { name: 'TV Recarga', group_id: group.body.id, volume: 50 }
  });
  assert.equal(await marca(), pedido.body.reload_at);

  const inexistente = await json('/api/screens/inexistente/recarregar', { method: 'POST', body: {} });
  assert.equal(inexistente.response.status, 404);

  const registro = await db.audit.findOne({ action: 'screen.reload', entity_id: screen.body.id });
  assert.ok(registro, 'o pedido de recarga não entrou na auditoria');
});

test('o servidor entrega o script de preparo da Pi com o próprio endereço', async () => {
  const script = await request('/pi/preparar.sh');
  assert.equal(script.status, 200);
  const texto = await script.text();
  // CORPTV_ENDERECO_PUBLICO do teste: o script sai apontando para ele.
  assert.ok(texto.includes('SERVIDOR="${CORPTV_SERVIDOR:-http://corportv}"'));
  assert.doesNotMatch(texto, /__SERVIDOR__/);
  assert.ok(!texto.includes(String.fromCharCode(13)), 'CRLF quebra o bash da Pi');
  assert.equal(script.headers.get('cache-control'), 'no-store');

  const agente = await request('/pi/agente/agente.js');
  assert.equal(agente.status, 200);
  assert.match(await agente.text(), /CORPTV_SERVIDOR/);
  assert.equal((await request('/pi/agente/corptv-agente.service')).status, 200);
  // O quiosque: sem ele o agente fica no ar, mas nada abre a tela na Pi.
  const quiosque = await request('/pi/agente/iniciar-quiosque.sh');
  assert.equal(quiosque.status, 200);
  assert.doesNotMatch(await quiosque.text(), /\r/, 'script de shell tem de chegar à Pi sem CRLF');
  assert.equal((await request('/pi/agente/corptv-quiosque.desktop')).status, 200);

  // Só os arquivos da lista; nada de caminho para fora da pasta do agente.
  assert.equal((await request('/pi/agente/preparar-pi.sh')).status, 404);
  assert.equal((await request('/pi/agente/..%2Fsrc%2Fserver.js')).status, 404);
});

test('aparelho se registra sozinho e a tela se escolhe no painel', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Refeitório', color: '#335577' } });
  const tela = await json('/api/screens', { method: 'POST', body: { name: 'TV Refeitório Aparelho', group_id: group.body.id } });
  const outra = await json('/api/screens', { method: 'POST', body: { name: 'TV Pátio Aparelho', group_id: group.body.id } });
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  // O registro é feito pela Pi, sem login.
  const registrar = async corpo => {
    const r = await fetch(baseUrl + '/api/aparelhos/registro', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo)
    });
    return { status: r.status, body: await r.json() };
  };
  const auditoriaAntes = await db.audit.count({});

  assert.equal((await registrar({ id: 'nao-e-uuid', nome: 'x' })).status, 400);

  // Pi instalada antes desta versão: entra já com a tela da configuração local.
  const primeiro = await registrar({ id, nome: 'raspberry-recepcao', ip: '192.0.2.20', tela_local: tela.body.id });
  assert.equal(primeiro.status, 200);
  assert.equal(primeiro.body.screen_id, tela.body.id);

  const lista = await json('/api/aparelhos');
  const aparelho = lista.body.find(a => a.id === id);
  assert.equal(aparelho.name, 'raspberry-recepcao');
  // O IP que a Pi informa aparece no painel; lixo no lugar do IP é descartado.
  assert.equal(aparelho.ip, '192.0.2.20');
  await registrar({ id, nome: 'raspberry-recepcao', ip: '<script>' });
  assert.equal((await json('/api/aparelhos')).body.find(a => a.id === id).ip, null);
  await registrar({ id, nome: 'raspberry-recepcao', ip: '192.0.2.20' });
  assert.equal(aparelho.screen_id, tela.body.id);

  // Trocar pelo painel: a Pi recebe a tela nova no próximo registro.
  const troca = await json('/api/aparelhos/' + id, { method: 'PUT', body: { screen_id: outra.body.id } });
  assert.equal(troca.response.status, 200);
  assert.equal((await registrar({ id, nome: 'raspberry-recepcao', tela_local: tela.body.id })).body.screen_id, outra.body.id);

  const invalida = await json('/api/aparelhos/' + id, { method: 'PUT', body: { screen_id: 'nao-existe' } });
  assert.equal(invalida.response.status, 400);

  // Caso real: excluíram a tela que a Raspberry mostrava e a TV ficou sem programação.
  // Tela em uso por um aparelho não sai; a mensagem diz o que fazer.
  const recusada = await json('/api/screens/' + outra.body.id, { method: 'DELETE', body: {} });
  assert.equal(recusada.response.status, 409);
  assert.match(recusada.body.error, /está passando na TV raspberry-recepcao/);
  assert.equal((await registrar({ id, nome: 'raspberry-recepcao' })).body.screen_id, outra.body.id);

  // A Pi conta como está; só campos conhecidos passam, e o apelido é de quem publica.
  await registrar({ id, nome: 'raspberry-recepcao', situacao: { estado: 'baixando', percentual: 35, livre_mb: 20000, extra: 'x' } });
  await json('/api/aparelhos/' + id, { method: 'PUT', body: { apelido: 'TV da Recepção<script>' } });
  const comSituacao = (await json('/api/aparelhos')).body.find(a => a.id === id);
  assert.deepEqual(comSituacao.situacao, { estado: 'baixando', percentual: 35, total_mb: null, livre_mb: 20000, erro: null });
  assert.equal(comSituacao.apelido, 'TV da Recepçãoscript');
  await registrar({ id, nome: 'raspberry-recepcao', situacao: { estado: 'invadido' } });
  assert.equal((await json('/api/aparelhos')).body.find(a => a.id === id).situacao, null);

  // Movida a TV para outra tela, a antiga pode sair.
  await json('/api/aparelhos/' + id, { method: 'PUT', body: { screen_id: null } });
  assert.equal((await json('/api/screens/' + outra.body.id, { method: 'DELETE', body: {} })).response.status, 200);
  assert.equal((await registrar({ id, nome: 'raspberry-recepcao' })).body.screen_id, null);

  // O aviso automático das TVs não é ação de pessoa: não entra na auditoria.
  await fetch(baseUrl + '/api/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen_id: tela.body.id })
  });
  const registrosAutomaticos = await db.audit.count({ action: 'management.post' });
  assert.equal(registrosAutomaticos, 0, 'heartbeat ou registro do aparelho foi parar na auditoria');
  assert.ok(await db.audit.findOne({ action: 'device.update', entity_id: id }), 'a troca de tela pelo painel precisa ficar na auditoria');
  assert.ok((await db.audit.count({})) > auditoriaAntes);

  // Gestão exige login.
  const semLogin = await fetch(baseUrl + '/api/aparelhos');
  assert.equal(semLogin.status, 401);

  assert.equal((await json('/api/aparelhos/' + id, { method: 'DELETE', body: {} })).response.status, 200);
  assert.equal((await json('/api/aparelhos/' + id, { method: 'DELETE', body: {} })).response.status, 404);
});

test('o player recebe a validade de cada conteúdo, calculada pela regra de agenda testada', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Validade', color: '#224466' } });
  const screen = await json('/api/screens', { method: 'POST', body: { name: 'TV Validade', group_id: group.body.id } });
  const form = new FormData();
  addPanelFields(form, 'Aviso com prazo');
  form.set('type', 'txt');
  const slide = await (await request('/api/slides', { method: 'POST', body: form })).json();
  const umaHora = 60 * 60 * 1000;
  // Como o painel manda: data e hora locais, sem fuso ("2026-09-30T15:40").
  const fim = new Date(Date.now() + umaHora + 60000);
  const d2 = n => String(n).padStart(2, '0');
  const local = `${fim.getFullYear()}-${d2(fim.getMonth() + 1)}-${d2(fim.getDate())}T${d2(fim.getHours())}:${d2(fim.getMinutes())}`;
  const vinculo = await json('/api/groups/' + group.body.id + '/slides', {
    method: 'POST', body: { slide_id: slide.id, expires_at: local }
  });
  assert.equal(vinculo.response.status, 200);

  // Sem isso, uma cópia offline exibia o conteúdo para sempre, mesmo vencido.
  const player = await (await request('/api/player/' + screen.body.id)).json();
  const item = player.slides.find(s => s.id === slide.id);
  assert.ok(item.cache_for_ms > umaHora - 60000 && item.cache_for_ms <= umaHora + 120000, 'validade: ' + item.cache_for_ms);

  // O servidor usa a regra de scheduling.js (a da madrugada certa), não uma cópia.
  const fonte = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.ok(fonte.includes('return scheduling.slideStatus(a, now || new Date());'));
  assert.ok(!fonte.includes('now.getDay()'), 'voltou a haver regra de dia própria no servidor');
});

test('API rejeita corpos JSON ausentes sem responder erro interno', async () => {
  const group = await json('/api/groups', { method: 'POST' });
  assert.equal(group.response.status, 400);
  assert.match(group.body.error, /obrigatório/i);

  const heartbeat = await json('/api/heartbeat', { method: 'POST' });
  assert.equal(heartbeat.response.status, 400);
  assert.match(heartbeat.body.error, /obrigatória/i);

  const playlist = await json('/api/groups/inexistente/slides', { method: 'POST' });
  assert.equal(playlist.response.status, 404);
  assert.match(playlist.body.error, /ambiente não encontrado/i);

  const unknownHeartbeat = await json('/api/heartbeat', {
    method: 'POST', body: { screen_id: 'inexistente' }
  });
  assert.equal(unknownHeartbeat.response.status, 404);

  const unknownGroup = await json('/api/groups/inexistente', {
    method: 'PUT', body: { name: 'Não existe', color: '#123456' }
  });
  assert.equal(unknownGroup.response.status, 404);

  const unknownScreen = await json('/api/screens/inexistente', {
    method: 'DELETE', body: {}
  });
  assert.equal(unknownScreen.response.status, 404);

  const headers = await request('/api/groups');
  assert.equal(headers.headers.get('x-powered-by'), null);
  assert.equal(headers.headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.headers.get('cache-control'), /no-store/);
});

test('upload falso é rejeitado e removido', async () => {
  const form = new FormData();
  addPanelFields(form, 'Arquivo falso');
  form.set('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'falso.png');
  const response = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(response.status, 415);
  assert.deepEqual(fs.readdirSync(process.env.CORPTV_UPLOADS_DIR), []);
});

test('exclusão de slide também remove sua mídia', async () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const form = new FormData();
  addPanelFields(form, 'Aviso');
  form.set('file', new Blob([png], { type: 'image/png' }), 'aviso.png');
  const created = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(created.status, 200);
  const slide = await created.json();
  const mediaPath = path.join(process.env.CORPTV_UPLOADS_DIR, path.basename(slide.url));
  assert.equal(fs.existsSync(mediaPath), true);

  const removed = await json('/api/slides/' + slide.id, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal(fs.existsSync(mediaPath), false);
});

test('modo do texto do vídeo é salvo, atualizado e entregue ao player', async () => {
  const group = await json('/api/groups', {
    method: 'POST', body: { name: 'Vídeo com texto', color: '#F59E0B' }
  });
  assert.equal(group.response.status, 200);

  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'TV vídeo com texto', group_id: group.body.id }
  });
  assert.equal(screen.response.status, 200);

  const mp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00
  ]);
  const form = new FormData();
  addPanelFields(form, 'Bom dia, equipe!');
  form.set('type', 'vid');
  form.set('duration', '0');
  form.set('video_text_mode', 'timed');
  form.set('video_text_seconds', '4');
  form.set('file', new Blob([mp4], { type: 'video/mp4' }), 'abertura.mp4');

  const createdResponse = await request('/api/slides', { method: 'POST', body: form });
  assert.equal(createdResponse.status, 200);
  const slide = await createdResponse.json();
  assert.equal(slide.video_text_mode, 'timed');
  assert.equal(slide.video_text_seconds, 4);

  const linked = await json('/api/groups/' + group.body.id + '/slides', {
    method: 'POST', body: { slide_id: slide.id }
  });
  assert.equal(linked.response.status, 200);

  const playerResponse = await request('/api/player/' + screen.body.id);
  assert.equal(playerResponse.status, 200);
  const player = await playerResponse.json();
  assert.equal(player.slides[0].video_text_mode, 'timed');
  assert.equal(player.slides[0].video_text_seconds, 4);

  const updated = await json('/api/slides/' + slide.id, {
    method: 'PUT', body: { video_text_mode: 'none', video_text_seconds: 0 }
  });
  assert.equal(updated.response.status, 200);

  const slidesResponse = await request('/api/slides');
  const slides = await slidesResponse.json();
  const saved = slides.find(item => item.id === slide.id);
  assert.equal(saved.video_text_mode, 'none');
  assert.equal(saved.video_text_seconds, 0);

  const invalid = await json('/api/slides/' + slide.id, {
    method: 'PUT', body: { video_text_mode: 'timed', video_text_seconds: 0 }
  });
  assert.equal(invalid.response.status, 400);
});

test('imagem e texto aceitam "sem tempo" (0) no cadastro e na edição', async () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const imagem = new FormData();
  addPanelFields(imagem, 'Cartaz fixo');
  imagem.set('duration', '0');
  imagem.set('file', new Blob([png], { type: 'image/png' }), 'cartaz.png');
  const criada = await (await request('/api/slides', { method: 'POST', body: imagem })).json();
  assert.equal(criada.type, 'img');
  assert.equal(criada.duration, 0);

  const texto = new FormData();
  addPanelFields(texto, 'Aviso fixo');
  texto.set('type', 'txt');
  texto.set('duration', '0');
  const aviso = await (await request('/api/slides', { method: 'POST', body: texto })).json();
  assert.equal(aviso.type, 'txt');
  assert.equal(aviso.duration, 0);

  const duracaoDe = async id => (await (await request('/api/slides')).json()).find(s => s.id === id).duration;
  assert.equal((await json('/api/slides/' + criada.id, { method: 'PUT', body: { duration: 12 } })).response.status, 200);
  assert.equal(await duracaoDe(criada.id), 12);
  assert.equal((await json('/api/slides/' + criada.id, { method: 'PUT', body: { duration: 0 } })).response.status, 200);
  assert.equal(await duracaoDe(criada.id), 0);

  for (const invalida of [2, 301, 'abc', 7.5]) {
    const r = await json('/api/slides/' + criada.id, { method: 'PUT', body: { duration: invalida } });
    assert.equal(r.response.status, 400, `duração ${invalida} deveria ser recusada`);
  }
  assert.equal(await duracaoDe(criada.id), 0);
});

test('a edição de conteúdo passa pela mesma validação do cadastro', async () => {
  const form = new FormData();
  addPanelFields(form, 'Para editar');
  form.set('type', 'txt');
  const slide = await (await request('/api/slides', { method: 'POST', body: form })).json();

  // Antes a rota de edição gravava tudo do jeito que chegava.
  const cor = await json('/api/slides/' + slide.id, { method: 'PUT', body: { bg: 'red;display:none' } });
  assert.equal(cor.response.status, 400);
  const titulo = await json('/api/slides/' + slide.id, { method: 'PUT', body: { title: 'x'.repeat(121) } });
  assert.equal(titulo.response.status, 400);
  const vazio = await json('/api/slides/' + slide.id, { method: 'PUT', body: {} });
  assert.equal(vazio.response.status, 400);

  // O tipo vem do arquivo enviado; a edição não troca.
  await json('/api/slides/' + slide.id, { method: 'PUT', body: { type: 'vid', title: 'Renomeado' } });
  const salvo = (await (await request('/api/slides')).json()).find(s => s.id === slide.id);
  assert.equal(salvo.type, 'txt');
  assert.equal(salvo.title, 'Renomeado');
  assert.equal(salvo.bg, '#111111');
});

test('o painel recebe o endereço oficial para montar os links do player', async () => {
  const cfg = await json('/api/config');
  assert.equal(cfg.response.status, 200);
  assert.equal(cfg.body.endereco_publico, 'http://corportv');   // barra final removida
});

test('o endereço oficial aceita só esquema, host e porta', () => {
  assert.equal(enderecoPublico('http://corportv'), 'http://corportv');
  assert.equal(enderecoPublico(' https://corportv.exemplo.local:8443/ '), 'https://corportv.exemplo.local:8443');
  for (const invalido of ['', undefined, 'corportv', 'http://corportv/painel', 'javascript:alert(1)', 'http://a b', 'ftp://corportv']) {
    assert.equal(enderecoPublico(invalido), null, `"${invalido}" deveria ser recusado`);
  }
});

test('renomear a tela muda só o nome: o endereço do player continua o mesmo', async () => {
  const group = await json('/api/groups', { method: 'POST', body: { name: 'Sala para renomear', color: '#445566' } });
  const screen = await json('/api/screens', {
    method: 'POST', body: { name: 'Coworking', group_id: group.body.id, volume: 55 }
  });
  const id = screen.body.id;
  assert.equal(id, 'coworking');

  const r = await json('/api/screens/' + id, { method: 'PUT', body: { name: 'Coworking 2º andar', group_id: group.body.id } });
  assert.equal(r.response.status, 200);

  // As TVs e as Raspberries já instaladas usam o endereço antigo: ele tem de seguir valendo.
  const player = await request('/api/player/' + id);
  assert.equal(player.status, 200);
  const dados = await player.json();
  assert.equal(dados.screen.id, 'coworking');
  assert.equal(dados.screen.name, 'Coworking 2º andar');
  assert.equal(dados.screen.volume, 55);

  const vazio = await json('/api/screens/' + id, { method: 'PUT', body: { name: '   ', group_id: group.body.id } });
  assert.equal(vazio.response.status, 400);
});
