# Segurança

Escopo suportado: processo local de leitura de um único relatório selecionado pelo operador. Os dados são tratados como não autenticados; a aplicação só devolve números, mensagens fixas e identificadores anônimos. Campos livres são removidos, incluindo nomes, pares, notas e configurações.

O laboratório não executa código do relatório e não importa Freqtrade. Não aceita ZIP, pickle ou joblib. Não possui credenciais, ferramentas financeiras, efeitos de negócio, autenticação remota, isolamento de tenants ou promessa de anonimização estatística. Agregados podem identificar uma operação quando combinados com outras fontes.

Mantenha arquivos fora do checkout, com permissões locais restritas. Não comite exports reais. Cada processo usa um único contexto de dados; não compartilhe-o entre usuários. O leitor Linux rejeita symlinks finais e arquivos não regulares; o operador deve controlar a árvore de diretórios. A memória pode manter cópias até encerramento/coleta; não há limpeza criptográfica garantida.

Não exponha a porta de desenvolvimento. Para acesso remoto serão necessários autorização por recurso no servidor, OAuth conforme o cliente, TLS, limites por usuário e globais, retenção e testes negativos de isolamento. Nenhum desses controles pode ser substituído por prompts ou annotations MCP.

Para relatar um problema, use o canal privado de segurança disponibilizado pelo proprietário no GitHub; não publique credenciais, relatórios privados ou dados pessoais em issues. A disponibilidade desse canal não é presumida. Até existir um canal privado, contate o mantenedor por um meio privado previamente conhecido.
