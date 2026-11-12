# Auditoria de dependências — 2026-11-12

## Base e resultado

Base: PR #5, feat/authenticated-private-mcp (618fe277703d4cc2ad9bb4fb6b3d77171194d0d6). Main continua bootstrap. Esta correção é empilhada, não integra nem implanta o piloto.

Consulta atual ao npm audit confirmou versões afetadas no lockfile: MCP SDK 1.31.0, Zod 3.25.76, body-parser 2.3.0 e fast-uri 3.1.8. O resumo reportava nove nós afetados, incluindo propagação transitiva; isso não significa nove explorações nem prova exposição em produção.

Atualizados exclusivamente os quatro pacotes para SDK 1.32.0, Zod 4.6.6, body-parser 2.4.0 e fast-uri 3.1.9, com lockfile e integridades gerados pelo npm. Os demais pacotes permanecem nas mesmas versões. Zod 4 é migração de major exigida pelo intervalo corrigido informado pelo advisory; não foi usado audit fix --force.

## Fontes e aplicabilidade

- https://github.com/advisories/GHSA-46jr-4wx8-v453 — consumo de memória na validação MCP.
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 — consumo de memória em coleções Zod.
- https://github.com/advisories/GHSA-22jm-h49p-29qw — isolamento de tarefas experimentais MCP.
- https://github.com/advisories/GHSA-rvq5-wwqv-78pq — audience no middleware de autenticação SDK.
- https://github.com/advisories/GHSA-6prh-2h8m-c8cw — redirects do cliente SDK.
- https://github.com/advisories/GHSA-27r3-jxmh-p828 — body-parser e corpos comprimidos.
- https://github.com/advisories/GHSA-w74x-v6f9-j3xg
- https://github.com/advisories/GHSA-xhq7-xmqj-769h
- https://github.com/advisories/GHSA-wjr9-j795-jxcr
- https://github.com/advisories/GHSA-333x-w4r6-6crp — normalização URI.

Fontes consultadas pela API npm audit em 12/11/2026. Presença das versões vulneráveis confirmada; exploração específica não demonstrada. O projeto já limita corpos e usa rotas próprias. Não se inferiu uso de tarefas experimentais, Express ou middleware bearer do SDK só pela árvore de dependências. Os testes são sintéticos e locais.

## Verificação executada

Linux, Node v24.22.1, npm 11.9.0: instalação com --ignore-scripts, npm run typecheck e npm test aprovados (91 testes, sem skips). Inclui protocolo SDK real em stdio/HTTP local e negativas dos limites. npm audit --json após a alteração retornou zero advisories conhecidos na árvore resolvida. git diff --check aprovado. Zero advisories não é certificação de segurança nem prova de exploração anterior.

CI remota deve ser conferida no head da PR. OAuth/ChatGPT na conta, TLS, Docker e produção não foram homologados nesta auditoria. Não foram alterados credenciais, permissões, configuração de autenticação, banco, workflow de CI ou infraestrutura.

## Reversão e pendências

Revisar a migração Zod, a PR base e os contratos antes do merge. Fechar esta PR descarta a correção proposta; se integrada posteriormente, reverter o commit restaura as versões anteriores vulneráveis. Nenhum deploy a reverter. Consumidores que fixam SHAs anteriores não recebem a correção automaticamente.

A função genérica field passa a usar z.ZodType<T> e z.nullable(schema), preservando a inferência de value em Zod 4 sem casts e mantendo o refinamento UNKNOWN/null. Os 91 testes incluem contexto, JWT, catálogo privado, concorrência e limites remotos.
