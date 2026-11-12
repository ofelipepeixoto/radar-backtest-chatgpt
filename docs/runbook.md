# Operação do piloto privado

Esta configuração é preparação revisável. Não há domínio, provedor OAuth,
VPS ou conexão ChatGPT implantados por esta entrega. Não abrir a porta 8788.

## Recursos e identidade que faltam

Confirmar o hostname HTTPS, destino isolado autorizado, rede/entrypoint/resolver
Traefik existentes, mecanismo seguro de acesso e provedor de identidade. O
histórico da VPS não comprova acesso desta sessão. Não criar recursos pagos ou
usar autenticação/Supabase de outro projeto por presunção.

Usar provedor estabelecido com autorização de usuário, authorization code +
PKCE S256, discovery OAuth/OIDC e registro compatível com o cliente (CIMD,
DCR ou cliente previamente configurado). Confirmar issuer, JWKS HTTPS fixo,
audience/resource exatamente igual ao endpoint HTTPS `/mcp`, subject estável
do único proprietário e redirect URI mostrado na conexão real do ChatGPT.
Não copiar callbacks de exemplos. Não conceder client_credentials ao dono.

Perfil de token aceito: JWT de acesso assinado RS256/ES256, typ `at+jwt`,
iss/aud/sub/iat/exp e scope escalar com tokens separados por espaço. Não aceita
ID token, segredo compartilhado, token opaco ou de outro serviço. Não é uma
implementação integral de todos os claims opcionais/perfis RFC9068. Providers
com outro formato exigem revisão própria, sem afrouxar validação silenciosamente.

ChatGPT pede só `backtest:read`. Cliente administrativo separado recebe
`backtest:import`; remoção explícita requer `backtest:admin`. O serviço não
implementa login, token endpoint, refresh ou emissão de JWT. JWKS tem timeout
3s e cache máximo 5min; o único egress de negócio é a URL fixada das chaves.
Indisponibilidade/chave inválida resulta em acesso negado. Revogação imediata:
interromper o serviço e revogar consentimento no provider; tokens assinados já
emitidos podem durar até expirar se apenas a sessão do provider for encerrada.

## Preparação da implantação

Configuração protegida conforme `deploy/config.example.json` (valores .invalid
são placeholders), copiada fora do checkout, modo 0600 e dono do processo.
`BACKTEST_CONFIG` é seu caminho local. Diretório pai dos dados precisa existir,
ser controlado pelo operador e não conter symlinks; o catálogo cria a pasta
final em 0700. Em container, bind mounts dedicados pertencem ao uid/gid 1000;
o `storageDir` do exemplo é `/data/reports`. Não montar /root, Docker socket,
volumes de outros serviços ou credenciais gerais da VPS.

`deploy/compose.yaml` não publica porta no host. Exige nome de rede Traefik e
variáveis concretas antes de renderizar. Confirmar que o roteador mantém Host
original, termina TLS e permite POST no MCP e GET em discovery. O processo
remoto vincula o Host à configuração, ignora identidade em forwarded headers
e só aceita Origin ausente ou explicitamente permitido (origens HTTPS exatas).
Mantenha as rotas administrativas bloqueadas no proxy público e use canal
administrativo isolado, se a política do destino permitir; OAuth/scopes continuam
obrigatórios. Conceder importação nunca concede uma ferramenta MCP de escrita.

O build Docker usa `node:22-bookworm-slim`; a tag não foi resolvida nem testada
neste ambiente. Antes de deploy, resolver/pinar digest aprovado, construir a
imagem, executar a suíte nela e conferir dependências/imagem. Compose não foi
executado nesta sessão. O runtime nativo foi verificado em Node 24; a CI usa
Node 22. Sem comprovação de imagem/host, não marcar implantação como validada.

## Transferência e uso administrativo

