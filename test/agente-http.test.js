'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');

test('falha na leitura de mídia local fecha a resposta e registra sem erro não tratado', async () => {
  const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
  const funcao = codigo.slice(codigo.indexOf('async function atender('), codigo.indexOf('const servidor = http.createServer('));
  const leitura = new PassThrough();
  const resposta = new PassThrough();
  const logs = [];
  resposta.writeHead = codigo => { resposta.statusCode = codigo; };
  const atender = vm.runInNewContext(`${funcao}\natender`, {
    URL, path, CONFIG: { pasta: 'cache' }, TIPOS: { '.mp4': 'video/mp4' },
    log: (...args) => logs.push(args),
    fs: {
      existsSync: () => true,
      statSync: () => ({ size: 8, isFile: () => true }),
      createReadStream: () => {
        setImmediate(() => leitura.destroy(new Error('falha de leitura simulada')));
        return leitura;
      }
    }
  });
  const fechou = new Promise(resolve => resposta.once('close', resolve));
  await atender({ url: '/midia/video.mp4', headers: {}, method: 'GET' }, resposta);
  await fechou;
  assert.equal(resposta.destroyed, true);
  assert.equal(leitura.destroyed, true);
  assert.ok(logs.some(l => l[1] === 'falha ao ler midia local'));
});
