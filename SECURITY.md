# Segurança

Relate vulnerabilidades de forma privada pelo recurso **Report a vulnerability** da aba Security do GitHub. Não publique credenciais, endereços internos, bancos, uploads ou logs em uma issue.

O CorporTV possui autenticação local, três perfis de acesso, proteção CSRF,
limitação de tentativas e auditoria de eventos. O player permanece público por
design para funcionar em TV Boxes sem credenciais.

A primeira conta administrativa só pode ser criada pela rede privada. Fora do
próprio servidor, o cadastro exige o código único armazenado no diretório de
logs; esse código é removido e a configuração inicial é bloqueada após o uso.

A instalação padrão usa HTTP e, por isso, não consegue marcar o cookie como
`Secure`. Mantenha-a em uma rede interna controlada. Antes de expor o sistema à
internet ou atravessar uma rede não confiável, use HTTPS em toda a conexão por
meio de um proxy reverso e revise os controles de borda. Defina
`CORPTV_TRUST_PROXY=1` apenas quando esse proxy for confiável e o servidor não
estiver acessível diretamente pelos clientes.

Senhas, cookies, tokens, bancos `*.db`, uploads, exportações de auditoria e
endereços internos nunca devem ser anexados a issues ou commits.

As versões mantidas recebem correções na branch `main`.
