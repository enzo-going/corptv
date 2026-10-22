'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const trecho = (inicio, fim) => {
  const de = html.indexOf(inicio);
  assert.notEqual(de, -1, 'trecho não encontrado: ' + inicio);
  return html.slice(de, html.indexOf(fim, de));
};

test('o formulário de conteúdo abre pronto para enviar vídeo ou foto', () => {
  // Caso real (20/10): o formulário abria em "Texto", com a área de envio escondida, e um
  // "INSTITUCIONAL" virou texto vazio em vez do vídeo que já estava na biblioteca.
  assert.match(html, /id="sl-modo-arquivo" value="arquivo" checked/);
  assert.match(html, /id="sl-modo-texto" value="txt"/);
  assert.match(html, /<div class="form-full" id="sl-file-wrap">/, 'a área de envio aparece de saída');
  assert.match(html, /id="sl-body-wrap" style="display:none"/);
  assert.match(html, /id="sl-bg-wrap" style="display:none"/);
  assert.doesNotMatch(html, /id="sl-type"/, 'não há mais o seletor de tipo antes do arquivo');
});

test('o tipo do conteúdo sai do próprio arquivo', () => {
  const contexto = vm.createContext({});
  vm.runInContext(trecho('function tipoDoArquivo(f){', 'function slTipo('), contexto);
  assert.equal(contexto.tipoDoArquivo({ name: 'Institucional 2026.MP4' }), 'vid');
  for (const nome of ['cardapio.jpg', 'cardapio.JPEG', 'aviso.png', 'foto.webp']) {
    assert.equal(contexto.tipoDoArquivo({ name: nome }), 'img', nome);
  }
  assert.equal(contexto.tipoDoArquivo({ name: 'manual.pdf' }), null);
  assert.equal(contexto.tipoDoArquivo(null), null);
});

function carregarEnvio({ modo, titulo = '', arquivo = null }) {
  const mensagens = [], envios = [];
  const campos = {
    'sl-title': { value: titulo }, 'sl-body': { value: '' }, 'sl-dur': { value: '8' },
    'sl-sem-tempo': { checked: false }, 'sl-bg': { value: '#111111' }
  };
  const contexto = vm.createContext({
    pendingFile: arquivo,
    document: {
      getElementById: id => campos[id],
      querySelector: seletor => seletor === 'input[name="sl-modo"]:checked' ? { value: modo } : { disabled: false }
    },
    toast: msg => mensagens.push(msg),
    enviarComProgresso: async () => { envios.push(true); return { error: 'parado no teste' }; },
    mostrarEnvio: () => {}, mb: () => 1, FormData: class { append() {} }
  });
  vm.runInContext(trecho('function slModo()', 'function slPadroes(') + trecho('async function addSlide(){', 'function renderSlides(){'), contexto);
  return { contexto, mensagens, envios };
}

test('sem arquivo no modo "vídeo ou foto", o painel pede o arquivo e não envia nada', async () => {
  const { contexto, mensagens, envios } = carregarEnvio({ modo: 'arquivo', titulo: 'INSTITUCIONAL' });
  await contexto.addSlide();
  assert.deepEqual(mensagens, ['Escolha o vídeo ou a foto que vai para as TVs']);
  assert.equal(envios.length, 0, 'um título sozinho não vira mais um texto vazio');
});

test('texto sem título é recusado antes de enviar', async () => {
  const { contexto, mensagens, envios } = carregarEnvio({ modo: 'txt' });
  await contexto.addSlide();
  assert.deepEqual(mensagens, ['Escreva o título do texto']);
  assert.equal(envios.length, 0);
});

test('escolher o arquivo volta para o modo de arquivo e sugere o nome sem apagar o que foi escrito', () => {
  const campos = {
    'sl-preview': { style: {}, innerHTML: '' }, 'sl-cancel': { style: {} }, 'sl-modo-arquivo': { checked: false },
    'sl-title': { value: '' }, 'sl-dur': { value: '8' }, 'sl-sem-tempo': { checked: false }
  };
  const contexto = vm.createContext({
    document: { getElementById: id => campos[id] },
    URL: { createObjectURL: () => 'blob:teste' }, limiteUploadMb: 2048, mb: () => 1,
    toast: () => {}, mostrarEnvio: () => {}, semTempoChange: () => {}, slMostrarCampos: () => {}, cancelFile: () => {}
  });
  vm.runInContext(
    trecho('function tipoDoArquivo(f){', 'function slTipo(') +
    trecho('function slPadroes(t){', '// Mostra só os campos') +
    trecho('let tituloAutomatico', 'function doDragOver(') +
    trecho('function handleFile(f){', 'async function addSlide(){') +
    ';this.lerTitulo=()=>tituloAutomatico;', contexto);

  contexto.handleFile({ name: 'cardapio_da-semana.png', size: 1000 });
  assert.equal(campos['sl-modo-arquivo'].checked, true);
  assert.equal(campos['sl-title'].value, 'cardapio da semana', 'mesmo nome que o servidor daria');
  assert.equal(campos['sl-sem-tempo'].checked, true, 'imagem continua nascendo sem tempo');

  // Trocar o arquivo troca o nome sugerido...
  contexto.handleFile({ name: 'video_novo.mp4', size: 1000 });
  assert.equal(campos['sl-title'].value, 'video novo');
  assert.equal(campos['sl-dur'].value, '0');
  // ...mas não o nome que a pessoa escreveu.
  campos['sl-title'].value = 'Campanha de outubro';
  contexto.handleFile({ name: 'outro.mp4', size: 1000 });
  assert.equal(campos['sl-title'].value, 'Campanha de outubro');
});

test('botões que salvam ficam travados até a resposta, mesmo com erro', async () => {
  const contexto = vm.createContext({});
  vm.runInContext(trecho('async function emAndamento(', 'function esc(value)'), contexto);
  const atributos = new Map();
  const botao = { disabled: false, setAttribute: (k, v) => atributos.set(k, v), removeAttribute: k => atributos.delete(k) };
  let chamadas = 0, terminar;
  const acao = () => { chamadas++; return new Promise(resolve => { terminar = resolve; }); };

  const primeiro = contexto.emAndamento(botao, acao);
  assert.equal(botao.disabled, true);
  assert.equal(atributos.get('aria-busy'), 'true');
  await contexto.emAndamento(botao, acao); // segundo clique enquanto salva
  assert.equal(chamadas, 1, 'o segundo clique não cria uma cópia');
  terminar();
  await primeiro;
  assert.equal(botao.disabled, false);
  assert.equal(atributos.has('aria-busy'), false);

  await assert.rejects(contexto.emAndamento(botao, async () => { throw new Error('falhou'); }));
  assert.equal(botao.disabled, false, 'erro não deixa o botão travado para sempre');
});

test('os botões de cadastro e de salvar usam a trava', () => {
  for (const acao of ['addGroup', 'addScreen', 'addUser', 'changeOwnPassword', 'saveSched', 'clearSched', 'saveVideoText']) {
    assert.ok(html.includes(`onclick="emAndamento(this,${acao})"`), 'sem trava: ' + acao);
  }
  // "Deixar sempre no ar" espera o salvamento terminar para soltar o botão.
  assert.match(trecho('function clearSched(){', '// AMBIENTES'), /return saveSched\(\);/);
  // Adicionar ao ambiente trava a lista enquanto salva.
  const adicionar = trecho('async function addToGroup(', 'async function removeFromGroup(');
  assert.match(adicionar, /select\.disabled=true;/);
  assert.match(adicionar, /finally\{select\.disabled=false;\}/);
});
