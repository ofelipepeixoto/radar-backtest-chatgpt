# Radar Backtest · ChatGPT

Laboratório autoral para consultar resultados históricos do Freqtrade por MCP. O operador seleciona um arquivo local uma vez; ChatGPT pode listar estratégias anônimas e examinar métricas determinísticas. Este projeto não executa Freqtrade, estratégias Python, previsões, ordens ou chamadas a exchanges.

Status: implementação experimental para revisão em PR. Testes locais do protocolo não significam que o plugin está conectado à sua conta ChatGPT.

## Iniciar

Requer Node.js 22 ou superior e npm. A instalação usa versões fixadas no lockfile.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run start:stdio -- --demo
```

Para testar Streamable HTTP local:

```bash
npm run start:http -- --demo
```

Endpoint: `http://127.0.0.1:8788/mcp`. A variável `PORT` aceita inteiros de 1024 a 65535. O serviço não tem autenticação e aceita somente Host e Origin locais exatos; não publique essa porta nem a coloque atrás de um proxy remoto. A seleção `--demo` é explícita e sempre identificada como fictícia nas respostas.

Para um relatório próprio, substitua `--demo` por `--report /caminho/local/resultado.json`. Não envie chaves ou configurações de exchange ao serviço. Não há arquivo `.env`, API paga, persistência ou banco necessário.

## Formato aceito

Freqtrade atual salva um ZIP. Selecione previamente, com uma ferramenta local confiável, **somente o JSON principal do resultado**, contendo `strategy`, e coloque-o em um arquivo regular. `_config.json`, `.meta.json`, arquivos Python, pickle, joblib, ZIP e Feather não são entradas aceitas. Este laboratório não descompacta nem executa o pacote.

Contrato de compatibilidade estudado: [Freqtrade `23eeadc864352d3c1af8b6cf80bdf30ff17849a3`](https://github.com/freqtrade/freqtrade/tree/23eeadc864352d3c1af8b6cf80bdf30ff17849a3). Limites: 2 MiB de JSON, até 32 estratégias e 10.000 trades no total; cada trade deve ter `is_open: false`, `close_timestamp` em milissegundos e `profit_abs` e `profit_ratio` numéricos finitos. Cada estratégia exige `starting_balance` positivo. Campos não usados são descartados. Esses limites restringem a compatibilidade; não definem todos os arquivos válidos do Freqtrade.

## Ferramentas

| Ferramenta | Entrada | Resultado |
| --- | --- | --- |
| `backtest_list_reports` | `{}` | Digest do arquivo, flag demo e IDs `strategy-1`, `strategy-2`… |
| `backtest_analyze_report` | `{"strategyId":"strategy-1"}` | Contagens, lucro absoluto, retorno descritivo, fator de lucro e divergências |

Não há parâmetros para paths, URLs, código, credenciais, aprovações ou ordens. IDs são locais ao arquivo carregado e seguem a ordem das estratégias; não são identidades duráveis. Para citar uma evidência use digest + ID. Nenhum nome, par negociado, comentário, tag ou configuração original retorna ao cliente. Valores agregados ainda podem ser confidenciais.

## Interpretar resultados

- `closedTradeReturnRatio` é soma de `profit_abs` dividida pelo saldo inicial: `0.015` significa 1,5%. Não é média do retorno por trade, retorno anualizado ou previsão.
- Trades `force_exit` já estão em `trades`; a lista `left_open_trades` não é somada novamente.
- Sem perdas, fator de lucro é `null` com status explícito; não é infinito nem um sinal de segurança. Sem trades, a taxa de acerto também é `null`.
- `reportedUnverified` separa métricas declaradas de cálculos refeitos. `max_relative_drawdown` é o maior drawdown relativo; `max_drawdown_account` corresponde ao episódio de maior perda absoluta. Não recalculamos drawdown sem a curva de patrimônio.
- Divergências em campos checados produzem `MISMATCH`. Ausência de divergência não autentica dados nem valida uma estratégia. O digest identifica bytes e não prova autoria ou origem.
- Contagens seguem o sinal de `profit_ratio`, como no upstream; esse campo é arredondado independentemente de `profit_abs`. Resumos são comparados com tolerância relativa de 1e-8, sem tolerância absoluta universal. JSON com chaves duplicadas ou profundidade acima de 64 é rejeitado. Sem campos comparáveis, o status é `NO_FIELDS_CHECKED`.
- Custos, slippage, dados ausentes, seleção de ativos, vazamento temporal, recursive bias, múltiplas tentativas e desempenho fora da amostra não são avaliados pelo leitor. Valores usam ponto flutuante; não servem como contabilidade.

## ChatGPT

O servidor usa o SDK oficial MCP e oferece stdio para clientes locais e Streamable HTTP para teste local. A conexão na conta ChatGPT, hospedagem HTTPS, OAuth e avaliação com modelos reais continuam pendentes. Veja [o roteiro de conexão](docs/chatgpt.md). Este projeto não instala um plugin automaticamente e não precisa de `OPENAI_API_KEY`.

## Arquitetura e ecossistema

Separação de responsabilidades: Freqtrade produz o experimento fora deste processo; este leitor valida e reduz o resultado; ChatGPT explica o resumo com suas limitações. Capital Web3 pode consumir o resumo para revisão humana; TradingAgents mantém análise textual e Kronos seus experimentos temporais. Integrações com esses projetos estão propostas, não homologadas. [ADR](docs/adr/0001-offline-report-boundary.md).

## Segurança, operação e evolução

O arquivo é lido antes de conectar o cliente; nenhuma ferramenta pode trocá-lo. Não há gravações, egress de negócio, subprocessos ou reexecução de estratégias. HTTP tem limite de 16 KiB por pedido e timeout de 10 segundos. stdout de stdio é reservado ao protocolo; erros não mostram paths ou conteúdo. Encerrar o processo remove o estado em memória. Arquivos, permissões e backups permanecem sob responsabilidade do operador.

As marcações MCP `readOnlyHint` são metadados, não autorização. O transporte local confia no usuário do sistema operacional; não oferece isolamento entre clientes ou tenants. Limites de concorrência, autenticação, retenção, rate limiting distribuído e revisão de dados precisam existir antes de um serviço remoto. Consulte [SECURITY.md](SECURITY.md).

Roadmap: revisar PR e contratos; validar exports de outras versões; avaliar explicações PT-BR em conjunto de casos; escolher hospedagem e identidade; só então conectar e homologar ChatGPT com dados autorizados. Não há plano de ordens via LLM nesta versão.

## Licença e origem

Código deste leitor: MIT, copyright Carlos Felipe Peixoto. Implementação independente escrita a partir do estudo do formato; nenhum código, estratégia, modelo, asset ou dataset Freqtrade foi incorporado. Não é fork, substituto do motor, projeto oficial ou implementação formalmente certificada como clean-room. O [Freqtrade](https://github.com/freqtrade/freqtrade) mantém seus autores e licença GPLv3. Copiar ou redistribuir seu código exige cumprir essa licença; MIT deste leitor não relicencia o upstream. Dependências mantêm licenças próprias. Referências em [THIRD_PARTY.md](THIRD_PARTY.md).
