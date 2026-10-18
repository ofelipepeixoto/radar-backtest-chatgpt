# ADR 0002 — Catálogo privado e comparação declarada

Status: implementação para revisão humana, dependente da PR #1; nenhum merge ou deploy.

Quatro fronteiras: importação administrativa explícita; parser/cálculos;
catálogo privado; interpretação pelo cliente MCP. Nenhum LLM é chamado no backend.

Usar Node/TypeScript e o SDK MCP existente. A persistência inicial é um diretório
POSIX privado de projeções JSON reduzidas e imutáveis. Evita banco, serviço e
mensalidade adicionais para um proprietário, até 1.000 relatórios e 50 por página.
SQLite seria alternativa ao precisar de consultas maiores ou concorrência de
escrita. Esta escolha tem custo de leitura linear e não é um SaaS multiusuário.

Cada importação valida os bytes originais antes de criar um registro. Recebido e
validado são estados transitórios; rejeitado não deixa corpo nem registro no
catálogo. Só `AVAILABLE` é publicado por rename atômico após fsync. Arquivos
interrompidos não são listados. A remoção administrativa retorna `REMOVED`.

Persistir digest dos bytes, versão do parser/schema, UUID opaco, instante de
importação UTC, hash da identidade e projeções/contexto estritos. Não persistir
originais, nomes, pares, notas, estratégias ou configurações. O operador retém
fora do runtime os JSONs originais necessários a uma reimportação independente;
backup das projeções reproduz consultas, sem provar o experimento produtor.

Identidade é argumento interno do backend. O proprietário vem da sessão
validada no perfil remoto; o namespace do catálogo fica vinculado ao issuer.
Mesmo hash com outra identidade não transfere acesso. Mesmo proprietário/hash
com contexto diferente é rejeitado: corrigir por remoção e reimportação
administrativas explícitas. Não há atualização silenciosa de evidência.

Diretório 0700 e arquivos 0600, dono do processo; rejeitar symlinks. Um lock
exclusivo de escrita entre processos evita duplicação por concorrência. Crash
pode exigir recuperação manual do lock, após confirmar que não há escritor.
Leituras revalidam o schema; dados corrompidos falham de modo fechado. Não há
cache de autorização ou respostas compartilhadas.

O contexto separa histórico (milissegundos), execução Freqtrade (segundos) e
importação (ISO UTC), sem inferência de unidade. Campos têm procedência EXPORT,
OPERATOR ou UNKNOWN. Hash de universo/versão reduz texto livre, sem garantir
anonimato ou autenticidade. Dataset, taxas e slippage continuam declarações.

Comparação é determinística: igualdade de campos decisivos permite diferenças
históricas; lacunas/mudanças decisivas bloqueiam diferenças diretas. Versões
ausentes/diferentes ou resumo divergente acrescentam ressalvas. Alavancagem
variável sem trajetória comparável bloqueia comparação direta. Ranking de
investimento permanece desabilitado em todos os estados.

O perfil local v1 mantém seus dois nomes e schemas. O catálogo usa nomes v2,
sempre reportId+strategyId. Não há importação, remoção, path, URL, código ou
identidade entre os argumentos MCP.
