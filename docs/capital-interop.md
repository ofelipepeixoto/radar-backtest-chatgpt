# Interoperabilidade Capital Web3 — proposta v1

Esta proposta prepara a entrega de evidência histórica para revisão humana no
Capital Web3. Não instala um adapter, não envia dados ao portal e não altera
NAV, posições, diagnósticos, permissões ou aprovações. O backend continua
determinístico; não há chamada paga a LLM nesta proposta.

## Contrato consumidor conferido

Leitura por GitHub em 18/10/2026: o `README.md` de `main` descrevia a versão local
inicial; havia 14 PRs abertas, com evolução posterior nas branches. A
[PR #17](https://github.com/ofelipepeixoto/capital-web3-advisor/pull/17), sem merge,
apontava para `8368ebf9254875f6166a3b0d46354ae495cbfe54`. A especificação efetivamente
conferida para o rascunho é
[contracts/report.schema.json nesse SHA](https://github.com/ofelipepeixoto/capital-web3-advisor/blob/8368ebf9254875f6166a3b0d46354ae495cbfe54/contracts/report.schema.json),
blob `c3fffb9a12ef8566ca2090d742a25ef493fe3ba5`, versão `0.1.0`.
Também foram lidos `docs/integrations.md` e `capital_web3/adapters.py` nesse SHA.
As afirmações de homologação/implantação feitas nas PRs não foram retestadas por
este projeto. Nenhum arquivo do repositório Capital foi modificado.

O plugin Capital Web3 distingue suas instruções e contratos propostos de um
backend instalado. Seu catálogo de dez ferramentas não inclui importação de
backtest. Os contratos do plugin e o schema de rascunho do repositório têm
formatos diferentes; não são intercambiáveis pelo mesmo número de versão.

## Proposta de fluxo e fronteiras

1. O proprietário importa o JSON pelo canal administrativo deste projeto. A
   identidade vem da sessão verificada; o modelo não fornece proprietário.
2. O leitor produz uma análise reduzida vinculada a `reportId`, `strategyId`,
   digest dos bytes, versão do parser e contexto com procedência por campo.
3. Um adapter futuro autorizado resolve essas referências no servidor, preserva
   as unidades e prepara um rascunho no contrato Capital `0.1.0`. Inconsistência
   ou contexto decisivo ausente produz `degraded`/`needs_input`, sem ranking.
4. Consultor e revisor conferem a evidência. Aprovação, associação ao caso,
   publicação e destinatários pertencem ao backend Capital, por versão/hash e
   identidade autenticada. Um campo recebido no payload não concede autoridade.

Não existe chamada automática entre os projetos. Conectar os backends exige
uma proposta separada no Capital, com contrato de autorização, consentimento,
retenção, custo, idempotência e testes de acesso cruzado. Um `reportId` deste
catálogo não é um `case_id`, wallet ou posição do Capital. Um hash igual não
transfere acesso entre proprietários ou projetos.

## Mapeamento mínimo sem modificar schemas

| Origem deste leitor | Destino proposto no rascunho Capital | Regra |
| --- | --- | --- |
| Digest SHA-256 e período histórico | `sources[].id`, `sources[].as_of` | `sha256:<digest>`; tempo histórico declarado, não importação |
| Origem fictícia ou documento do operador | `sources[].kind` | `synthetic` nas fixtures; `document` em importação real autorizada |
| Métricas declaradas e recalculadas | `findings[].evidence` | Texto descritivo dos valores determinísticos, com unidade, fração e versão |
| Divergências | `findings[]`, `status` e `limitations[]` | Não selecionar silenciosamente um número conflitante |
| Contexto e lacunas de comprovação | `data_quality`, `limitations[]` | Declaração não equivale a verificação independente |
| Revisão necessária | `human_review` | `required=true`, `reviewer=null`, `approved=false` no rascunho |

O schema de rascunho conferido **não tem campos monetários numéricos** e fecha
objetos com `additionalProperties: false`. Não adicionar `netProfit`, `NAV` ou
`approved=true` para acomodar o backtest. O exemplo
[capital-advisory-draft.json](../examples/capital-advisory-draft.json) segue esse
formato e continua aguardando revisão. Seus números e digest foram conferidos
com o leitor local; não é uma chamada ao Capital nem evidência de aprovação.

As métricas deste leitor são `number` e usam cálculo descritivo de ponto
flutuante, sem precisão contábil prometida. `profit_total=0.015` é fração de
retorno e corresponde a 1,5%; valores absolutos continuam na moeda stake, sem
câmbio. Por exemplo, as unidades BTC da fixture BTC não foram obtidas convertendo
USDT.

Os contratos de cálculo do plugin Capital que usam `Decimal`, `Money.amount` ou
choques como strings decimais continuam exigindo essas strings. Esta proposta
não envia valores do backtest para esses campos. Um futuro adapter financeiro
deve definir escala, arredondamento, limite e perda de precisão; não basta usar
`String(number)` e declarar equivalência exata. Não preencher valores ausentes
com zero nem produzir infinito para fator de lucro sem perdas.

## Exemplos reproduzíveis e sem dados reais

Todos os JSONs `freqtrade-*` são fixtures autorais do perfil reduzido suportado,
com estrutura principal `strategy`. Não foram produzidos executando Freqtrade;
não são um export completo de todos os campos possíveis do produtor. Os quatro
trades de A/B estão dentro do período histórico declarado. A linha `force_exit`
já está em `trades` e aparece também no subconjunto `left_open_trades` para
conferir que não há soma duplicada.

| Arquivo | Verificação pretendida |
| --- | --- |
| `examples/freqtrade-a.json` | 4 trades; lucro 15 USDT; retorno 0.015; fator 2.5 |
| `examples/freqtrade-b.json` | 4 trades; lucro 25 USDT; retorno 0.025; fator 6 |
| `examples/freqtrade-btc.json` | Valores em BTC, saldo inicial de 1 BTC, universo ETH/BTC; comparação direta recusada |
| `examples/freqtrade-no-losses.json` | Fator `null`, estado `NO_LOSSES_UNDEFINED` |
| `examples/freqtrade-mismatch.json` | Resumo declara 999 USDT/0.999; trades somam 15 USDT/0.015; divergência exposta |
| `examples/operator-context.json` | Declarações fictícias por `strategy-1`: dataset, taxas, slippage e versões |
| `examples/operator-context-incomplete.json` | Contexto vazio: lacunas permanecem desconhecidas |
| `examples/operator-context-conflict.json` | Declara EUR em conflito com export USDT; importação rejeitada |
| `examples/capital-advisory-draft.json` | Rascunho fictício conforme o formato Capital conferido, com revisão pendente |

`datasetSha256` repetido como `aaaa…` e as versões `synthetic-*` são declarações
de teste; não apontam para um dataset existente nem comprovam reprodutibilidade
do produtor. O contexto administrativo é um objeto por ID local de estratégia,
usado somente na ingestão. Não é um argumento aceito nas tools MCP. Em A e B,
os campos decisivos do contexto são iguais para testar a comparação. O catálogo
atribui `reportId` diferentes, embora ambas tenham `strategy-1`.

O digest de A é
`acf4219f00a63c64feee749ec42b4bb32c9f92a3ef1813a28c3ae69eae38e3d9`.
Modificar os bytes, inclusive a formatação, muda o digest. Não é prova de
autoria, veracidade, identidade ou ausência de manipulação.

## Aceite da integração futura

Antes de usar dados reais, testar no Capital: autorização independente nos dois
serviços; referência inexistente/inacessível indistinguível; digest/versão
obsoletos; replay e duplicação; contexto ausente ou divergente; moeda diferente;
proibição de autoridade em campos de texto; rejeição de propriedades extras;
revisão e publicação pelo backend. A validação de um JSON de exemplo não
comprova qualquer uma dessas garantias de integração.

Freqtrade continua sendo o produtor externo deste perfil. Jesse possui outro
perfil; Equity/Nautilus são laboratórios de simulação; Kronos é pesquisa
temporal; CCXT é uma possível fonte pública limitada. Nenhum desses motores ou
projetos foi conectado, alterado ou homologado por esta proposta.
