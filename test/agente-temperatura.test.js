'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '../agente/agente.js'), 'utf8');
const trecho = codigo.slice(codigo.indexOf('let ultimaLeituraTermica'), codigo.indexOf('// Texto que a TV mostra'));

// Arquivos do sistema simulados: temperatura (thermal_zone0) e o sensor de tensão
// da Pi (hwmon "rpi_volt"). Nada de comando externo.
function carregar(inicial = {}) {
  const leitura = Object.assign({ agora: 0, temperatura: '62500\n', alarme: '0\n', hwmon: true, leituras: 0 }, inicial);
  const arquivos = caminho => {
    if (caminho === '/sys/class/thermal/thermal_zone0/temp') return leitura.temperatura;
    if (leitura.hwmon && caminho === '/sys/class/hwmon/hwmon0/name') return 'cpu_thermal\n';
    if (leitura.hwmon && caminho === '/sys/class/hwmon/hwmon1/name') return 'rpi_volt\n';
    if (leitura.hwmon && caminho === '/sys/class/hwmon/hwmon1/in0_lcrit_alarm') return leitura.alarme;
    return null;
  };
  const contexto = vm.createContext({
    Date: { now: () => leitura.agora }, telaAtual: 'tela-teste',
    andamento: { tela: 'tela-teste', total: 1048576 },
    espacoLivreMb: () => 512, percentualBaixado: () => 50, String,
    fs: {
      readFileSync: caminho => {
        leitura.leituras++;
        const v = arquivos(caminho);
        if (v === null || v === undefined) throw Object.assign(new Error('arquivo indisponível'), { code: 'ENOENT' });
        return v;
      },
      readdirSync: pasta => {
        assert.equal(pasta, '/sys/class/hwmon');
        if (!leitura.hwmon) throw Object.assign(new Error('sem hwmon'), { code: 'ENOENT' });
        return ['hwmon0', 'hwmon1'];
      }
    }
  });
  vm.runInContext(trecho, contexto);
  return { leitura, contexto, situacao: () => ({ ...contexto.situacaoAtual() }) };
}

test('situação traz temperatura, limitação por calor e fonte fraca, sem mudar os estados', () => {
  const { contexto, situacao } = carregar();
  assert.deepEqual(situacao(), { estado: 'pronto', livre_mb: 512, total_mb: 1, temperatura_c: 63, limitada: false, subtensao: false });
  contexto.andamento.emCurso = true;
  assert.equal(situacao().estado, 'baixando');
  contexto.telaAtual = '';
  assert.deepEqual(situacao(), { estado: 'sem_tela', temperatura_c: 63, limitada: false, subtensao: false });
});

test('a partir de 80 °C conta como limitada; fonte fraca vem do sensor de tensão', () => {
  assert.equal(carregar({ temperatura: '79999' }).situacao().limitada, false);
  assert.equal(carregar({ temperatura: '80000' }).situacao().limitada, true);
  assert.equal(carregar({ alarme: '1' }).situacao().subtensao, true);
});

test('cada leitura vale sozinha: sem sensor de tensão a temperatura continua', () => {
  const s = carregar({ hwmon: false }).situacao();
  assert.equal(s.temperatura_c, 63);
  assert.ok(!Object.hasOwn(s, 'subtensao'));
  const semTemp = carregar({ temperatura: null }).situacao();
  assert.ok(!Object.hasOwn(semTemp, 'temperatura_c'));
  assert.ok(!Object.hasOwn(semTemp, 'limitada'));
  assert.equal(semTemp.subtensao, false);
});

test('leituras ficam em cache por 60 s e quem recebe não altera o cache', () => {
  const { leitura, situacao } = carregar();
  const primeiro = situacao();
  primeiro.temperatura_c = 0;
  const lidas = leitura.leituras;
  leitura.temperatura = '81000';
  leitura.agora = 59999;
  assert.equal(situacao().temperatura_c, 63);
  assert.equal(leitura.leituras, lidas, 'não relê dentro de 60 s');
  leitura.agora = 60000;
  assert.equal(situacao().temperatura_c, 81);
  assert.equal(situacao().limitada, true);
});

test('leitura malformada é descartada; extremos são aceitos', () => {
  for (const temperatura of ['', ' ', 'NaN', '-1000', '120001', '62000 graus', '62.5']) {
    assert.ok(!Object.hasOwn(carregar({ temperatura }).situacao(), 'temperatura_c'), temperatura);
  }
  for (const alarme of ['', '2', 'sim']) {
    assert.ok(!Object.hasOwn(carregar({ alarme }).situacao(), 'subtensao'), alarme);
  }
  assert.equal(carregar({ temperatura: '0' }).situacao().temperatura_c, 0);
  assert.equal(carregar({ temperatura: '120000' }).situacao().temperatura_c, 120);
});

test('o agente não roda comando externo para medir', () => {
  assert.ok(!codigo.includes("'vcgencmd'"), 'nenhuma chamada ao vcgencmd');
  assert.ok(!codigo.includes('execFileSync'));
});
