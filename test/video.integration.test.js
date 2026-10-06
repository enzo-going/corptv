'use strict';

// Ponta a ponta com o ffmpeg de verdade: envia um vídeo pesado pelo painel, confere
// que ele não vai para a TV enquanto é otimizado e que o arquivo final está no padrão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const video = require('../src/video');

const ferramentas = video.localizarFerramentas(process.env, path.join(__dirname, '..'));
const pular = ferramentas ? false : 'ffmpeg não encontrado neste sistema';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-video-'));
process.env.CORPTV_DATA_DIR = path.join(sandbox, 'data');
process.env.CORPTV_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.CORPTV_LOG_DIR = path.join(sandbox, 'logs');
process.env.CORPTV_DISABLE_SEED = '1';
process.env.CORPTV_DISABLE_MAINTENANCE = '1';
const uploads = process.env.CORPTV_UPLOADS_DIR;

let server, baseUrl, cookie = '', csrf = '';

function gerar(nome, args) {
  const arquivo = path.join(sandbox, nome);
  const r = spawnSync(ferramentas.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, arquivo], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return arquivo;
}

async function pedir(caminho, opcoes = {}) {
  const headers = { ...(opcoes.headers || {}), cookie };
  if ((opcoes.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  return fetch(baseUrl + caminho, { ...opcoes, headers });
}
async function json(caminho, method, corpo) {
  const r = await pedir(caminho, { method, headers: { 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  return r.json();
}
async function enviar(arquivo, titulo) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ title: titulo, body: '', type: 'vid', duration: '0', bg: '#111111', video_text_mode: 'none', video_text_seconds: '0' })) form.set(k, v);
  form.set('file', new Blob([fs.readFileSync(arquivo)], { type: 'video/mp4' }), path.basename(arquivo));
  const r = await pedir('/api/slides', { method: 'POST', body: form });
  assert.equal(r.status, 200);
  return r.json();
}
async function esperarEstado(id, estado) {
  for (let i = 0; i < 300; i++) {
    const s = (await (await pedir('/api/slides')).json()).find(x => x.id === id);
    if (s && s.otimizacao && s.otimizacao.estado === estado) return s;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('o vídeo não chegou a ' + estado);
}

test.before(async () => {
  if (pular) return;
  const db = require('../src/db');
  const { app } = require('../src/server');
  await db.ready;
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(baseUrl + '/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', username: 'admin-video', password: 'Senha segura de testes 2026!' })
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  csrf = (await setup.json()).csrf_token;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (!pular) require('../src/db').stopMaintenance();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('vídeo pesado é aceito, fica fora da TV enquanto otimiza e entra no padrão', { skip: pular }, async () => {
  const config = await json('/api/config', 'GET');
  assert.equal(config.limite_upload_mb, 2048);
  assert.equal(config.otimiza_videos, true);

  // Outro formato e acima de 1080p: tem de ser convertido.
  const bruto = gerar('bruto.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', '-shortest']);
  const grupo = await json('/api/groups', 'POST', { name: 'Recepção', color: '#123456' });
  const tela = await json('/api/screens', 'POST', { name: 'TV Recepção', group_id: grupo.id });

  const slide = await enviar(bruto, 'Institucional');
  assert.equal(slide.otimizacao.estado, 'otimizando');
  assert.equal(slide.otimizacao.modo, 'converter');
  await json('/api/groups/' + grupo.id + '/slides', 'POST', { slide_id: slide.id });

  const pronto = await esperarEstado(slide.id, 'pronto');
  assert.notEqual(pronto.url, slide.url, 'o arquivo otimizado ganha nome novo (as Pis baixam de novo)');
  assert.equal(fs.existsSync(path.join(uploads, path.basename(slide.url))), false, 'o original pesado foi apagado');
  const final = path.join(uploads, path.basename(pronto.url));
  const info = await video.sondar(ferramentas, final);
  assert.equal(info.codec, 'h264');
  assert.equal(info.largura, 1280);
  assert.equal(info.altura, 720);
  assert.ok(Math.abs(info.duracaoS - 3) < 0.5, 'duração ' + info.duracaoS);
  assert.equal(await video.inicioRapido(final), true);

  const player = await json('/api/player/' + tela.id, 'GET');
  assert.deepEqual(player.slides.map(s => s.url), [pronto.url]);
  assert.deepEqual(fs.readdirSync(uploads).filter(f => !f.endsWith('.mp4')), [], 'sobrou arquivo temporário');
});

test('enquanto otimiza, o vídeo não vai para o player', { skip: pular }, async () => {
  const bruto = gerar('longo.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '8', '-c:v', 'mpeg4', '-q:v', '2']);
  const grupo = await json('/api/groups', 'POST', { name: 'Refeitório', color: '#123456' });
  const tela = await json('/api/screens', 'POST', { name: 'TV Refeitório', group_id: grupo.id });
  const slide = await enviar(bruto, 'Cardápio');
  await json('/api/groups/' + grupo.id + '/slides', 'POST', { slide_id: slide.id });
  const durante = await json('/api/player/' + tela.id, 'GET');
  assert.deepEqual(durante.slides, [], 'o vídeo bruto chegou à TV antes de ficar pronto');
  const prog = await json('/api/programacao', 'GET');
  const item = prog.find(t => t.screen_id === tela.id).ocultos[0];
  assert.equal(item.status.reason, 'otimizando');
  await esperarEstado(slide.id, 'pronto');
  assert.equal((await json('/api/player/' + tela.id, 'GET')).slides.length, 1);
});

test('só falta o início rápido: reorganiza sem recomprimir; vídeo já leve passa como veio', { skip: pular }, async () => {
  // O muxer do ffmpeg põe o índice no fim por padrão: é o "sem início rápido".
  const semInicio = gerar('sem-inicio.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
  assert.equal(await video.inicioRapido(semInicio), false);
  const s1 = await enviar(semInicio, 'Reorganizar');
  assert.equal(s1.otimizacao.modo, 'reorganizar');
  const pronto = await esperarEstado(s1.id, 'pronto');
  const final = path.join(uploads, path.basename(pronto.url));
  assert.equal(await video.inicioRapido(final), true);
  assert.equal((await video.sondar(ferramentas, final)).largura, 640, 'reorganizar não muda a resolução');

  const leve = gerar('leve.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
  const s2 = await enviar(leve, 'Leve');
  assert.equal(s2.otimizacao, undefined, 'vídeo já no padrão não passa pela fila');
});

test('excluir durante a otimização não deixa arquivo para trás', { skip: pular }, async () => {
  const bruto = gerar('excluir.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '8', '-c:v', 'mpeg4', '-q:v', '2']);
  const antes = new Set(fs.readdirSync(uploads));
  const slide = await enviar(bruto, 'Excluir');
  const r = await pedir('/api/slides/' + slide.id, { method: 'DELETE' });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50; i++) {
    const novos = fs.readdirSync(uploads).filter(f => !antes.has(f));
    if (!novos.length) break;
    await new Promise(res => setTimeout(res, 200));
  }
  assert.deepEqual(fs.readdirSync(uploads).filter(f => !antes.has(f)), []);
});
