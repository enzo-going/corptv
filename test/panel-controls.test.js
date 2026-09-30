'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '../public/painel/index.html'), 'utf8');
const login = fs.readFileSync(path.join(__dirname, '../public/login/index.html'), 'utf8');

test('o botão Copiar possui fallback para painel HTTP', () => {
  assert.match(panel, /window\.isSecureContext&&navigator\.clipboard/);
  assert.match(panel, /document\.execCommand\('copy'\)/);
  assert.match(panel, /document\.createElement\('textarea'\)/);
  assert.match(panel, /class="url-value"/);
  assert.match(panel, /Cópia bloqueada pelo navegador — pressione Ctrl\+C/);
  assert.match(panel, /Não foi possível copiar/);
});

test('o painel oferece os três modos de texto do vídeo', () => {
  assert.match(panel, /value="fixed">Fixo durante todo o vídeo/);
  assert.match(panel, /value="timed">Temporário com fade/);
  assert.match(panel, /value="none">Não exibir texto/);
  assert.match(panel, /video_text_mode/);
  assert.match(panel, /video_text_seconds/);
  assert.match(panel, /Texto do vídeo/);
});

test('o painel ajusta o volume de cada tela e não perde o ajuste no redesenho', () => {
  assert.match(panel, /class="editor-only volume-range" type="range" min="0" max="100" step="5"/);
  assert.match(panel, /api\('PUT','\/api\/screens\/'\+id,\{name:s\.name,group_id:s\.group_id,volume\}\)/);
  assert.match(panel, /function volumeText\(v\)\{return v===0\?'Mudo':v\+'%';\}/);
  // O load() redesenha tudo a cada 30 s; no meio de um arraste, o controle era trocado.
  const inicioRender = panel.slice(panel.indexOf('async function renderScreens(){'), panel.indexOf("const el=document.getElementById('screen-list');"));
  assert.match(inicioRender, /classList\.contains\('volume-range'\)\)return;/);
});

