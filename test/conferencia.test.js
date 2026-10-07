'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const limparTemporario = require('./limpar-temporario');
const { criarConferencia } = require('../src/conferencia');

const sha = conteudo => crypto.createHash('sha256').update(conteudo).digest('hex');

function preparar(t) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-conferencia-'));
  t.after(() => limparTemporario(pasta));
  const uploadsDir = path.join(pasta, 'uploads');
  fs.mkdirSync(uploadsDir);
  return { uploadsDir, arquivoCache: path.join(pasta, 'conferencia.json') };
}

async function aguardar(conferencia) {
  for (let i = 0; i < 200 && !conferencia.ocioso(); i++) await new Promise(r => setTimeout(r, 10));
}

test('calcula o hash no primeiro pedido e entrega nos seguintes', async t => {
  const { uploadsDir, arquivoCache } = preparar(t);
  const video = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // mais de um bloco de leitura
  fs.writeFileSync(path.join(uploadsDir, 'a.mp4'), video);
  const conferencia = criarConferencia({ uploadsDir, arquivoCache });

  assert.equal(await conferencia.hashDe('a.mp4'), null, 'o primeiro pedido não espera o cálculo');
  await aguardar(conferencia);
  assert.equal(await conferencia.hashDe('a.mp4'), sha(video));
});

test('arquivo trocado no servidor tem o hash calculado de novo', async t => {
  const { uploadsDir, arquivoCache } = preparar(t);
  const arquivo = path.join(uploadsDir, 'a.mp4');
  fs.writeFileSync(arquivo, 'versao 1');
  const conferencia = criarConferencia({ uploadsDir, arquivoCache });
  await conferencia.hashDe('a.mp4');
  await aguardar(conferencia);

  fs.writeFileSync(arquivo, 'versao 2, maior');
  assert.equal(await conferencia.hashDe('a.mp4'), null, 'hash antigo não pode ir para a TV');
  await aguardar(conferencia);
  assert.equal(await conferencia.hashDe('a.mp4'), sha('versao 2, maior'));
});

test('reiniciar o servidor não recalcula o que já estava guardado', async t => {
  const { uploadsDir, arquivoCache } = preparar(t);
  fs.writeFileSync(path.join(uploadsDir, 'a.mp4'), 'video');
  const primeira = criarConferencia({ uploadsDir, arquivoCache });
  await primeira.hashDe('a.mp4');
  await aguardar(primeira);

  const depoisDoReinicio = criarConferencia({ uploadsDir, arquivoCache });
  assert.equal(await depoisDoReinicio.hashDe('a.mp4'), sha('video'));
  assert.equal(depoisDoReinicio.ocioso(), true);
});

test('mídia excluída sai da lista guardada e mídia inexistente não tem hash', async t => {
  const { uploadsDir, arquivoCache } = preparar(t);
  fs.writeFileSync(path.join(uploadsDir, 'a.mp4'), 'a');
  fs.writeFileSync(path.join(uploadsDir, 'b.mp4'), 'b');
  const conferencia = criarConferencia({ uploadsDir, arquivoCache });
  await conferencia.hashDe('a.mp4');
  await aguardar(conferencia);

  fs.unlinkSync(path.join(uploadsDir, 'a.mp4'));
  await conferencia.hashDe('b.mp4');
  await aguardar(conferencia);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(arquivoCache, 'utf8'))), ['b.mp4']);
  assert.equal(await conferencia.hashDe('a.mp4'), null);
  assert.equal(await conferencia.hashDe('nao-existe.mp4'), null);
  assert.equal(conferencia.ocioso(), true, 'arquivo que não existe não entra na fila');
});

test('lista guardada ilegível não impede o servidor de subir', async t => {
  const { uploadsDir, arquivoCache } = preparar(t);
  fs.writeFileSync(arquivoCache, '{ quebrado');
  fs.writeFileSync(path.join(uploadsDir, 'a.mp4'), 'video');
  const conferencia = criarConferencia({ uploadsDir, arquivoCache });
  await conferencia.hashDe('a.mp4');
  await aguardar(conferencia);
  assert.equal(await conferencia.hashDe('a.mp4'), sha('video'));
});
