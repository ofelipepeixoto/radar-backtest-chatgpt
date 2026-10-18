# ADR 0001 — Integração por relatório offline

Status: implementado em laboratório, aguardando revisão humana.

## Contexto

Freqtrade já implementa simulação e trading. Reescrever seu motor ou expor sua API administrativa a um LLM adicionaria manutenção e autoridade desnecessárias para explicar experimentos. Capital Web3, Kronos e TradingAgents já têm domínios distintos e não precisam de outro motor financeiro.

## Decisão

Criar uma interface MCP pequena que consome apenas o JSON principal produzido fora do processo. A fronteira pública oferece IDs anônimos de estratégias e cálculos descritivos; apenas o operador local escolhe o arquivo. Não copiar código GPLv3 nem incorporar estratégias. Usar Node/TypeScript e SDK oficial MCP para manter o contrato próximo dos adapters existentes do ecossistema. Não portar o motor Python.

Os dados brutos são limitados a 2 MiB, 32 estratégias e 10.000 trades; campos livres são descartados. A aplicação não valida autoria do arquivo, qualidade de mercado, custos ou vieses. SHA-256 identifica o conteúdo observado. Nenhuma operação de trading existe no contrato.

## Alternativas

Fork integral: adequado se houver manutenção de mudanças no motor; custo desnecessário para este objetivo. API REST administrativa: concede superfície de ações e credenciais que o leitor não precisa. Módulo interno Capital: acoplaria a primeira validação a outro produto ainda em evolução. CSV genérico: perde contexto do formato Freqtrade e exige convenções adicionais.

## Consequências

Interface original e revisável, sem custo de LLM no backend. Imports são manuais e dependem da versão do export; compatibilidade inicial é limitada. Não há conexão contínua, serviço remoto, autenticação, ingestão n8n homologada ou integração operacional com os outros repositórios. Fases futuras exigem critérios e revisão próprios.