test('o painel mostra desde quando a tela sumiu e pede recarga à TV', () => {
  assert.match(panel, /function lastSeenText\(v\)\{/);
  assert.match(panel, /if\(!v\)return 'nunca conectou';/);
  assert.match(panel, /\$\{online\?'':' · '\+esc\(lastSeenText\(s\.last_seen\)\)\}/);
  // O botão age na TV; o indicador continua sendo só o aviso que a TV manda.
  assert.match(panel, /class="btn btn-ghost btn-sm editor-only" onclick="reloadScreen\('\$\{s\.id\}'\)"/);
  assert.match(panel, /api\('POST','\/api\/screens\/'\+id\+'\/recarregar'\)/);
  assert.doesNotMatch(panel, /last_seen\s*=/);
});

test('Aparelhos é uma página só do TI, com um comando único para Raspberry nova', () => {
  // Um comando só, igual para toda Raspberry, num lugar só — nada por tela.
  assert.ok(panel.includes("function piCommand(origin){return 'curl -fsSL '+origin+'/pi/preparar.sh | sudo bash';}"));
  assert.ok(panel.includes(`onclick="goTo('aparelhos',this)"`));
  assert.ok(panel.includes(`<button class="nav-item" data-admin-only hidden onclick="goTo('aparelhos',this)">`));
  assert.ok(panel.includes("if((p==='users'||p==='audit'||p==='aparelhos')&&(!permissions||!permissions.users))"));
  const pagina = panel.slice(panel.indexOf('<div class="page" id="page-aparelhos">'), panel.indexOf('<!-- MINHA CONTA -->'));
  assert.ok(pagina.includes('Adicionar Raspberry'));
  assert.ok(pagina.includes('<div class="card" id="pi-setup" hidden>'), 'o passo a passo começa fechado');
  // Quem publica conteúdo não vê nada de Raspberry na página Telas.
  const telas = panel.slice(panel.indexOf('<div class="page" id="page-telas">'), panel.indexOf('<div class="page" id="page-aparelhos">'));
  assert.ok(!telas.includes('Raspberry'));
  assert.ok(panel.includes('body:not(.admin) .admin-only{display:none!important}'));
  assert.ok(panel.includes("document.body.classList.toggle('admin',!!permissions.users)"));
  assert.ok(!panel.includes('Nome da tela no agente'), 'o nome da tela no agente saiu do painel');
  assert.ok(!panel.includes('sudo bash -s --'), 'o comando não leva mais o nome da tela');
  // A tela de cada aparelho se escolhe numa lista, que não fecha no redesenho de 30 s.
  assert.ok(panel.includes('<div id="device-list"></div>'));
  assert.ok(panel.includes("api('PUT','/api/aparelhos/'+id,{screen_id:value||null})"));
  assert.ok(panel.includes("ativo.classList.contains('device-select'))return;"));
  assert.ok(panel.includes("api('GET','/api/aparelhos')"));
  // Mesmo no celular (que usa o endereço aberto nos links), o comando leva o endereço
  // oficial: é dele que a Pi tira o domínio do corportv/ curto.
  assert.ok(panel.includes('function officialOrigin(){return enderecoPublicoConfig||publicOrigin();}'));
  assert.ok(panel.includes("cmd.value=piCommand(officialOrigin());"));
});

test('o cartão de tela é curto: Abrir à vista, o resto no menu', () => {
  assert.ok(!panel.includes('class="tecnico'), 'voltou a haver instalação dentro de cada tela');
  const card = panel.slice(panel.indexOf('async function renderScreens(){'), panel.indexOf('function toggleScreenMenu('));
  assert.ok(card.includes('title="Ver o que esta TV está exibindo">Abrir</a>'));
  assert.ok(card.includes(`<div class="screen-menu" id="menu-\${s.id}" \${aberto?'':'hidden'}>`));
  for (const acao of ['>Renomear</button>', '>Recarregar a TV</button>', '>Copiar link</button>', '>Excluir</button>']) {
    assert.ok(card.includes(acao), 'faltou no menu: ' + acao);
  }
  assert.ok(!card.includes('url-box'), 'o endereço longo não aparece mais no cartão');
});

test('o painel oferece "sem tempo" para imagem e texto, e deixa mudar depois', () => {
  assert.match(panel, /id="sl-sem-tempo"[^>]*onchange="semTempoChange\(\)"/);
  assert.match(panel, /Sem tempo — fica na tela até ser tirado/);
  // Imagem nasce sem tempo: é o caso de quase sempre.
  assert.match(panel, /getElementById\('sl-sem-tempo'\)\.checked=t==='img'/);
  assert.match(panel, /const dur=type!=='vid'&&document\.getElementById\('sl-sem-tempo'\)\.checked\?'0':/);
  assert.match(panel, /return d===0\?'sem tempo':/);
  // Conteúdo que já existe muda sem precisar ser enviado de novo.
  assert.match(panel, /onclick="editDuration\('\$\{s\.id\}'\)">Tempo<\/button>/);
  assert.match(panel, /api\('PUT','\/api\/slides\/'\+id,\{duration:n\}\)/);
});

test('o painel avisa quando um conteúdo sem tempo prende o rodízio do ambiente', () => {
  assert.match(panel, /x\.type!=='vid'&&parseInt\(x\.duration,10\)===0/);
  assert.match(panel, /\(parado&&noArLista\.length>1\)/);
  assert.match(panel, /quando a TV chegar nele, fica parada ali/);
});

test('o painel aplica sessão, CSRF, perfis e escape aos dados renderizados', () => {
  assert.match(panel, /\/api\/auth\/me/);
  assert.match(panel, /X-CSRF-Token/);
  assert.match(panel, /data-admin-only/);
  assert.match(panel, /body\.readonly \.editor-only/);
  assert.match(panel, /function esc\(value\)/);
  assert.match(panel, /\/api\/audit/);
  assert.match(panel, /\/api\/users/);
});

test('a configuração inicial remota pede o código de ativação descartável', () => {
  assert.match(login, /name="setup_code"/);
  assert.match(login, /\/api\/setup\/status/);
  assert.match(login, /activation_required/);
  assert.match(login, /body\.setup\.remote \.remote-only/);
});

test('o mínimo de 5 caracteres vale só para senha nova, nunca para entrar', () => {
  // Com minlength fixo no campo, o navegador barrava no login quem tinha senha
  // antiga mais curta — o servidor aceitaria, mas o pedido nem saía da página.
  const campoSenha = login.match(/<input id="password"[^>]*>/)[0];
  const campoConfirma = login.match(/<input id="confirm"[^>]*>/)[0];
  assert.doesNotMatch(campoSenha, /minlength/i);
  assert.doesNotMatch(campoConfirma, /minlength/i);

  const blocoCadastro = login.slice(login.indexOf('if(setup){'));
  assert.match(blocoCadastro, /getElementById\('password'\)\.minLength=5/);
  assert.match(blocoCadastro, /getElementById\('confirm'\)\.minLength=5/);
});

test('criar, trocar e redefinir senhas no painel exige pelo menos cinco caracteres', () => {
  for (const id of ['pw-new', 'us-password']) {
    const campo = panel.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0];
    assert.match(campo, /minlength="5"/);
    assert.match(campo, /maxlength="128"/);
  }
  assert.match(panel, /next\.length<5/);
  assert.match(panel, /body\.password\.length<5/);
  assert.match(panel, /if\(password\.length<5\)/);
  assert.match(panel, /mínimo de 5 caracteres/);
  assert.doesNotMatch(panel + login, /12 caracteres/);
});

