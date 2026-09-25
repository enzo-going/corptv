'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDuration,
  normalizeVideoText,
  validateGroupInput,
  validateScreenInput,
  validateSlideInput
} = require('../src/validation');

test('normaliza nomes, cores e telas', () => {
  assert.deepEqual(validateGroupInput({ name: '  Recepção  ', color: '#AABBCC' }).value, {
    name: 'Recepção', color: '#aabbcc'
  });
  assert.deepEqual(validateScreenInput({ name: ' TV 1 ', group_id: ' grupo ' }).value, {
    name: 'TV 1', group_id: 'grupo'
  });
});

test('valida o volume da tela como inteiro entre 0 e 100', () => {
  assert.equal(validateScreenInput({ name: 'TV', group_id: 'g', volume: 60 }).value.volume, 60);
  assert.equal(validateScreenInput({ name: 'TV', group_id: 'g', volume: ' 0 ' }).value.volume, 0);
  assert.equal(validateScreenInput({ name: 'TV', group_id: 'g', volume: '100' }).value.volume, 100);
  // Ausente não entra no objeto: editar nome ou ambiente não pode mexer no volume.
  assert.equal('volume' in validateScreenInput({ name: 'TV', group_id: 'g' }).value, false);
  assert.equal('volume' in validateScreenInput({ name: 'TV', group_id: 'g', volume: '' }).value, false);
  for (const invalido of [-1, 101, 50.5, 'alto', true]) {
    assert.match(validateScreenInput({ name: 'TV', group_id: 'g', volume: invalido }).error, /0 e 100/);
  }
});

test('rejeita campos longos e cores fora do formato hexadecimal', () => {
  assert.match(validateGroupInput({ name: 'x'.repeat(81), color: '#123456' }).error, /80/);
  assert.match(validateGroupInput({ name: 'Grupo', color: 'red;display:none' }).error, /cor inválida/i);
});

test('aceita 0 como "sem tempo" para imagem e texto', () => {
  assert.equal(normalizeDuration('0', 'img').value, 0);
  assert.equal(normalizeDuration(0, 'txt').value, 0);
  assert.equal(normalizeDuration('', 'img').value, 8);         // campo vazio: padrão de sempre
  assert.equal(normalizeDuration(undefined, 'img').value, 8);
  for (const invalida of ['1', '2', '-1', '7.5', 'oito']) {
    assert.match(normalizeDuration(invalida, 'img').error, /0 \(sem tempo\)/);
  }
});

test('limita a duração de slides e ignora duração em vídeo', () => {
  assert.equal(normalizeDuration('3', 'txt').value, 3);
  assert.match(normalizeDuration('301', 'txt').error, /3 e 300/);
  assert.equal(normalizeDuration('999', 'vid').value, 0);
});

test('um slide exige título ou arquivo e respeita os limites', () => {
  assert.match(validateSlideInput({ type: 'txt', duration: '8', bg: '#111111' }).error, /título ou arquivo/i);
  assert.match(validateSlideInput({ title: 'x'.repeat(121), type: 'txt', duration: '8', bg: '#111111' }).error, /120/);
  assert.equal(validateSlideInput({ title: '', type: 'img', duration: '8', bg: '#111111' }, { hasFile: true, fileType: 'img' }).value.type, 'img');
});

test('valida os três modos de texto sobre vídeo', () => {
  assert.deepEqual(normalizeVideoText({ video_text_mode: 'none' }, 'vid').value, {
    video_text_mode: 'none', video_text_seconds: 0
  });
  assert.deepEqual(normalizeVideoText({ video_text_mode: 'fixed' }, 'vid').value, {
    video_text_mode: 'fixed', video_text_seconds: 0
  });
  assert.deepEqual(normalizeVideoText({ video_text_mode: 'timed', video_text_seconds: '7' }, 'vid').value, {
    video_text_mode: 'timed', video_text_seconds: 7
  });
  assert.match(normalizeVideoText({ video_text_mode: 'timed', video_text_seconds: '0' }, 'vid').error, /1 e 300/);
  assert.match(normalizeVideoText({ video_text_mode: 'piscar' }, 'vid').error, /inválido/i);
});
