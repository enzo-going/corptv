'use strict';

const fs = require('node:fs');

module.exports = function limparTemporario(pasta) {
  try {
    fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (erro) {
    console.warn('Não foi possível limpar a pasta temporária após as tentativas:', erro.code || 'erro desconhecido');
  }
};