test('o login não redireciona para um destino fornecido pela URL', () => {
  assert.doesNotMatch(login, /params\.get\(['"]next['"]\)/);
  assert.match(login, /location\.href=['"]\/painel['"]/);
});

test('o painel usa o endereço oficial nos links', () => {
  // Aberto pelo IP, o painel distribuía links com IP e porta.
  assert.match(panel, /api\('GET','\/api\/config'\);enderecoPublicoConfig=cfg\.endereco_publico\|\|null/);
  assert.match(panel, /if\(enderecoPublicoConfig\)return enderecoPublicoConfig;/);
});

test('o menu recolhe só no celular e informa seu estado ao leitor de tela', () => {
  assert.match(panel, /\.menu-toggle,\.mobile-overview\{display:none\}/);
  assert.match(panel, /@media\(max-width:767px\)/);
  assert.match(panel, /\.sidebar:not\(\.menu-open\) \.nav,\.sidebar:not\(\.menu-open\) \.account\{display:none\}/);
  assert.match(panel, /id="menu-toggle"[^>]*aria-controls="panel-nav panel-account"[^>]*aria-expanded="false"/);
  assert.match(panel, /const mobileLayout=window\.matchMedia\('\(max-width:767px\), \(max-width:1023px\) and \(hover:none\) and \(pointer:coarse\)'\)/);
  assert.match(panel, /toggle\.setAttribute\('aria-expanded',String\(!mobileLayout\.matches\|\|expanded\)\)/);
  assert.match(panel, /mobileLayout\.addEventListener\('change',syncLayout\)/);
  const navegacao = panel.slice(panel.indexOf('function goTo('), panel.indexOf('async function api('));
  assert.match(navegacao, /setMenu\(false,true\)/);
  assert.match(navegacao, /if\(mobileLayout\.matches\)window\.scrollTo\(0,0\)/);
  assert.match(panel, /if\(restoreFocus&&mobileLayout\.matches\)toggle\.focus\(\)/);
  assert.match(panel, /e\.key==='Escape'&&[^\n]+setMenu\(false,true\)/);
});

test('cartões, formulários e ações cabem em uma coluna no celular', () => {
  const desktop = panel.slice(0, panel.indexOf('@media(max-width:767px)'));
  const mobile = panel.slice(panel.indexOf('@media(max-width:767px)'), panel.indexOf('</style>'));
  // As duas colunas do dashboard e os 220px do menu permanecem no desktop.
  assert.match(desktop, /\.sidebar\{width:220px/);
  assert.match(desktop, /\.dash-grid\{display:grid;grid-template-columns:1fr 1fr;gap:10px\}/);
  assert.match(mobile, /\.shell\{flex-direction:column;height:auto;/);
  assert.match(mobile, /\.form-grid,\.dash-grid,\.stats-row,\.security-grid,\.user-row,\.audit-tools\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(mobile, /\.form-full,details\.sched\{grid-column:span 1\}/);
  assert.match(mobile, /\.item-actions\{grid-column:1\/-1;flex-wrap:wrap;/);
  assert.match(mobile, /\.item-name\{white-space:normal;overflow-wrap:anywhere;/);
  assert.match(mobile, /\.url-box\{flex-wrap:wrap;/);
  assert.match(mobile, /\.btn,\.pill,\.day,details\.sched summary,\.checkbox-label\{min-height:48px;min-width:48px\}/);
});

test('o volume tem área de toque e mantém o foco durante o arraste com o dedo', () => {
  const mobile = panel.slice(panel.indexOf('@media(max-width:767px)'), panel.indexOf('</style>'));
  assert.match(mobile, /\.volume-range\{height:52px;[^}]*touch-action:pan-y/);
  assert.match(mobile, /\.volume-range::-webkit-slider-thumb\{[^}]*width:32px;height:32px/);
  assert.match(mobile, /\.volume-range::-moz-range-thumb\{[^}]*width:28px;height:28px/);
  assert.match(panel, /class="editor-only volume-range"[^>]*onpointerdown="this\.focus\(\)"/);
  assert.match(panel, /aria-valuetext="\$\{volumeText\(vol\)\}"/);
  assert.match(panel, /this\.setAttribute\('aria-valuetext',volumeText\(\+this\.value\)\)/);
});

test('a visão geral móvel começa pelas telas online e offline e pela programação dos ambientes', () => {
  const dashboard = panel.slice(panel.indexOf('id="page-dash"'), panel.indexOf('<!-- SLIDES -->'));
  assert.ok(dashboard.indexOf('class="mobile-overview"') < dashboard.indexOf('class="stats-row"'));
  assert.match(dashboard, /id="st-online"/);
  assert.match(dashboard, /id="st-offline"/);
  assert.match(dashboard, /id="overview-groups"/);
  assert.match(panel, /function screenOnline\(s\)\{return !!s\.last_seen&&\(Date\.now\(\)-new Date\(s\.last_seen\)\.getTime\(\)\)<60000;/);
  assert.match(panel, /getElementById\('st-online'\)\.textContent=online/);
  assert.match(panel, /getElementById\('st-offline'\)\.textContent=screens\.length-online/);
});

test('o resumo usa IDs para agrupar ambientes, escapa nomes e distingue programação vazia de indisponível', () => {
  const resumo = panel.slice(panel.indexOf('function renderOverview('), panel.indexOf('async function renderDash('));
  assert.match(resumo, /screens\.filter\(s=>s\.group_id===g\.id\)/);
  assert.match(resumo, /prog\.find\(t=>telas\.some\(s=>s\.id===t\.screen_id\)\)/);
  assert.match(resumo, /programacao\.no_ar\.map/);
  assert.match(resumo, /esc\(g\.name\)/);
  assert.match(resumo, /esc\(i\.title\)/);
  assert.match(resumo, /Nenhum ambiente cadastrado ainda/);
  assert.match(resumo, /Nenhuma tela neste ambiente/);
  assert.match(resumo, /Nenhum conteúdo no ar agora/);
  assert.match(resumo, /Programação indisponível/);
  assert.doesNotMatch(resumo, /\.ocultos/);
});

test('o resumo atualiza mesmo sem telas e descarta a programação anterior quando a consulta falha', () => {
  const dashboard = panel.slice(panel.indexOf('async function renderDash('), panel.indexOf('async function renderProgramacao('));
  assert.ok(dashboard.indexOf('renderProgramacao();') < dashboard.indexOf('if(!screens.length)'));
  const programacao = panel.slice(panel.indexOf('async function renderProgramacao('), panel.indexOf("fillDays('ed-days');"));
  assert.match(programacao, /if\(!Array\.isArray\(prog\)\)throw new Error/);
  assert.match(programacao, /catch\(e\)\{ renderOverview\(null\);/);
  assert.match(programacao, /renderOverview\(prog\)/);
});

test('o painel e o login acomodam iPhone em retrato e paisagem sem limitar o zoom', () => {
  for (const html of [panel, login]) {
    assert.match(html, /name="viewport" content="width=device-width,[^"]*viewport-fit=cover"/);
    assert.match(html, /@media\(max-width:767px\), \(max-width:1023px\) and \(hover:none\) and \(pointer:coarse\)/);
    assert.match(html, /-webkit-text-size-adjust:100%;text-size-adjust:100%/);
    assert.match(html, /env\(safe-area-inset-left\)/);
    assert.match(html, /env\(safe-area-inset-right\)/);
    assert.match(html, /env\(safe-area-inset-bottom\)/);
    assert.match(html, /min-height:100dvh/);
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1(?:[,"\s]|$)/);
  }
});

test('o celular usa tipografia legível e campos de 16px inclusive no login', () => {
  const mobile = panel.slice(panel.indexOf('@media(max-width:767px)'), panel.indexOf('</style>'));
  assert.match(mobile, /\.card-title\{font-size:17px/);
  assert.match(mobile, /\.card-sub,\.item-meta\{font-size:14px/);
  assert.match(mobile, /\.item-name\{[^}]*font-size:16px/);
  assert.match(mobile, /select,textarea\{[^}]*font-size:16px/);
  assert.match(login, /input,button\{min-height:50px;font-size:16px;font-family:inherit\}/);
});

test('cadastros e detalhes recolhem no celular sem sumir do desktop nem perder o estado na atualização', () => {
  assert.match(panel, /\.mobile-fold>summary\{display:none\}/);
  assert.match(panel, /querySelectorAll\('\.mobile-fold'\)\.forEach\(el=>el\.open=!mobileLayout\.matches\)/);
  for (const label of ['Adicionar conteúdo', 'Criar ambiente', 'Adicionar tela', 'Detalhes por tela']) {
    assert.ok(panel.includes('<summary>'+label+'</summary>'));
  }
  // As opções de cada tela ficam no menu "⋯", que não fecha no redesenho de 30 s.
  assert.ok(panel.includes("const aberto=menusAbertos.has(s.id);"));
  assert.ok(panel.includes("if(abrir)menusAbertos.add(id);else menusAbertos.delete(id);"));
});

test('links no celular conservam o IP ou domínio e a porta que já abriram o painel', () => {
  const origin = panel.slice(panel.indexOf('function publicOrigin(){'), panel.indexOf('function previewSlug('));
  assert.match(origin, /if\(mobileLayout\.matches\)return location\.origin/);
  assert.ok(origin.indexOf('return location.origin') < origin.indexOf('if(enderecoPublicoConfig)'));
  assert.match(origin, /if\(enderecoPublicoConfig\)return enderecoPublicoConfig/);
});

test('o volume salva o toque no WebKit mesmo sem change e agrupa eventos repetidos', () => {
  const range = panel.match(/<input class="editor-only volume-range"[^>]*>/)[0];
  assert.match(range, /oninput="[^"]*queueVolume\('\$\{s\.id\}',this\.value\)/);
  assert.match(range, /onchange="queueVolume\('\$\{s\.id\}',this\.value\)"/);
  assert.match(panel, /const volumeTimers=new Map\(\)/);
  assert.match(panel, /clearTimeout\(volumeTimers\.get\(id\)\)/);
  assert.match(panel, /volumeTimers\.delete\(id\)/);
  assert.match(panel, /saveVolume\(id,value\)\.catch/);
  assert.match(panel, /if\(volume===s\.volume\)return/);
});

test('o painel renomeia a tela sem trocar o endereço nem o volume', () => {
  assert.match(panel, /onclick="renameScreen\('\$\{s\.id\}'\)"[^>]*>Renomear<\/button>/);
  const fn = panel.slice(panel.indexOf('async function renameScreen('), panel.indexOf('async function delScreen('));
  assert.match(fn, /api\('PUT','\/api\/screens\/'\+id,\{name:limpo,group_id:s\.group_id\}\)/);
  assert.doesNotMatch(fn, /volume/);
});
