'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

test('seis falhas preservam o parcial e o próximo ciclo retoma por Range', async (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-retomada-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const destino = path.join(pasta, 'video.mp4');
  const midia = Buffer.from('conteudo completo do video');
  const pedaco = midia.subarray(0, 8);
  let pedidos = 0;
  let redeVoltou = false;
  const ranges = [];
  const servidor = http.createServer((req, res) => {
    pedidos++;
    ranges.push(req.headers.range);
    if (redeVoltou) {
      res.writeHead(206);
      return res.end(midia.subarray(pedaco.length));
    }
    // Primeiro GET deixa dados no disco; os demais não conseguem conectar.
    if (pedidos === 1) return res.end(pedaco);
    req.socket.destroy();
  });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => servidor.close(resolve)));
  const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
  // Executa as funções reais, isolando apenas o relógio das esperas e o log.
  const trecho = codigo.slice(codigo.indexOf('function pedir('), codigo.indexOf('// ── SINCRONIZAÇÃO'));
  const esperas = [], logs = [];
  const contexto = vm.createContext({
    http, https: require('node:https'), fs, path, URL, LIMITE_BYTES_S: 0,
    setTimeout: (fn, ms) => { esperas.push(ms); return setImmediate(fn); },
    log: (...args) => logs.push(args)
  });
  vm.runInContext(trecho + '\nthis.baixar = baixarComTentativas;', contexto);
  const url = `http://127.0.0.1:${servidor.address().port}/video`;
  await assert.rejects(contexto.baixar(url, destino, midia.length));
  assert.equal(pedidos, 6);
  assert.deepEqual(esperas, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(fs.existsSync(destino), false);
  assert.deepEqual(fs.readFileSync(destino + '.parcial'), pedaco);
  assert.ok(logs.some(l => /retomo no proximo ciclo/.test(l[1])));
  redeVoltou = true;
  await contexto.baixar(url, destino, midia.length);
  assert.equal(ranges.at(-1), `bytes=${pedaco.length}-`);
  assert.deepEqual(fs.readFileSync(destino), midia);
  assert.equal(fs.existsSync(destino + '.parcial'), false);
});
