'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const login = fs.readFileSync(path.join(__dirname, '../public/login/index.html'), 'utf8');

test('o botão Copiar possui fallback para painel HTTP', () => {
  assert.match(panel, /window\.isSecureContext&&navigator\.clipboard/);
  assert.match(panel, /document\.execCommand\('copy'\)/);
  assert.match(panel, /document\.createElement\('textarea'\)/);
  assert.match(panel, /class="url-value"/);
  assert.match(panel, /Cópia bloqueada pelo navegador — pressione Ctrl\+C/);
  assert.match(panel, /Não foi possível copiar/);
});

test('o painel oferece os três modos de texto do vídeo', () => {
  assert.match(panel, /value="fixed">Fixo durante todo o vídeo/);
  assert.match(panel, /value="timed">Temporário com fade/);
  assert.match(panel, /value="none">Não exibir texto/);
  assert.match(panel, /video_text_mode/);
  assert.match(panel, /video_text_seconds/);
  assert.match(panel, /Texto do vídeo/);
});

test('o painel ajusta o volume de cada tela e não perde o ajuste no redesenho', () => {
  assert.match(panel, /class="editor-only volume-range" type="range" min="0" max="100" step="5"/);
  assert.match(panel, /api\('PUT','\/api\/screens\/'\+id,\{name:s\.name,group_id:s\.group_id,volume\}\)/);
  assert.match(panel, /function volumeText\(v\)\{return v===0\?'Mudo':v\+'%';\}/);
  // O load() redesenha tudo a cada 30 s; no meio de um arraste, o controle era trocado.
  const inicioRender = panel.slice(panel.indexOf('async function renderScreens(){'), panel.indexOf("const el=document.getElementById('screen-list');"));
  assert.match(inicioRender, /classList\.contains\('volume-range'\)\)return;/);
});

test('o painel aplica sessão, CSRF, perfis e escape aos dados renderizados', () => {
  assert.match(panel, /\/api\/auth\/me/);
  assert.match(panel, /X-CSRF-Token/);
  assert.match(panel, /data-admin-only/);
  assert.match(panel, /body\.readonly \.editor-only/);
  assert.match(panel, /function esc\(value\)/);
  assert.match(panel, /\/api\/audit/);
  assert.match(panel, /\/api\/users/);
});

test('a configuração inicial remota pede o código de ativação descartável', () => {
  assert.match(login, /name="setup_code"/);
  assert.match(login, /\/api\/setup\/status/);
  assert.match(login, /activation_required/);
  assert.match(login, /body\.setup\.remote \.remote-only/);
});

test('o mínimo de 12 caracteres vale só para senha nova, nunca para entrar', () => {
  // Com minlength fixo no campo, o navegador barrava no login quem tinha senha
  // antiga mais curta — o servidor aceitaria, mas o pedido nem saía da página.
  const campoSenha = login.match(/<input id="password"[^>]*>/)[0];
  const campoConfirma = login.match(/<input id="confirm"[^>]*>/)[0];
  assert.doesNotMatch(campoSenha, /minlength/i);
  assert.doesNotMatch(campoConfirma, /minlength/i);

  const blocoCadastro = login.slice(login.indexOf('if(setup){'));
  assert.match(blocoCadastro, /getElementById\('password'\)\.minLength=12/);
  assert.match(blocoCadastro, /getElementById\('confirm'\)\.minLength=12/);
});

test('o login não redireciona para um destino fornecido pela URL', () => {
  assert.doesNotMatch(login, /params\.get\(['"]next['"]\)/);
  assert.match(login, /location\.href=['"]\/painel['"]/);
});
