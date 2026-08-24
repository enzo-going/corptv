# Segurança

## Versões mantidas

A análise e as correções de segurança se concentram no código atual da branch
`main` e na versão mais recente publicada. Versões anteriores podem receber
correções somente quando o mantenedor considerar o backport seguro e viável.

## Como relatar uma vulnerabilidade

Use o canal privado **Report a vulnerability** em
[GitHub Security Advisories](https://github.com/enzo-going/corptv/security/advisories/new).
Não abra uma issue pública antes de a correção estar disponível.

Inclua no relato, quando possível:

- versão ou commit afetado;
- impacto e cenário de exploração;
- passos mínimos para reproduzir;
- sugestão de correção ou mitigação;
- ambiente de teste, sem dados reais da organização.

O mantenedor responderá e acompanhará o caso pelo advisory privado. A gravidade,
a correção e a divulgação coordenada serão registradas no mesmo canal.

Não envie senhas, cookies, tokens, bancos `*.db`, uploads, exportações de
auditoria, endereços internos ou qualquer dado pessoal. Se um exemplo precisar
de credenciais, use valores descartáveis criados somente para o teste.

## Premissas de implantação

O CorporTV possui autenticação local, perfis de administrador, editor e somente
leitura, proteção CSRF, limitação de requisições e auditoria de eventos. O
player, o heartbeat e a rota de saúde permanecem públicos por design para que
as TV Boxes funcionem sem armazenar credenciais.

A primeira conta administrativa só pode ser criada pela rede privada. Fora do
próprio servidor, o cadastro exige o código único armazenado no diretório de
logs; o código é removido e a configuração inicial é bloqueada após o uso.

A instalação padrão usa HTTP e, por isso, não marca o cookie como `Secure`.
Mantenha-a em uma rede interna controlada. Para atravessar uma rede não
confiável, use HTTPS em toda a conexão por meio de um proxy reverso. Defina
`CORPTV_TRUST_PROXY=1` somente quando o proxy for confiável e o servidor não
estiver acessível diretamente pelos clientes.
