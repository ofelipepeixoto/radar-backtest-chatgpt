# Checkpoint — 2026-10-18

Base remota conferida: PR #1 aberta em rascunho, head
8482e8a4bbe1bfa9ba9886e1206478e8489f0cc6, main apenas bootstrap
a00a0c9d8618edc0bde69ee521beebe56c42ebb9. Baseline repetida: typecheck/build e
32 testes aprovados. CI da PR #1 conferida no mesmo SHA: success. Branches
main/feat sem proteção e rulesets vazios observados; nenhuma proteção alterada.

Camada de dados: parser estrito, projeção contextual, comparação determinística,
catálogo privado persistente e contrato MCP v2. Dependência explícita da PR #1;
revisão humana antes de merge. Fixtures autorais, sem JSON real ou código
Freqtrade incorporado. Pinned upstream estudado 23eeadc8 é 2026.10-dev; latest
release consultada 2026.9 não amplia automaticamente a compatibilidade.

Revisão independente reproduziu e corrigiu finitude em campos ignorados,
contradição período/universo de trades e vínculo issuer/identidade. Namespace
privado impede troca silenciosa de issuer; restauração exige copiar todo estado.

Camada remota implementada em branch dependente: autenticação de recurso por JWT,
canal administrativo separado, limites, CLI, operação e config de deploy.
Provedor OAuth, domínio, destino/acesso real e consentimento continuam pendentes.
Não há endpoint público, conta ChatGPT conectada, homologação externa ou produção.
Não existem chamadas pagas, custo novo contratado ou automação agendada.

Contexto/comparação publicados na PR #2, SHA
4c927243fe3586b1ca33650de2533c1d3949f325, base PR #1. Typecheck/build e 48 testes
em cópia isolada desta camada aprovados. A camada de catálogo adiciona 13 testes
de persistência/protocolo, total 61; seu transporte ainda depende da próxima PR.

Catálogo publicado na PR #3, SHA 6d85b0972edce5fd3013cfb864276fddb3f6ac5f,
base PR #2. CI das PRs #2/#3 conferida nos respectivos SHAs: success.
Autorização JWT isolada na PR #4, base #3; 74 testes da base+JWT aprovados em
cópia isolada. A transferência inicial do lockfile foi corrigida antes da
entrega; árvore publicada conferida contra a árvore local completa.
Camada final em `feat/authenticated-private-mcp`, dependente de #4; conferir SHA
e CI no head dessa PR antes de revisar/implantar. Ordem humana: #1 → #2 → #3 →
#4 → camada remota. Nenhuma branch foi forçada e nenhum merge foi feito.

Validação local final: Node 24.19.0, typecheck/build aprovados e 91 testes
distintos aprovados: 32 originais, 16 contexto/comparação, 11 catálogo, 2 MCP v2,
13 JWT, 15 transporte remoto, 2 configuração/CLI. npm audit: zero alertas na
varredura observada; scan limitado de padrões de segredo sem ocorrências.
YAML Compose passou em parse estrutural; Docker indisponível, imagem não
construída. Sem conversas reais com modelo ou nova execução do Freqtrade.
Smoke adicional do executável remoto: iniciar, health200, MCP sem token401 com
discovery challenge, SIGTERM e reiniciar no mesmo diretório, duas rodadas sem erro.

Revisão independente também corrigiu contratos da CLI, limites de subject e
conexões incompletas/ociosas. Risco residual: host/provider/proxy/conta e restore
da VPS não foram exercitados; quotas são locais ao processo, sem alta disponibilidade.
Rollback documentado no runbook; JSONs originais não são recuperados do catálogo.

Próxima ação: confirmar destino/domínio/provedor/acesso protegido; implantar isolado,
observar login/consentimento do dono e executar roteiro docs/chatgpt.md. Não
declarar completo antes dessas chamadas reais. Não modificar outros repositórios.
