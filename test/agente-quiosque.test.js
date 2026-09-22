'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const quiosque = fs.readFileSync(path.join(__dirname, '../agente/iniciar-quiosque.sh'), 'utf8');
const servico = fs.readFileSync(path.join(__dirname, '../agente/corptv-agente.service'), 'utf8');

test('o quiosque reabre o navegador em vez de terminar junto com ele', () => {
  // O systemd cobre o agente; quem cobre o navegador é o laço do script. Com
  // `exec`, um Chromium que fecha deixava a TV preta até alguém ir reiniciar.
  assert.doesNotMatch(quiosque, /^\s*exec\s+chromium/im);
  assert.match(quiosque, /while \[ "\$encerrando" -eq 0 \]/);
  assert.match(quiosque, /wait "\$navegador"/);
});

test('o quiosque espera mais a cada falha seguida, para não martelar', () => {
  assert.match(quiosque, /falhas_seguidas/);
  assert.match(quiosque, /espera=\$\(\( 2 \*\* falhas_seguidas \)\)/);
  assert.match(quiosque, /falhas_seguidas" -gt 5 \] && falhas_seguidas=5/);
});

test('o quiosque sai limpo quando a sessão é encerrada', () => {
  assert.match(quiosque, /trap '.*encerrando=1.*' TERM INT HUP/);
});

test('o quiosque aponta para o agente local, nunca para o servidor', () => {
  assert.match(quiosque, /URL="http:\/\/127\.0\.0\.1:\$\{PORTA\}\//);
  assert.doesNotMatch(quiosque, /chromium.*:3000/is);
});

test('o serviço do agente volta sozinho depois de uma falha', () => {
  assert.match(servico, /^Restart=always$/m);
  assert.match(servico, /^RestartSec=/m);
});

test('nenhum arquivo do agente carrega endereço de servidor real', () => {
  const pasta = path.join(__dirname, '../agente');
  for (const nome of fs.readdirSync(pasta)) {
    const conteudo = fs.readFileSync(path.join(pasta, nome), 'utf8');
    const achados = conteudo.match(/\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
    // 192.168.0.10 é o exemplo usado na documentação; qualquer outro endereço
    // privado aqui é configuração de um ambiente real que vazou para o repositório.
    const vazados = achados.filter(endereco => endereco !== '192.168.0.10');
    assert.deepEqual(vazados, [], `${nome} traz endereço de rede interna: ${vazados.join(', ')}`);
  }
});
