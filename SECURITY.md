# Segurança

Perfis distintos: v1 local confia no usuário do sistema operacional e não pode
ser publicado; v2 remoto valida JWT e autorização por relatório. O piloto v2
admite um proprietário, com tentativas de outro usuário testadas. Isso não
equivale a um SaaS multi-tenant homologado. O issuer é fixado ao volume privado;
troca de identidade exige nova pasta ou migração revisada.

Relatórios são dados não autenticados. Parser limita JSON a 2 MiB, profundidade 64,
32 estratégias/10.000 trades, valida UTF-8, duplicatas e números finitos inclusive
em campos descartados. Configs, nomes, pares, notas e instruções externas não
chegam ao modelo. Não existe execução de estratégias, subprocesso de negócio,
ordem, transferência, acesso privado de exchange ou carregamento de ZIP/scripts.

Dados reduzidos, hashes e contexto continuam confidenciais. Originais não são
persistidos. Catálogo POSIX exige dono correto, modos 700/600 e ausência de
symlinks; arquivos são revalidados, e escrita usa lock/rename/fsync. O operador
precisa controlar também diretórios pais e backups. Um usuário com controle
do host/uid pode adulterar o estado: não há atestação ou assinatura de origem.

JWT aceita chave assimétrica de JWKS HTTPS fixo pelo operador, typ de acesso,
issuer/audience/exp/iat/sub e scope. Tokens não selecionam seus servidores de
chaves. Não há OAuth caseiro nem confiança em Host/Origin, forwarded headers,
UUID, annotations ou campos do modelo para autorizar. MCP só expõe leitura;
importação/remoção são canais administrativos com scopes próprios.

Remote HTTP tem limites globais/por identidade, corpos, sockets, concorrência
e tempo; as quotas são por processo. Logs minimizados não incluem dados ou
credenciais. TLS e isolamento dependem do destino; não foram implantados por
esta entrega. O código testa criptografia e protocolo em ambiente isolado;
login/consentimento/conta ChatGPT corretos ainda precisam ser observados.

Veja o [runbook](docs/runbook.md) para retenção, backup, restauração, parada e
rollback. Falha após fsync/rename pode exigir reconciliação via listagem/reenvio
idempotente, em vez de assumir que a operação não ocorreu. Remoção não implica
eliminação de backups ou limpeza criptográfica. Sem automação operacional
configurada, não há promessa de expiração, backup ou alerta contínuos.

Relatar problemas por canal privado do mantenedor previamente conhecido ou
security advisories, se disponíveis. Não publicar arquivos privados, dados
pessoais ou segredos em issues. Varredura sem alertas não prova segurança total.
