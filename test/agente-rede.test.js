'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
const preparo = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');

function carregarBusca(pasta, lookup) {
  const trecho = codigo.slice(codigo.indexOf('const arqEnderecoServidor'), codigo.indexOf('function pedir('));
  const logs = [];
  const contexto = vm.createContext({ fs, path, CONFIG: { pasta }, dns: { lookup }, log: (...a) => logs.push(a) });
  vm.runInContext(trecho + '\nthis.procurar = procurarServidor;', contexto);
  return { procurar: (host, opcoes) => new Promise((resolve, reject) =>
    contexto.procurar(host, opcoes, (err, endereco, familia) => err ? reject(err) : resolve({ endereco, familia }))), logs };
}

test('com o DNS falhando, a Pi usa o último endereço em que o servidor respondeu', async t => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corptv-dns-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  // Endereço de documentação: nenhum servidor real.
  let falhar = false;
  const lookup = (host, opcoes, cb) => falhar
    ? cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
    : cb(null, opcoes && opcoes.all ? [{ address: '192.0.2.29', family: 4 }] : '192.0.2.29', 4);

  const primeiro = carregarBusca(pasta, lookup);
  assert.equal((await primeiro.procurar('tv.exemplo.test', {})).endereco, '192.0.2.29');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'servidor-endereco.json'), 'utf8')).address, '192.0.2.29');

  // Depois de reiniciar, sem DNS: usa o endereço guardado no cartão.
  falhar = true;
  const depois = carregarBusca(pasta, lookup);
  assert.equal((await depois.procurar('tv.exemplo.test', {})).endereco, '192.0.2.29');
  // O Node atual pede todos os endereços de uma vez (all: true).
  assert.equal(JSON.stringify((await depois.procurar('tv.exemplo.test', { all: true })).endereco), JSON.stringify([{ address: '192.0.2.29', family: 4 }]));
  assert.equal(depois.logs.filter(l => /DNS falhou/.test(l[1])).length, 1, 'avisa uma vez, não a cada pedido');
  // Outro nome não herda o endereço guardado.
  await assert.rejects(depois.procurar('outro.exemplo.test', {}));
});

test('o agente pede ao servidor pela busca que lembra o endereço e usa mais threads', () => {
  assert.match(codigo, /lib\.request\(u, Object\.assign\(\{ timeout: 20000, lookup: procurarServidor \}/);
  const servico = fs.readFileSync(path.join(__dirname, '../agente/corptv-agente.service'), 'utf8');
  assert.match(servico, /^Environment=UV_THREADPOOL_SIZE=16$/m);
});

test('a TV mostra que está se preparando em vez de tela preta, e o painel recebe o estado', () => {
  assert.match(codigo, /'Preparando esta TV: recebendo o conteúdo \(' \+ percentualBaixado\(\) \+ '%\)/);
  assert.match(codigo, /const aviso = programa\.slides\.length \? null : avisoDaTela\(\);/);
  assert.match(codigo, /situacao: situacaoAtual\(\)/);
  const player = fs.readFileSync(path.join(__dirname, '../public/player/index.html'), 'utf8');
  assert.match(player, /setEmptyNotice\(data\.aviso\);/);
  assert.match(player, /<span id="empty-text">/);
});

test('o navegador da Pi só abre o CorporTV local', () => {
  assert.ok(preparo.includes('"URLBlocklist": ["*"]'));
  assert.ok(preparo.includes('"URLAllowlist": ["127.0.0.1:8080", "localhost:8080"]'));
});

test('Wi-Fi sem senha guardada não é tentado sozinho e há um comando para a rede do local', () => {
  assert.ok(preparo.includes('connection.autoconnect no'));
  assert.ok(preparo.includes('! grep -qx "$uuid" <<<"$ativas"'), 'a rede em uso nunca é mexida');
  assert.ok(preparo.includes('cat > /usr/local/bin/corptv-wifi <<WIFI'));
  assert.ok(preparo.includes('wifi-sec.psk-flags 0'), 'a senha fica guardada no sistema');
  assert.ok(preparo.includes('connection.autoconnect-priority 10'));
  assert.ok(preparo.includes('read -r -s -p'), 'a senha é digitada sem aparecer na tela');
});
