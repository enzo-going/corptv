'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeForMs,
  parseDays,
  scheduleFromBody,
  slideStatus,
  toMinutes,
  validarAgendamento
} = require('../src/scheduling');

test('normaliza os dias sem duplicações ou valores inválidos', () => {
  assert.deepEqual(parseDays('1,1,6,9,x,0'), [1, 6, 0]);
});

test('aceita somente horários reais no formato HH:MM', () => {
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(toMinutes('9:30'), null);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('12:60'), null);
});

test('rejeita datas e janelas impossíveis', () => {
  let raw = { starts_at: 'invalida', expires_at: '', days: '', time_start: '', time_end: '' };
  assert.match(validarAgendamento(scheduleFromBody(raw), raw), /data de início/i);

  raw = { starts_at: '2026-08-14T10:00', expires_at: '2026-08-14T09:00', days: '', time_start: '', time_end: '' };
  assert.match(validarAgendamento(scheduleFromBody(raw), raw), /anterior/i);

  raw = { starts_at: '', expires_at: '', days: '', time_start: '09:00', time_end: '' };
  assert.match(validarAgendamento(scheduleFromBody(raw), raw), /horário de fim/i);
});

test('respeita início e expiração', () => {
  const slide = { starts_at: '2026-08-13T12:00:00.000Z', expires_at: '2026-08-13T14:00:00.000Z', days: [] };
  assert.equal(slideStatus(slide, new Date('2026-08-13T11:59:00.000Z')).reason, 'aguardando');
  assert.equal(slideStatus(slide, new Date('2026-08-13T13:00:00.000Z')).active, true);
  assert.equal(slideStatus(slide, new Date('2026-08-13T14:01:00.000Z')).reason, 'expirado');
});

test('associa a madrugada ao dia que iniciou uma janela que cruza meia-noite', () => {
  const mondayOnly = { days: [1], time_start: '22:00', time_end: '06:00' };
  assert.equal(slideStatus(mondayOnly, new Date(2026, 7, 10, 23, 0)).active, true); // segunda
  assert.equal(slideStatus(mondayOnly, new Date(2026, 7, 11, 2, 0)).active, true);  // terça, continuação
  assert.equal(slideStatus(mondayOnly, new Date(2026, 7, 11, 23, 0)).reason, 'fora_do_dia');
});

test('calcula o limite seguro do cache offline', () => {
  const now = new Date(2026, 7, 10, 23, 0, 0, 0);
  const slide = { days: [1], time_start: '22:00', time_end: '06:00' };
  assert.equal(activeForMs(slide, now), 7 * 60 * 60 * 1000 + 60 * 1000);
  assert.equal(activeForMs({ days: [] }, now), null);
});
