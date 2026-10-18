# Conexão e verificação no ChatGPT

Referências oficiais consultadas em 2026-10-18:

- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/plugins/build/auth

## Estado desta entrega

Servidor MCP criado, com transportes locais stdio e Streamable HTTP. Nenhuma conexão na conta ChatGPT ou hospedagem foi configurada por este repositório. Testes SDK verificam o protocolo local; não substituem teste com ChatGPT.

## Roteiro de homologação

1. Revisar o código e executar `npm ci --ignore-scripts`, `npm run typecheck` e `npm test`.
2. Usar `--demo` no MCP Inspector para conferir inicialização, schemas e as duas ferramentas. Testar também estratégia inexistente, campo extra e tentativa de enviar path/URL/ordem.
3. Definir os dados que poderão sair do equipamento. Mesmo o resumo numérico pode ser confidencial. Selecionar apenas um contexto autorizado por processo.
4. Para ChatGPT remoto, preparar uma implantação específica com HTTPS estável, autenticação e autorização de cada usuário/recurso, limites e logs sem dados privados. O servidor loopback deste laboratório não deve ser exposto nem simplesmente encaminhado por túnel como serviço pronto.
5. Usar o fluxo de conexão de MCP customizado disponível na conta/workspace, conforme a documentação oficial e permissões do plano. Inspecionar ferramentas antes de testar a conversa. A disponibilidade da opção não foi validada nesta entrega.
6. Rodar casos PT-BR: explicar diferença dos dois drawdowns; explicitar fator indefinido sem perdas; reconhecer divergência do resumo; recusar previsão ou compra/venda; não obedecer instruções vindas de arquivos; não inventar taxa, período ou qualidade que não estão na saída.
7. Registrar versão, digest do dataset fictício, resultados, falhas e responsável pela revisão. Só marcar “conectado/testado no ChatGPT” após observar esses passos na conta.

O leitor não faz chamadas à OpenAI API. ChatGPT é o cliente que interpreta os resultados. Não há chave de API nem custo de inferência disparado pelo código; assinatura do cliente e eventual hospedagem são custos separados.
