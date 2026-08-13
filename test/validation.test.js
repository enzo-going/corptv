'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDuration,
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

test('rejeita campos longos e cores fora do formato hexadecimal', () => {
  assert.match(validateGroupInput({ name: 'x'.repeat(81), color: '#123456' }).error, /80/);
  assert.match(validateGroupInput({ name: 'Grupo', color: 'red;display:none' }).error, /cor inválida/i);
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
