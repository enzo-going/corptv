'use strict';

// Conferência das mídias: o SHA-256 de cada arquivo vai junto na programação e a
// Raspberry confere o que baixou antes de pôr no ar. Antes ela só comparava o
// tamanho: um arquivo do tamanho certo com bytes errados (rede ou cartão com
// defeito) tocava travado ou nem tocava, sem ninguém saber por quê.
//
// O cálculo é feito uma vez por arquivo, um de cada vez e só quando alguma tela
// pede a mídia (o servidor é o controlador de domínio), e fica guardado em disco:
// reiniciar não recalcula tudo. Enquanto não está pronto, a programação vai sem o
// hash e a Pi segue como antes, conferindo só o tamanho.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHA256 = /^[0-9a-f]{64}$/;

function calcularSha256(arquivo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const leitura = fs.createReadStream(arquivo, { highWaterMark: 1024 * 1024 });
    leitura.on('data', pedaco => hash.update(pedaco));
    leitura.on('end', () => resolve(hash.digest('hex')));
    leitura.on('error', reject);
  });
}

function criarConferencia({ uploadsDir, arquivoCache, log = () => {} }) {
  // nome do arquivo -> { tamanho, mtimeMs, sha256 } do arquivo como ele estava no cálculo.
  const conhecidos = new Map();
  try {
    const salvo = JSON.parse(fs.readFileSync(arquivoCache, 'utf8'));
    for (const [nome, v] of Object.entries(salvo)) {
      if (v && SHA256.test(v.sha256)) conhecidos.set(nome, v);
    }
  } catch (e) { /* primeira vez ou arquivo ilegível: calcula de novo conforme pedirem */ }

  const fila = [];
  let ocupado = false;

  function salvar() {
    // Mídia excluída sai da lista.
    for (const nome of conhecidos.keys()) {
      if (!fs.existsSync(path.join(uploadsDir, nome))) conhecidos.delete(nome);
    }
    try {
      fs.writeFileSync(arquivoCache + '.tmp', JSON.stringify(Object.fromEntries(conhecidos)));
      fs.renameSync(arquivoCache + '.tmp', arquivoCache);
    } catch (e) {
      log('AVISO', 'não consegui guardar os hashes das mídias', { msg: e.message });
    }
  }

  async function processar() {
    if (ocupado) return;
    ocupado = true;
    try {
      while (fila.length) {
        const nome = fila[0];
        const arquivo = path.join(uploadsDir, nome);
        try {
          const antes = await fs.promises.stat(arquivo);
          const sha256 = await calcularSha256(arquivo);
          const depois = await fs.promises.stat(arquivo);
          // Mudou durante a leitura: fica para o próximo pedido.
          if (antes.size === depois.size && antes.mtimeMs === depois.mtimeMs) {
            conhecidos.set(nome, { tamanho: depois.size, mtimeMs: depois.mtimeMs, sha256 });
            salvar();
          }
        } catch (e) {
          if (e.code !== 'ENOENT') log('AVISO', 'não consegui calcular o hash da mídia', { arquivo: nome, msg: e.message });
        }
        fila.shift();
      }
    } finally {
      ocupado = false;
    }
  }

  // Hash do arquivo como ele está agora, se já calculado. Senão, pede o cálculo e
  // devolve null: a programação vai sem o hash desta vez.
  async function hashDe(nome) {
    let info;
    try { info = await fs.promises.stat(path.join(uploadsDir, nome)); } catch (e) { return null; }
    const v = conhecidos.get(nome);
    if (v && v.tamanho === info.size && v.mtimeMs === info.mtimeMs) return v.sha256;
    if (!fila.includes(nome)) {
      fila.push(nome);
      setImmediate(processar);
    }
    return null;
  }

  return { hashDe, ocioso: () => !ocupado && fila.length === 0 };
}

module.exports = { criarConferencia, calcularSha256 };
