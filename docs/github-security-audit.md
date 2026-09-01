# Auditoria de segurança do GitHub

Este documento registra a linha de base verificada em 24 de agosto de 2026 e
define uma rotina curta para repetir a auditoria sem depender da interface web.

## Verificação de 28 de agosto de 2026

A revisão desta data confirmou a situação abaixo na `main`:

| Verificação | Resultado |
|---|---|
| Code scanning | Zero alertas abertos |
| Dependabot | Zero alertas abertos |
| Secret scanning | Zero alertas abertos |
| CI pós-merge | Node.js 22, Node.js 24 e scripts Windows aprovados |
| CodeQL e Dependency Review | Aprovados |
| Repository hygiene | Actions fixados por SHA de 40 caracteres |

O único pull request aberto é uma atualização majoritária do Express mantida
separada para revisão de compatibilidade. Nenhum alerta ou exceção foi criado
durante esta verificação.

## Linha de base

| Controle | Resultado verificado |
|---|---|
| CodeQL na `main` e em pull requests | Ativo; zero alertas abertos |
| Dependency Review em pull requests | Ativo |
| Dependabot Security Updates | Ativo; zero alertas abertos |
| Secret scanning | Ativo; zero alertas abertos |
| Push protection | Ativa |
| Reporte privado de vulnerabilidades | Ativo |
| Ruleset da branch padrão | Ativo; exige PR, cinco checks, exclusão e force push bloqueados |
| Actions | Permissão padrão somente leitura; SHA pinning obrigatório |
| Padrões de segredo não-provedor | Desativados; lacuna registrada para habilitação pelo plano/UI |
| CI | Node.js 22, Node.js 24 e scripts operacionais no Windows |

O ruleset exige que alterações cheguem por pull request e impede exclusão ou
force push na branch padrão. Antes de cada merge, os checks `Node.js 22`,
`Node.js 24`, `Windows operations scripts`, `CodeQL (JavaScript)` e
`Dependency review` precisam passar. Não há aprovação obrigatória: como o
repositório possui um único mantenedor, essa decisão evita bloquear correções
urgentes e deve ser revista se a equipe crescer.

## Rotina mensal e antes de releases

1. Confirme que a autenticação do GitHub CLI pertence à conta esperada.
2. Consulte alertas abertos de CodeQL, Dependabot e secret scanning.
3. Revise execuções com falha ou canceladas na `main`.
4. Confira permissões de Actions, SHA pinning e alterações recentes no ruleset.
5. Execute `npm ci`, `npm test` e `npm audit --omit=dev` a partir de um checkout limpo.
6. Registre no pull request a data, os resultados e qualquer exceção aceita.

Comandos de leitura usados na auditoria:

```powershell
gh auth status
gh api "repos/enzo-going/corptv/code-scanning/alerts?state=open&per_page=100"
gh api "repos/enzo-going/corptv/dependabot/alerts?state=open&per_page=100"
gh api "repos/enzo-going/corptv/secret-scanning/alerts?state=open&per_page=100"
gh run list --repo enzo-going/corptv --branch main --limit 20
gh api repos/enzo-going/corptv/rulesets
gh api repos/enzo-going/corptv/actions/permissions
gh api repos/enzo-going/corptv/private-vulnerability-reporting
```

As respostas das APIs podem conter metadados internos. Não copie evidências
brutas para issues públicas sem revisar nomes, caminhos e dados do ambiente.

## Tratamento de achados

- Corrija alertas confirmados em uma branch isolada e valide-os por pull request.
- Não reduza versões nem desative controles apenas para obter um check verde.
- Dispense falso positivo somente com justificativa técnica registrada no alerta.
- Trate segredo exposto como comprometido: revogue-o antes de remover o valor do
  histórico ou do código.
- Mantenha upgrades principais de dependências separados de correções automáticas
  até que a compatibilidade esteja coberta por testes.

Vulnerabilidades não publicadas seguem o processo privado descrito em
[`SECURITY.md`](../SECURITY.md).
