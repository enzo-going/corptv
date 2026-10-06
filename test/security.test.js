'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLoopback, isLoopbackAddress, isPrivateAddress, validatePassword } = require('../src/security');

test('endereço resolvido como local não dispensa ativação se o socket é remoto', () => {
  // Endereço de documentação: nenhum cliente real está envolvido.
  assert.equal(isLoopback({ ip: '::1', socket: { remoteAddress: '2001:db8::10' } }), false);
  assert.equal(isLoopback({ ip: '::1', socket: { remoteAddress: '::1' } }), true);
});

test('senhas novas exigem mais de quatro caracteres e preservam as demais restrições', () => {
  for (const password of [undefined, null, 12345, '', 'a', 'ab', 'abc', 'abcd']) {
    assert.equal(validatePassword(password).error, 'A senha deve ter pelo menos 5 caracteres.');
  }
  for (const password of ['abcde', 'a'.repeat(128)]) {
    assert.deepEqual(validatePassword(password), { value: password });
  }
  assert.equal(validatePassword('a'.repeat(129)).error, 'A senha deve ter no máximo 128 caracteres.');
  assert.equal(validatePassword('xLEITORx', 'leitor').error, 'A senha não deve conter o nome de usuário.');
});

test('reconhece endereços locais e privados IPv4/IPv6', () => {
  for (const address of [
    '127.0.0.1', '::1', '::ffff:192.168.20.50', '10.0.0.1',
    '172.16.0.1', '172.31.255.254', '192.168.1.10', 'fd00::10', 'fe80::1%12'
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('rejeita endereços públicos e intervalos fora da faixa privada', () => {
  for (const address of ['', '8.8.8.8', '172.15.255.255', '172.32.0.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('atrás do nginx cada TV conta no próprio limite, e o cabeçalho não é forjável', () => {
  const { chaveDeLimite } = require('../src/security');
  // Endereços de documentação: nenhum aparelho real.
  const viaNginx = real => ({ ip: '127.0.0.1', socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-real-ip': real } });
  assert.notEqual(chaveDeLimite(viaNginx('192.0.2.10')), chaveDeLimite(viaNginx('192.0.2.11')));
  assert.equal(chaveDeLimite(viaNginx('192.0.2.10')), '192.0.2.10');
  // Direto na porta 3000: o cabeçalho é ignorado.
  const direto = { ip: '192.0.2.50', socket: { remoteAddress: '192.0.2.50' }, headers: { 'x-real-ip': '192.0.2.99' } };
  assert.equal(chaveDeLimite(direto), '192.0.2.50');
  // Cabeçalho que não é endereço: cai no endereço da conexão.
  assert.equal(chaveDeLimite(viaNginx('qualquer coisa')), '127.0.0.1');
});
