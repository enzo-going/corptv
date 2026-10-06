'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const video = require('../src/video');

test('falha no banco depois de converter conserva o original e limpa a saída sem vínculo', async t => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-fila-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const original = path.join(pasta, 'original.mp4');
  fs.writeFileSync(original, 'video original');
  let slide = { id: 'teste', url: '/uploads/original.mp4', otimizacao: { estado: 'otimizando', duracao_s: 5 } };
  const logs = [];
  // Mantém a função de fila real; simula conversão bem-sucedida e falha de persistência.
  const contexto = vm.createContext({
    fs, path, setTimeout, setImmediate,
    converter: async (_tools, _entrada, saida) => fs.writeFileSync(saida, 'video convertido'),
    sondar: async () => ({ duracaoS: 5 })
  });
  const criarFila = vm.runInContext(`(${video.criarFila.toString()})`, contexto);
  const fila = criarFila({
    ferramentas: {}, uploadsDir: pasta, threads: 2, preset: 'veryfast', limiteMs: 1000,
    novoNome: () => 'convertido.mp4', caminhoDaUrl: () => original,
    removerArquivo: async arquivo => {
      try { await fs.promises.unlink(arquivo); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    log: (...args) => logs.push(args),
    db: { slides: {
      findOne: async () => slide,
      update: async (_query, update) => {
        if (update.$set.url) throw new Error('falha de gravação simulada');
        slide.otimizacao.estado = update.$set['otimizacao.estado'];
        return 1;
      }
    } }
  });
  fila.enfileirar(slide.id);
  const limite = Date.now() + 3000;
  while (fila.ocupada() && Date.now() < limite) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fila.ocupada(), false);
  assert.equal(slide.otimizacao.estado, 'falhou');
  assert.equal(slide.url, '/uploads/original.mp4');
  assert.equal(fs.readFileSync(original, 'utf8'), 'video original');
  assert.deepEqual(fs.readdirSync(pasta), ['original.mp4']);
  assert.ok(logs.some(l => l[1] === 'não consegui otimizar o vídeo'));
});
