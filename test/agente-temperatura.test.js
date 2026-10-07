'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
const trecho = codigo.slice(codigo.indexOf('let ultimaLeituraTermica'), codigo.indexOf('// Texto que a TV mostra'));

function carregar() {
  const leitura = { agora: 0, temperatura: '62500\n', flags: 'throttled=0x0\n', arquivos: 0, comandos: 0 };
  const contexto = vm.createContext({
    Date: { now: () => leitura.agora }, telaAtual: 'tela-teste',
    andamento: { tela: 'tela-teste', total: 1048576 },
    espacoLivreMb: () => 512, percentualBaixado: () => 50,
    fs: { readFileSync: (arquivo, encoding) => {
      leitura.arquivos++;
      assert.equal(arquivo, '/sys/class/thermal/thermal_zone0/temp');
      assert.equal(encoding, 'utf8');
      if (leitura.erroArquivo) throw Object.assign(new Error('arquivo indisponível'), { code: 'ENOENT' });
      return leitura.temperatura;
    } },
    execFileSync: (comando, args, opcoes) => {
      leitura.comandos++;
      assert.equal(comando, 'vcgencmd');
      assert.equal(JSON.stringify(args), '["get_throttled"]');
      assert.equal(opcoes.timeout, 1000);
      assert.equal(opcoes.maxBuffer, 1024);
      assert.equal(opcoes.windowsHide, true);
      assert.equal(opcoes.shell, undefined);
      if (leitura.erroComando) throw Object.assign(new Error('comando indisponível'), { code: leitura.erroComando });
      return leitura.flags;
    }
  });
  vm.runInContext(trecho, contexto);
  return { leitura, contexto, situacao: () => ({ ...contexto.situacaoAtual() }) };
}

test('situação inclui temperatura inteira e preserva os estados do aparelho', () => {
  const { contexto, situacao } = carregar();
  assert.deepEqual(situacao(), { estado: 'pronto', livre_mb: 512, total_mb: 1, temperatura_c: 63, limitada: false });
  contexto.andamento.emCurso = true;
  assert.equal(situacao().estado, 'baixando');
  assert.equal(situacao().percentual, 50);
  contexto.telaAtual = '';
  assert.deepEqual(situacao(), { estado: 'sem_tela', temperatura_c: 63, limitada: false });
});

test('limitação considera cada indicador atual e passado, ignorando bits desconhecidos', () => {
  for (const bit of [0, 1, 2, 3, 16, 17, 18, 19, 20]) {
    const { leitura, situacao } = carregar();
    leitura.flags = 'throttled=0x' + (2 ** bit).toString(16);
    assert.equal(situacao().limitada, bit !== 20, 'bit ' + bit);
  }
});

test('leituras ficam em cache por 60 segundos e os retornos não alteram o cache', () => {
  const { leitura, situacao } = carregar();
  const primeiro = situacao();
  primeiro.temperatura_c = 0;
  leitura.temperatura = '81000';
  leitura.flags = 'throttled=0x50005';
  leitura.agora = 59999;
  assert.equal(situacao().temperatura_c, 63);
  assert.equal(situacao().limitada, false);
  assert.equal(leitura.arquivos, 1);
  assert.equal(leitura.comandos, 1);
  leitura.agora = 60000;
  assert.equal(situacao().temperatura_c, 81);
  assert.equal(situacao().limitada, true);
  assert.equal(leitura.arquivos, 2);
  assert.equal(leitura.comandos, 2);
});

test('arquivo inexistente, comando ausente ou timeout omitem ambos os campos sem interromper o agente', () => {
  for (const falha of ['arquivo', 'ENOENT', 'ETIMEDOUT']) {
    const { leitura, situacao } = carregar();
    if (falha === 'arquivo') leitura.erroArquivo = true;
    else leitura.erroComando = falha;
    for (let i = 0; i < 3; i++) {
      const s = situacao();
      assert.equal(s.estado, 'pronto');
      assert.ok(!Object.hasOwn(s, 'temperatura_c'));
      assert.ok(!Object.hasOwn(s, 'limitada'));
    }
    assert.equal(leitura.arquivos, 1, 'falha também fica em cache');
    assert.equal(leitura.comandos, falha === 'arquivo' ? 0 : 1);
    leitura.erroArquivo = false;
    leitura.erroComando = null;
    leitura.agora = 60000;
    assert.equal(situacao().temperatura_c, 63);
  }
});

test('falha após medição válida remove os valores antigos', () => {
  const { leitura, situacao } = carregar();
  assert.equal(situacao().temperatura_c, 63);
  leitura.agora = 60000;
  leitura.erroComando = 'EACCES';
  const s = situacao();
  assert.ok(!Object.hasOwn(s, 'temperatura_c'));
  assert.ok(!Object.hasOwn(s, 'limitada'));
});

test('agente descarta leituras malformadas e aceita os extremos de temperatura', () => {
  for (const temperatura of ['', ' ', 'NaN', 'Infinity', '-1000', '120001', '62000 graus', '62.5']) {
    const { leitura, situacao } = carregar();
    leitura.temperatura = temperatura;
    assert.ok(!Object.hasOwn(situacao(), 'temperatura_c'), temperatura);
    assert.ok(!Object.hasOwn(situacao(), 'limitada'), temperatura);
  }
  for (const flags of ['', 'throttled=0x', 'throttled=xyz', 'throttled=0x100000000', 'erro\nthrottled=0x0']) {
    const { leitura, situacao } = carregar();
    leitura.flags = flags;
    assert.ok(!Object.hasOwn(situacao(), 'temperatura_c'), flags);
    assert.ok(!Object.hasOwn(situacao(), 'limitada'), flags);
  }
  for (const temperatura of ['0', '120000']) {
    const { leitura, situacao } = carregar();
    leitura.temperatura = temperatura;
    assert.equal(situacao().temperatura_c, Number(temperatura) / 1000);
  }
});
