'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const video = require('../src/video');

const base = { codec: 'h264', largura: 1280, altura: 720, pixFmt: 'yuv420p', audio: 'aac', duracaoS: 60, mbps: 2.8 };

test('vídeo já no padrão das TVs passa como veio', () => {
  assert.deepEqual(video.plano(base, true), { modo: null, motivos: [] });
  // 1080p leve também: não vale perder qualidade nem gastar processador.
  assert.equal(video.plano({ ...base, largura: 1920, altura: 1080, mbps: 4.5 }, true).modo, null);
  // Celular em pé (1080x1920) é 1080p deitado.
  assert.equal(video.plano({ ...base, largura: 1080, altura: 1920, mbps: 4 }, true).modo, null);
  // Vídeo mudo é aceito.
  assert.equal(video.plano({ ...base, audio: null }, true).modo, null);
});

test('só falta o início rápido: reorganiza sem recomprimir', () => {
  assert.deepEqual(video.plano(base, false), { modo: 'reorganizar', motivos: ['sem início rápido'] });
});

test('vídeo pesado, grande ou em outro formato é convertido', () => {
  // O caso real: 641 MB em 4 min ≈ 21 Mb/s.
  assert.equal(video.plano({ ...base, largura: 1920, altura: 1080, mbps: 21.3 }, true).modo, 'converter');
  assert.equal(video.plano({ ...base, largura: 3840, altura: 2160, mbps: 4 }, true).modo, 'converter');
  assert.equal(video.plano({ ...base, codec: 'hevc' }, true).modo, 'converter');
  assert.equal(video.plano({ ...base, pixFmt: 'yuv422p10le' }, true).modo, 'converter');
  assert.equal(video.plano({ ...base, audio: 'pcm_s16le' }, true).modo, 'converter');
  assert.match(video.plano({ ...base, mbps: 21.3 }, false).motivos.join(), /21\.3 Mb\/s/);
});

test('a conversão segue o padrão das TVs e não distorce vídeo em pé', () => {
  const args = video.argumentos('entrada.mp4', 'saida.tmp', 'converter', 2);
  const texto = args.join(' ');
  assert.match(texto, /scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2/);
  assert.match(texto, /-c:v libx264 .*-profile:v baseline -level 3\.1/);
  assert.match(texto, /-b:v 2800k -maxrate 3000k/);
  assert.match(texto, /-movflags \+faststart/);
  assert.match(texto, /-threads 2/);
  // Saída temporária sem extensão de vídeo: o formato vai explícito.
  assert.deepEqual(args.slice(-3), ['-f', 'mp4', 'saida.tmp']);
  const copia = video.argumentos('entrada.mp4', 'saida.tmp', 'reorganizar', 2).join(' ');
  assert.match(copia, /-c copy/);
  assert.doesNotMatch(copia, /libx264/);
});

test('o andamento da conversão sai do -progress do ffmpeg', () => {
  assert.equal(video.lerProgresso('frame=1\nout_time_us=30000000\nprogress=continue\n', 60), 50);
  assert.equal(video.lerProgresso('out_time_ms=10000000\nout_time_ms=59000000\n', 60), 98);
  // Nunca 100% antes de terminar de verdade.
  assert.equal(video.lerProgresso('out_time_us=61000000\n', 60), 99);
  assert.equal(video.lerProgresso('progress=continue\n', 60), null);
  assert.equal(video.lerProgresso('out_time_us=1\n', 0), null);
});

test('o início rápido é lido da ordem das caixas do MP4', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-mp4-'));
  const caixa = (tipo, tamanho) => { const b = Buffer.alloc(tamanho); b.writeUInt32BE(tamanho, 0); b.write(tipo, 4, 'latin1'); return b; };
  const grava = (nome, partes) => { const f = path.join(pasta, nome); fs.writeFileSync(f, Buffer.concat(partes)); return f; };
  try {
    assert.equal(await video.inicioRapido(grava('a.mp4', [caixa('ftyp', 24), caixa('moov', 40), caixa('mdat', 100)])), true);
    assert.equal(await video.inicioRapido(grava('b.mp4', [caixa('ftyp', 24), caixa('mdat', 100), caixa('moov', 40)])), false);
    // Caixa com tamanho de 64 bits (mdat grande) antes do moov.
    const grande = Buffer.alloc(16 + 32);
    grande.writeUInt32BE(1, 0); grande.write('free', 4, 'latin1'); grande.writeBigUInt64BE(48n, 8);
    assert.equal(await video.inicioRapido(grava('c.mp4', [caixa('ftyp', 24), grande, caixa('moov', 40)])), true);
    assert.equal(await video.inicioRapido(grava('d.mp4', [Buffer.from('lixo')])), false);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('sem ffmpeg (ou desligado) a otimização fica de fora', () => {
  assert.equal(video.localizarFerramentas({ CORPTV_FFMPEG: 'desligado' }, os.tmpdir()), null);
  assert.equal(video.localizarFerramentas({ CORPTV_FFMPEG: '0' }, os.tmpdir()), null);
});

test('o servidor só aceita vídeo grande se puder otimizá-lo, e nunca manda o bruto para a TV', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(fonte, /const LIMITE_UPLOAD_MB = videoTools \? positiveInteger\(Number\(process\.env\.CORPTV_LIMITE_UPLOAD_MB\), 2048\) : 200;/);
  assert.match(fonte, /fileSize: LIMITE_UPLOAD_MB \* 1024 \* 1024/);
  const player = fonte.slice(fonte.indexOf("app.get('/api/player/:slug'"), fonte.indexOf('// Registra no log quando uma tela aparece'));
  assert.match(player, /if \(emPreparo\(slide\)\) return null;/);
  // Upload lento pela porta 3000 não pode morrer nos 5 min padrão do Node.
  assert.match(fonte, /server\.requestTimeout = 60 \* 60 \* 1000;/);
});

test('o painel confere o tamanho antes de enviar e mostra o andamento', () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  assert.match(painel, /if\(f\.size>limiteUploadMb\*1048576\)/);
  assert.match(painel, /xhr\.upload\.onprogress=/);
  assert.match(painel, /'Enviando '\+Math\.floor\(enviado\/total\*100\)\+'%/);
  // Página de erro em HTML (nginx) não pode travar o painel.
  assert.match(painel, /try\{data=await r\.json\(\);\}catch\(e\)\{data=\{error:mensagemHttp\(r\.status\)\};\}/);
  assert.match(painel, /if\(status===413\)return 'Arquivo grande demais/);
  assert.match(painel, /function preparoDe\(s\)/);
});