O anexo do Work não está automaticamente no servidor. A CLI `npm run admin --
import <JSON-principal> [contexto.json]` lê o arquivo no equipamento que a
executa e envia seus bytes via HTTPS ao endpoint configurado. O JSON nunca é
obtido por URL/path escolhido pelo modelo. `BACKTEST_RESOURCE` define o endpoint
aprovado `/mcp`; `BACKTEST_TOKEN_FILE` aponta para arquivo 0600 do operador com
token de sessão obtido pelo fluxo protegido do provider. Não colar tokens no
chat ou usar argumentos de linha de comando para eles. A CLI recusa redirects.
Na homologação, o operador desta sessão faz a transferência quando o acesso
protegido estiver disponível; estes comandos documentam reprodução.

`contexts:{}` preserva lacunas; o exemplo completo declara dados fictícios.
Definir o contexto antes da importação. Reenvio idêntico retorna o mesmo UUID;
alteração de contexto para o mesmo hash é recusada. Correção exige remoção
explícita e nova importação. `npm run admin -- remove <reportId>` é destrutivo
para aquela projeção e exige mandato administrativo concreto. Não expor esta
operação como tool do modelo.

## Limites, logs e parada

Por processo: 120 pedidos/min global e 60/min por identidade, até 16 pedidos
ativos, 64 sockets, 10s por pedido, até 32 headers, keepalive até 5s. MCP até
16KiB; envelope administrativo até 3MiB; relatório até 2MiB/32 estratégias/
10.000 trades/profundidade64. Há 1.000 relatórios globais. Limites residem no
processo; múltiplas réplicas não são suportadas por este piloto. Um atacante
pode consumir a quota global: proxy privado/limites de borda são defesa adicional.

Logs JSON contêm timestamp UTC, UUID da requisição, rota enumerada, status e
duração. Não incluem nomes, IDs dos relatórios, tokens, subject ou corpo.
Partes anteriores ao app, como proxy/provider, precisam da mesma política.
Compose limita logs a três arquivos de 5MB. Conservar por até 7 dias conforme
política do operador; não existe job de expiração por tempo nesta entrega.
Alertar no monitor existente sobre indisponibilidade, 5xx, 429 repetidos e disco;
nenhum novo serviço de alerta foi instalado.

SIGTERM/SIGINT fecham o listener; depois de 10s fecham conexões restantes. Para
parada emergencial, encerrar somente este serviço/roteador. Não parar Traefik,
n8n ou outros containers. Reinício reabre as projeções com as mesmas referências.

## Retenção, recuperação e rollback

Política inicial: revisão mensal, alvo de retenção 90 dias por relatório e
remoção administrativa após autorização do proprietário. Não há deleção
automática nem scheduler. Sem rotina operacional confirmada, a retenção efetiva
é até remoção explícita ou limite do catálogo. JSON original fica sob controle
externo do operador, com sua própria retenção; o serviço não o persiste.

Antes de backup, parar o serviço/escritores. Copiar o diretório inteiro para
destino privado isolado protegido/criptografado, incluindo `.cursor-key` e
`.identity-namespace`. Esses arquivos são estado privado, nunca código Git.
Conservar até 3 cópias diárias/7 dias apenas quando essa rotina estiver
configurada. Não há backup remoto automático implementado. Não trocar issuer
reutilizando o volume: o namespace é fixado, e a troca exige nova pasta ou
migração de identidade revisada.

Restaurar com o serviço parado em outra pasta, corrigir dono e modos 0700 para
diretórios/0600 para arquivos (ferramentas de cópia podem criar 0755), confirmar
o mesmo issuer, iniciar isolado e conferir listagem, digests e reanálise. Testes
locais cobrem essa restauração; não simulam pane de disco ou recuperação da VPS.

`.pending-*` nunca é listado. Um crash durante escrita pode deixar `.writer.lock`
e bloquear novas mutações: parar todos os escritores, guardar cópia de evidência,
validar os registros publicados e só então remover o lock/temporários abandonados.
Não remover locks automaticamente, por idade ou durante outro processo ativo.
Exclusão de projeção não apaga backups nem garante eliminação criptográfica.

Rollback de código: parar este serviço, preservar cópia privada do estado,
restaurar imagem/commit anterior e sua configuração correspondente. A v1 não
lê o catálogo v2: pode rodar localmente com relatório selecionado sem expor dados.
Evitar reescrever formato armazenado; migração futura exige backup/testes próprios.
Rollback Git é rejeitar/reverter as PRs; nenhum merge automático é feito.
