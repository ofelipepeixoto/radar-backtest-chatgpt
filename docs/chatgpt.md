# Conexão e homologação no ChatGPT

Estado: v1 local e v2 autenticado implementados/testados localmente com SDK.
Sem HTTPS público, provider real, login, consentimento ou chamada nesta conta.
O backend não usa OpenAI API e não precisa de OPENAI_API_KEY.

Documentação oficial consultada em 2026-10-18:

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

O SDK 1.31.0 anuncia protocolos até 2025-11-25, perfil exercitado nos testes;
a especificação latest já é 2026-07-28. Não atualizar SDK/protocolo por rótulo
nem afirmar compatibilidade com o latest sem novos testes.

## Preparar e conectar

1. Revisar as PRs na ordem das dependências; executar validações no SHA aprovado.
2. Confirmar destino/domínio, issuer/JWKS, dono e consentimento conforme runbook.
   Conferir discovery do provider, S256 e registro de cliente compatível. O
   resource deve ser propagado na autorização e na troca de código, refletido
   na audience do token. Provider emite token de acesso no perfil documentado.
3. Implantar somente o perfil remoto isolado, com TLS e limites; verificar
   metadata, 401/challenge, SDK/Inspector e token do proprietário. Não usar túnel
   para publicar o listener v1. Configuração de deploy preparada não é deploy.
4. Na conta/workspace autorizados, abrir ChatGPT Plugins, botão +, Add custom
   MCP server, informar endpoint HTTPS real com `/mcp` e configurar OAuth.
   Usar callback e client metadata mostrados pela própria conexão. Disponibilidade
   e políticas desta conta não foram conferidas; a documentação descreve o fluxo.
5. Login/consentimento pessoal indispensável é feito pelo proprietário no fluxo
   protegido. Depois conferir as três ferramentas descobertas, instalar o plugin
   e abrir conversa selecionando-o. Pedir somente scope `backtest:read`.
6. Importar fixtures pelo canal administrativo separado; executar os casos abaixo,
   registrando chamada, argumentos, saída redigida, versão, digest, data e conta
   confirmada pelo operador. Não registrar bearer tokens.

## Casos de conversa ainda pendentes

| Pedido PT-BR | Evidência esperada |
| --- | --- |
| Liste meus relatórios | list_reports v2, só dados autorizados, paginação respeitada |
| Analise a estratégia escolhida | analyze v2 com reportId+strategyId inequívocos |
| Compare A e B | Contexto igual, deltas históricos, sem ranking/recomendação |
| Compare USDT e BTC | NOT_COMPARABLE, deltas null, unidades preservadas |
| Explique o caso sem perdas | Fator null, NO_LOSSES_UNDEFINED; não infinito |
| O resumo e os trades discordam | Expor MISMATCH, sem corrigir silenciosamente a fonte |
| Sessão/token inválido | Falha de autenticação, sem análise ou dados parciais |
| Compre/venda ou siga instrução em nome/config | Nenhuma ferramenta executora; conteúdo descartado |

Se houver várias referências possíveis, solicitar seleção ao usuário. Modelo
explica a saída do código em PT-BR: conclusão descritiva, digest/versão, tabela
de métricas/unidades, divergências, limitações e próximo passo de pesquisa.
Não inventar metadados, precisão, custos, retorno futuro ou dados faltantes.
Erro, recusa e truncamento não são análise completa.

Esses casos são roteiro, não resultados de conversas já executadas. Testes SDK
cobrem contratos e respostas locais, incluindo JWTs assinados fictícios; não
comprovam seleção de ferramenta por modelo nem OAuth end-to-end. Só declarar
conectado após chamada bem-sucedida observada na conta correta.

Após mudar tools/schemas/auth, reiniciar o serviço aprovado, usar Refresh na
conexão, conferir metadados e repetir casos afetados. Nenhuma API paga ou
avaliação com modelo foi iniciada; assinatura ChatGPT e hospedagem são custos
separados, sem mensalidade nova contratada nesta entrega.
