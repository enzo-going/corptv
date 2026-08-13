# CorporTV

Sistema leve de TV corporativa com painel de gestão, playlists por grupo e player em tela cheia para TV Box, Smart TV ou navegador em modo quiosque.

## Funcionalidades

- Slides de texto, imagem e vídeo
- Grupos com playlists independentes
- URLs permanentes por tela
- Agendamento por período, dias da semana e faixa de horário
- Faixas que atravessam a meia-noite
- Atualização automática do player sem recarregar a página
- Cache offline com expiração segura para conteúdo agendado
- Heartbeat e visão geral das telas
- Upload com suporte a HTTP Range e cache de mídia

## Requisitos

- Node.js 18 ou mais recente
- npm

## Instalação

```bash
git clone https://github.com/enzo-going/corptv.git
cd corptv
npm ci
npm start
```

O serviço usa a porta `3000` por padrão. Para escolher outra:

```powershell
$env:PORT=3100
npm start
```

Abra:

- Painel: `http://IP_DO_SERVIDOR:3000/painel`
- Player: `http://IP_DO_SERVIDOR:3000/player/ID_DA_TELA`
- Saúde: `http://IP_DO_SERVIDOR:3000/health`

## Fluxo de configuração

1. Crie os slides.
2. Crie um ou mais grupos.
3. Monte a playlist de cada grupo.
4. Cadastre as telas e associe cada uma a um grupo.
5. Abra a URL da tela na TV Box ou Smart TV em modo quiosque.

## Agendamento

Todos os campos são opcionais. Um slide sem regra toca sempre.

| Campo | Comportamento |
|---|---|
| `starts_at` | Exibe somente depois da data e hora inicial |
| `expires_at` | Oculta depois da data e hora final |
| `days` | Dias da semana, de `0` (domingo) a `6` (sábado) |
| `time_start` / `time_end` | Janela diária no formato `HH:MM` |

Quando a janela atravessa a meia-noite, como `22:00–06:00`, o dia selecionado é o dia em que a janela começa. Portanto, “segunda-feira, 22:00–06:00” continua válida até 06:00 de terça-feira.

O servidor é a fonte da programação. O player consulta alterações periodicamente e substitui, adiciona ou remove conteúdo sem precisar ser reiniciado. Durante uma queda de rede, conteúdo sem prazo continua disponível no cache; conteúdo agendado só permanece até seu limite calculado pelo servidor.

## Estrutura

```text
corptv/
├── public/
│   ├── painel/index.html
│   ├── player/index.html
│   └── uploads/            # criado em execução e ignorado pelo Git
├── src/
│   ├── db.js
│   ├── scheduling.js
│   └── server.js
├── test/
│   └── scheduling.test.js
├── data/                   # criado em execução e ignorado pelo Git
├── package.json
└── package-lock.json
```

## Testes e auditoria

```bash
npm test
npm audit --omit=dev
```

Os testes cobrem datas, expiração, horários inválidos, dias repetidos, janela que atravessa a meia-noite e validade do cache offline.

## API principal

| Método | Rota | Finalidade |
|---|---|---|
| `GET` | `/api/slides` | Lista slides e seus estados de programação |
| `POST` | `/api/slides` | Cria texto ou envia imagem/vídeo |
| `PUT` | `/api/slides/:id` | Atualiza conteúdo e agendamento |
| `GET` | `/api/groups` | Lista grupos |
| `GET` | `/api/groups/:id/slides` | Obtém a playlist de um grupo |
| `GET` | `/api/screens` | Lista telas |
| `GET` | `/api/player/:id` | Entrega a playlist ativa para uma tela |
| `GET` | `/api/programacao` | Resume itens programados e ocultos |
| `POST` | `/api/heartbeat` | Atualiza a presença de uma tela |
| `GET` | `/health` | Informa saúde e tempo de atividade |

## Dados e segurança

O repositório não inclui bancos, uploads, logs nem arquivos de ambiente. Esses diretórios devem ser preservados separadamente em atualizações.

O projeto não possui autenticação integrada. Use apenas em uma rede confiável ou coloque um proxy autenticado na frente do painel e das rotas administrativas antes de expor o serviço à internet.

Formatos de upload aceitos: JPG, PNG, WEBP e MP4, com limite padrão de 200 MB.
