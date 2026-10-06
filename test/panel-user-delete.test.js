'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('painel confirma nome e irreversibilidade antes de excluir, trata erro e atualiza a lista', async () => {
  const painel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
  const funcao = painel.slice(painel.indexOf('async function deleteUser('), painel.indexOf('async function updateUser('));
  const chamadas = [];
  let aceitar = false;
  let resultado = { ok: true };
  const contexto = vm.createContext({
    confirm: mensagem => { chamadas.push(['confirm', mensagem]); return aceitar; },
    api: async (...args) => { chamadas.push(['api', ...args]); return resultado; },
    loadUsers: async () => { chamadas.push(['load']); }, toast: texto => chamadas.push(['toast', texto])
  });
  vm.runInContext(funcao, contexto);
  await contexto.deleteUser('editor', 'Conta "Teste"');
  assert.deepEqual(chamadas, [['confirm', 'Excluir a conta "Conta "Teste""? Esta ação não pode ser desfeita.']]);
  aceitar = true;
  chamadas.length = 0;
  await contexto.deleteUser('editor', 'Conta de teste');
  assert.deepEqual(chamadas.slice(1), [['api', 'DELETE', '/api/users/editor'], ['load'], ['toast', 'Conta excluída']]);
  resultado = { error: 'Exclusão recusada' };
  chamadas.length = 0;
  await contexto.deleteUser('editor', 'Conta de teste');
  assert.deepEqual(chamadas.slice(1), [['api', 'DELETE', '/api/users/editor'], ['toast', 'Exclusão recusada']]);
  const lista = painel.slice(painel.indexOf('async function loadUsers(){'), painel.indexOf('async function deleteUser('));
  assert.ok(lista.includes('data-name="${esc(user.name)}"'));
  assert.ok(lista.includes('onclick="deleteUser(this.dataset.id,this.dataset.name)">Excluir</button>'));
});
