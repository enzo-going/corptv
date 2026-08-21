'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');

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
