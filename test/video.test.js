'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const limparTemporario = require('./limpar-temporario');
const os = require('node:os');
const path = require('node:path');
const video = require('../src/video');

const base = { codec: 'h264', largura: 1280, altura: 720, pixFmt: 'yuv420p', hdr: null, audio: 'aac', duracaoS: 60, mbps: 2.8 };

test('vídeo já no padrão das TVs passa como veio', () => {
  assert.deepEqual(video.plano(base, true), { modo: null, motivos: [] });
  // Full HD leve também: não vale perder qualidade nem gastar processador.
  assert.equal(video.plano({ ...base, largura: 1920, altura: 1080, mbps: 3.9 }, true).modo, null);
  // Celular em pé (1080x1920) é 1080p deitado.
  assert.equal(video.plano({ ...base, largura: 1080, altura: 1920, mbps: 3.5 }, true).modo, null);
  // Vídeo mudo é aceito.
  assert.equal(video.plano({ ...base, audio: null }, true).modo, null);
});

test('o teto de 4 Mb/s cabe na entrega do servidor para cada TV', () => {
  // O servidor manda no máximo 4,5 Mb/s por TV (CORPTV_LIMITE_MBPS): um vídeo acima
  // disso trava na TV que toca direto do servidor.
  assert.ok(video.ACEITA_COMO_VEIO.mbps < 4.5);
  assert.ok(video.PADRAO.maxK / 1000 < 4.5);
  assert.equal(video.plano({ ...base, largura: 1920, altura: 1080, mbps: 4.6 }, true).modo, 'converter');
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
  // HDR de celular: mesmo em H.264 leve, precisa da cor convertida.
  assert.deepEqual(video.plano({ ...base, hdr: 'arib-std-b67' }, true).motivos, ['HDR']);
});

test('a conversão mantém Full HD com qualidade constante e não aumenta vídeo menor', () => {
  const args = video.argumentos('entrada.mp4', 'saida.tmp', 'converter', { threads: 2, preset: 'veryfast' });
  const texto = args.join(' ');
  // min(): um 720p continua 720p; um 4K vira 1080p; em pé não distorce.
  assert.match(texto, /scale=w='min\(1920,iw\)':h='min\(1080,ih\)':force_original_aspect_ratio=decrease:force_divisible_by=2/);
  assert.match(texto, /-fpsmax 30/);
  assert.match(texto, /-c:v libx264 -preset veryfast -profile:v high -level 4\.1 -pix_fmt yuv420p/);
  assert.match(texto, /-crf 21 -maxrate 4000k -bufsize 8000k/);
  assert.match(texto, /-movflags \+faststart/);
  assert.match(texto, /-threads 2/);
  assert.doesNotMatch(texto, /zscale|tonemap/, 'vídeo normal não passa pelo ajuste de HDR');
  // Saída temporária sem extensão de vídeo: o formato vai explícito.
  assert.deepEqual(args.slice(-3), ['-f', 'mp4', 'saida.tmp']);
  const copia = video.argumentos('entrada.mp4', 'saida.tmp', 'reorganizar', { threads: 2 }).join(' ');
  assert.match(copia, /-c copy/);
  assert.doesNotMatch(copia, /libx264/);
});

test('vídeo HDR tem a cor trazida para o padrão das TVs (quando o ffmpeg tem o zscale)', () => {
  const comAjuste = video.argumentos('e.mp4', 's.tmp', 'converter', { hdr: 'smpte2084', ajustaHdr: true }).join(' ');
  assert.match(comAjuste, /zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:t=linear:npl=100,.*tonemap=tonemap=hable/);
  // A marcação de cor vai no quadro: a opção -color_trc da linha de comando não vale no ffmpeg atual.
  assert.match(comAjuste, /setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=/);
  // Sem o zscale no ffmpeg: converte do mesmo jeito, só sem o ajuste de cor.
  const semAjuste = video.argumentos('e.mp4', 's.tmp', 'converter', { hdr: 'smpte2084', ajustaHdr: false }).join(' ');
  assert.doesNotMatch(semAjuste, /zscale|tonemap|setparams/);
  // Só os dois tipos de HDR conhecidos entram no filtro.
  assert.doesNotMatch(video.argumentos('e.mp4', 's.tmp', 'converter', { hdr: 'x:y', ajustaHdr: true }).join(' '), /zscale/);
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
    limparTemporario(pasta);
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

test('o painel confere o tamanho antes de enviar e mostra uma barra de progresso', () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  assert.match(painel, /if\(f\.size>limiteUploadMb\*1048576\)/);
  assert.match(painel, /xhr\.upload\.onprogress=/);
  // Barra de verdade, acessível, com porcentagem, MB e tempo restante.
  assert.match(painel, /<div class="envio-barra" id="sl-envio-barra" role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100"/);
  assert.match(painel, /mostrarEnvio\('enviando','Enviando '\+pct\+'%',mb\(enviado\)\+' de '\+mb\(total\)\+' MB'/);
  assert.match(painel, /function tempoRestante\(s\)/);
  // Dá para cancelar e o navegador avisa antes de fechar a aba no meio do envio.
  assert.match(painel, /onclick="cancelarEnvio\(\)"/);
  assert.match(painel, /xhr\.onabort=\(\)=>fim\(\{cancelado:true\}\)/);
  assert.match(painel, /window\.addEventListener\('beforeunload',e=>\{if\(envioAtual\)/);
  // Página de erro em HTML (nginx) não pode travar o painel.
  assert.match(painel, /try\{data=await r\.json\(\);\}catch\(e\)\{data=\{error:mensagemHttp\(r\.status\)\};\}/);
  assert.match(painel, /if\(status===413\)return 'Arquivo grande demais/);
  // O preparo no servidor também tem barra, na biblioteca.
  assert.match(painel, /function preparoDe\(s\)/);
  assert.match(painel, /class="preparo-barra" role="progressbar"/);
});
