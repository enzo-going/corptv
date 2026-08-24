'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLoopbackAddress, isPrivateAddress } = require('../src/security');

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
