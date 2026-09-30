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

test('fechar a tela cheia de propósito (Alt+F4) não reabre por cima; queda reabre', () => {
  // Código 0 só sai quando alguém fecha a janela: é manutenção.
  const saida = quiosque.indexOf('if [ "$saida" -eq 0 ]; then');
  assert.ok(saida > 0, 'faltou tratar o fechamento de propósito');
  assert.ok(saida < quiosque.indexOf('reabrindo em ${espera}s'), 'tem de decidir antes de reabrir');
  assert.ok(quiosque.slice(saida, saida + 250).includes('break'));
  // E há um atalho no menu para voltar sem reiniciar.
  const atalho = fs.readFileSync(path.join(__dirname, '../agente/corptv-quiosque.desktop'), 'utf8');
  assert.match(atalho, /^Name=CorporTV na TV$/m);
  const preparo = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');
  assert.ok(preparo.includes('/.local/share/applications/corptv-quiosque.desktop'));
});

test('o navegador da TV não oferece tradução do conteúdo', () => {
  assert.ok(quiosque.includes('    --lang=pt-BR \\\n'));
  const preparo = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');
  assert.ok(preparo.includes('"TranslateEnabled": false'));
  assert.ok(preparo.includes('/etc/chromium/policies/managed/corptv.json'));
});

test('o quiosque não deixa o chaveiro do sistema abrir janela por cima da TV', () => {
  // Com login automático, o chaveiro pedia uma senha nova a cada boot.
  assert.ok(quiosque.includes('    --password-store=basic \\\n'));
});

test('o quiosque aponta para o agente local, nunca para o servidor', () => {
  assert.match(quiosque, /URL="http:\/\/127\.0\.0\.1:\$\{PORTA\}\//);
  assert.doesNotMatch(quiosque, /chromium.*:3000/is);
});

test('o quiosque funciona no Wayland (labwc) e no X11, com um navegador só', () => {
  // xset só existe no X11: no labwc, rodar sem condição só gerava erro.
  assert.match(quiosque, /if \[ -n "\$\{DISPLAY:-\}" \] && \[ -z "\$\{WAYLAND_DISPLAY:-\}" \] && command -v xset/);
  assert.doesNotMatch(quiosque, /^xset /m);
  // Pi OS atual chama o navegador de chromium; o antigo, de chromium-browser.
  assert.match(quiosque, /NAVEGADOR=\$\(command -v chromium-browser \|\| command -v chromium/);
  assert.match(quiosque, /--ozone-platform-hint=auto/);
  // Trava: dois quiosques disputariam tela e som.
  assert.match(quiosque, /flock -n 9/);
});

test('o preparo da Pi instala o quiosque e deixa ela ligar direto na tela', () => {
  const script = fs.readFileSync(path.join(__dirname, '../agente/preparar-pi.sh'), 'utf8');
  assert.ok(script.includes('install -m 755 "$tmp/iniciar-quiosque.sh" /opt/corptv-agente/iniciar-quiosque.sh'));
  assert.ok(script.includes('"$casa/.config/autostart/corptv-quiosque.desktop"'));
  assert.ok(script.includes('raspi-config nonint do_blanking 1'));
  assert.ok(script.includes('raspi-config nonint do_boot_behaviour B4'));
  // A rede continua sendo o último passo (reaplicar derruba o SSH).
  assert.ok(script.indexOf('nmcli device reapply') > script.indexOf('corptv-quiosque.desktop"'));
});

test('o quiosque manda o som para a HDMI no volume máximo antes de abrir o navegador', () => {
  const configura = quiosque.indexOf('\nconfigurar_audio\n');
  const abre = quiosque.indexOf('"$NAVEGADOR" \\');
  assert.ok(configura > 0, 'o quiosque não configura o som');
  assert.ok(configura < abre, 'o som precisa ser configurado antes de abrir o navegador');
  assert.match(quiosque, /grep -m1 'fef00700\.\*hdmi'/);
  assert.match(quiosque, /pactl set-default-sink "\$saida"/);
  assert.match(quiosque, /pactl set-sink-mute "\$saida" 0/);
  assert.match(quiosque, /pactl set-sink-volume "\$saida" 100%/);
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

test('o serviço do agente roda com usuário próprio e config do aparelho fora da unit', () => {
  assert.match(servico, /^DynamicUser=yes$/m);
  assert.match(servico, /^StateDirectory=corptv$/m);
  assert.ok(servico.includes('\nEnvironmentFile=/etc/corptv/agente.env\n'));
  assert.doesNotMatch(servico, /^User=/m, 'usuário fixo quebra em Pi com outro usuário');
  assert.doesNotMatch(servico, /^Environment=CORPTV_(SERVIDOR|TELA)=/m);
});

test('o script de preparo da Pi é válido e seguro para "curl | bash"', () => {
  const arquivo = path.join(__dirname, '../agente/preparar-pi.sh');
  const script = fs.readFileSync(arquivo, 'utf8');
  // Tudo dentro de main(): o bash lê o script inteiro antes de executar.
  assert.ok(script.includes('\nmain() {\n'));
  assert.ok(script.includes('\nmain "$@"\n'));
  assert.ok(script.includes('apt-get install -y -qq nodejs </dev/null'));
  // Reaplicar a rede derruba o SSH: tem de ser o último passo.
  assert.ok(script.indexOf('nmcli device reapply') > script.indexOf('systemctl restart corptv-agente'));
  const bash = require('node:child_process').spawnSync('bash', ['-n', arquivo], { encoding: 'utf8' });
  if (!bash.error) assert.equal(bash.status, 0, bash.stderr);
});
