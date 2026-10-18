# Contratos do catálogo v2

Os schemas executáveis e estritos estão em `src/catalog-server.ts`,
`src/catalog.ts`, `src/report.ts`, `src/context.ts` e `src/comparison.ts`.
Entrada e saída são validadas no servidor, além de anunciadas no MCP.
`schemaVersion:2` identifica o envelope do catálogo; contexto tem versão 1;
comparação tem `comparisonVersion:declared-context-v1`.

| Tool readonly | Entrada | Saída |
| --- | --- | --- |
| `backtest_v2_list_reports` | `{limit?:1..50,cursor?:string}` | `reports[]`, `nextCursor:string|null` |
| `backtest_v2_analyze_report` | `{reportId, strategyId}` | Referência, importação, digest, parser, `analysis` |
| `backtest_v2_compare_reports` | `{left:{reportId,strategyId},right:{reportId,strategyId}}` | Duas análises e `comparison` |

UUIDs não são credenciais. `strategy-1` só identifica uma estratégia dentro de
um relatório. Cursores têm integridade HMAC vinculada ao proprietário, não são
usados como autorização e podem ficar obsoletos se o catálogo mudar. A ordenação
é lexicográfica por UUID; não é ordem de desempenho ou cronologia. Sem snapshot
de paginação, imports concorrentes podem exigir reiniciar a listagem.

MCP recusa campos extras, `userId`, `tenantId`, `approved`, paths, URLs,
credenciais e código. Erros de domínio são `isError:true` com
`{schemaVersion:2,error:{code:"REQUEST_REJECTED",retryable:false}}`; relatório
inexistente e alheio têm a mesma resposta. Uma falha não equivale a análise.

Comparação usa `COMPARABLE`, `WITH_CAVEATS` e `NOT_COMPARABLE`. No último estado
`directDeltas:null`; lado a lado conserva cada unidade. `rankingAllowed:false`
sempre. Igualdade de contexto declarado não comprova ausência de vieses ou
comparabilidade causal. Os deltas são RIGHT_MINUS_LEFT e continuam históricos.

Métricas têm números finitos de ponto flutuante. Fração 0.015 = 1,5%; valores
absolutos continuam na moeda stake. Contagens seguem profit_ratio, e force_exit
não é duplicado por left_open_trades. Fator sem denominador de perdas é null.
Drawdowns declarados conservam suas definições; Sharpe/CAGR/curva mark-to-market
não são recalculados. Digest identifica bytes, sem provar sua veracidade.

## Administração separada

Contrato preparado para a camada remota dependente; não são tools MCP. O perfil
remoto exige JWT do proprietário e scope por rota.

| Rota | Scope | Contrato |
| --- | --- | --- |
| POST `/admin/reports` | `backtest:import` | `{schemaVersion:2,reportBase64,contexts:{...}}`; 201 novo/200 repetido |
| DELETE `/admin/reports/{reportId}` | `backtest:admin` | Sem corpo; `{schemaVersion:2,reportId,state:"REMOVED"}` |

Base64 transporta os bytes exatos do JSON principal e não muda seu digest.
Corpo administrativo máximo 3 MiB; JSON decodificado máximo 2 MiB, profundidade
64, 32 estratégias, 10.000 trades totais. UTF-8 inválido, duplicatas de chaves,
não finitos, strings financeiras, contextos conflitantes e extras são rejeitados.
O envelope `contexts` é obrigatório, podendo ser `{}`. Nenhuma URL ou path é
aceito pelo serviço para buscar arquivos. ZIP é selecionado fora do runtime.

`demo` indica a fixture embutida do perfil local; `false` em importações não
certifica que os dados sejam reais. Os exemplos deste repositório são fictícios.
Contexto é fixado na importação, com campos permitidos por estratégia. Taxas,
slippage, dataset e versões sem evidência externa não são comprovados.
