# Radar Backtest · ChatGPT

Leitor independente de resultados históricos Freqtrade: importação administrativa,
catálogo privado, métricas determinísticas e comparação por contexto. ChatGPT
interpreta a evidência retornada pelas consultas MCP. O backend é determinístico,
sem LLM, execução de estratégias, conexão a exchanges, custódia ou ordens.

Status: piloto em PRs dependentes para revisão humana. Código e protocolo
verificados localmente; provedor OAuth, HTTPS público, consentimento e conexão
na conta ChatGPT ainda não homologados. Não é produção nem integração Capital
instalada. Nenhum merge automático ou recurso pago foi solicitado.

## Perfis e início local

Requer Node.js 22+ em Linux/POSIX. `npm ci --ignore-scripts`, `npm run typecheck`
e `npm test` instalam/validam o projeto. Lockfile fixa dependências.

| Perfil | Como iniciar | Fronteira |
| --- | --- | --- |
| Local v1 stdio | `npm run start:stdio -- --demo` | Fixture explícita ou `--report <arquivo>` escolhido pelo operador |
| Local v1 HTTP | `npm run start:http -- --demo` | Somente `http://127.0.0.1:8788/mcp`, Host/Origin locais; não expor |
| Privado v2 remoto | `BACKTEST_CONFIG=<configuração-protegida> npm run start:remote` | JWT por requisição, um dono, catálogo próprio; HTTPS via proxy isolado |

O perfil remoto usa configuração do operador com issuer/JWKS/resource HTTPS,
subject autorizado e pasta privada. Não transforma o listener v1 em serviço
remoto. O exemplo de configuração contém placeholders `.invalid`; não é um
endpoint implantado. Preparação, transferência, parada e recuperação no
[runbook](docs/runbook.md).

## Importar e consultar

A CLI administrativa transfere bytes exatos via HTTPS com token de sessão em
arquivo protegido; não é ferramenta do modelo. Um anexo do Work precisa ser
transferido explicitamente para o serviço. Só entra o JSON principal contendo
`strategy`: selecionar fora deste runtime o JSON do ZIP Freqtrade. ZIP, scripts,
estratégias Python, pickle/joblib, URLs e paths de modelo não são aceitos.

O catálogo persiste apenas projeções/contextos reduzidos, com UUID, digest,
versão e importação UTC, em arquivos privados 0600/diretório 0700. Um proprietário
é identificado pelo backend; o namespace da pasta fica vinculado ao issuer.
Imports repetidos são idempotentes; interrupções não publicam dados parciais.
Originais, nomes, pares, notas e configs não são guardados nem retornados.
Hashes e agregados continuam privados, sem promessa de anonimato.

| Tool | Entrada |
| --- | --- |
| `backtest_v2_list_reports` | `{limit?,cursor?}` |
| `backtest_v2_analyze_report` | `{reportId,strategyId}` |
| `backtest_v2_compare_reports` | `{left:{reportId,strategyId},right:{reportId,strategyId}}` |

`strategy-1` pertence a um relatório específico. Campos de identidade, aprovação,
código, path e URL são rejeitados. Só o token verificado determina acesso. Os
nomes v1 `backtest_list_reports`/`backtest_analyze_report` continuam no perfil
local e mantêm seus schemas. [Contratos v2](docs/contracts-v2.md).

## Evidência e comparação

`profit_total=0.015` significa 1,5%, sem média de retornos individuais ou câmbio.
Contagens seguem o sinal de profit_ratio; force_exit já está em trades e não
é somado outra vez em left_open_trades. Sem perdas, fator de lucro é null com
estado explícito. Os dois drawdowns declarados não são intercambiáveis nem
recalculados. Não há recálculo de Sharpe/CAGR/mark-to-market.

Contexto separa período histórico em milissegundos, execução em segundos e
importação ISO UTC. Cada campo declara EXPORT/OPERATOR/UNKNOWN. Período,
moeda, saldo, timeframe, universo/dataset, taxas/slippage e alavancagem/modo
precisam permitir comparação. Lacuna ou diferença decisiva produz
`NOT_COMPARABLE` e deltas null; diferenças de versão/resumo geram ressalvas.
Ranking de investimento permanece desabilitado. Igualdade de declarações não
comprova dados, custos, ausência de viés ou causalidade.

SHA-256 identifica bytes; não prova autoria, veracidade ou qualidade do backtest.
Limites: 2 MiB/64 níveis/32 estratégias/10.000 trades; validação UTF-8, duplicatas,
finitude, tipos e faixas, sem coerção financeira. Sem dados, usar null/ausente.
Tolerância relativa 1e-8 e aritmética descritiva de ponto flutuante permanecem.

## Exemplos, validação e ChatGPT

`examples/` contém apenas fixtures autorais fictícias: lucro 15/25 USDT, moeda BTC,
sem perdas e resumo inconsistente, mais contextos completos/ausentes/conflitantes.
Esses arquivos não foram produzidos rodando Freqtrade e não demonstram retorno
econômico. A suíte cobre parser, catálogo/restart/restore, comparação, JWT,
scopes, acesso cruzado, SDK real stdio/HTTP e limites. Teste SDK não é conversa
homologada na conta. [Roteiro ChatGPT](docs/chatgpt.md).

Compatibilidade estudada: Freqtrade `23eeadc864352d3c1af8b6cf80bdf30ff17849a3`
(`2026.10-dev`), sem ampliar suporte para toda release 2026.9 estável. SDK MCP
1.31.0 com protocolo testado 2025-11-25; não reivindica suporte à especificação
mais recente 2026-07-28. [Decisão de arquitetura](docs/adr/0002-private-catalog.md).

Capital Web3 tem [proposta de interoperabilidade](docs/capital-interop.md) com
rascunho fictício e revisão humana. Não altera NAV/posições ou outros repositórios.
n8n, Supabase, RAG e APIs pagas não são dependências deste piloto.

## Licenças

Leitor original: MIT, copyright Carlos Felipe Peixoto. Sem código, estratégia,
modelo ou dataset GPLv3 Freqtrade incorporado. Estudo independente do formato,
sem afiliação oficial ou certificação clean-room. Freqtrade conserva seus autores
e GPLv3; dependências mantêm licenças próprias. [Terceiros](THIRD_PARTY.md),
[segurança](SECURITY.md) e [ADR original](docs/adr/0001-offline-report-boundary.md).
