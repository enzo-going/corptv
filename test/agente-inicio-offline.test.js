'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

for (const mesmaTela of [true, false]) {
  test(mesmaTela ? 'inicia com player e programação salvos sem esperar a rede' : 'não restaura a programação salva de outra tela ao iniciar sem rede', async t => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-inicio-'));
    t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cache, 'player.html'), '<html><body>player salvo</body></html>');
    fs.writeFileSync(path.join(cache, 'playlist.json'), JSON.stringify({
      screen: { id: mesmaTela ? 'sala' : 'outra' },
      salvo_em: Date.now(),
      slides: [{ id: 'aviso', type: 'text', text: 'Aviso salvo', cache_for_ms: 60000 }]
    }));
    // Aceita as conexões, mas deixa todos os pedidos sem resposta.
    const remoto = http.createServer(() => {});
    await new Promise(resolve => remoto.listen(0, '127.0.0.1', resolve));
    t.after(() => { remoto.closeAllConnections(); remoto.close(); });
    const reserva = net.createServer();
    await new Promise(resolve => reserva.listen(0, '127.0.0.1', resolve));
    const porta = reserva.address().port;
    await new Promise(resolve => reserva.close(resolve));
    const agente = spawn(process.execPath, [path.join(__dirname, '../agente/agente.js')], {
      env: { ...process.env, CORPTV_CACHE: cache, CORPTV_TELA: 'sala', CORPTV_PORTA: String(porta),
        CORPTV_SERVIDOR: `http://127.0.0.1:${remoto.address().port}`, CORPTV_JITTER: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
      if (agente.exitCode === null) {
        agente.kill();
        await new Promise(resolve => agente.once('exit', resolve));
      }
    });
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error('agente não iniciou')), 5000);
      let logs = '';
      agente.stdout.on('data', chunk => {
        logs += chunk;
        if (logs.includes('agente iniciado')) { clearTimeout(limite); resolve(); }
      });
      agente.once('error', reject);
    });
    const base = `http://127.0.0.1:${porta}`;
    const lista = await fetch(base + '/api/player/sala', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
    assert.equal(lista.slides.length, mesmaTela ? 1 : 0);
    if (mesmaTela) assert.equal(lista.slides[0].id, 'aviso');
    const html = await fetch(base + '/player/sala', { signal: AbortSignal.timeout(2000) }).then(r => r.text());
    assert.equal(html, '<html><body>player salvo</body></html>');
    assert.equal(agente.exitCode, null);
  });
}
