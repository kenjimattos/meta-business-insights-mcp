# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Segurança

- **Corpo de requisição tem teto de 1 MB.** O `/register` e o `/token` são
  públicos por especificação — a autenticação vem depois deles —, e a ponte
  bufferizava o corpo inteiro na memória antes de qualquer validação (o limite
  de 16 KB do `/register` só era conferido depois de já ter lido tudo). Um POST
  anônimo de vários GB viraria pressão de memória no processo. Agora
  [`src/http-bridge.ts`](src/http-bridge.ts) conta os bytes durante a leitura e
  aborta assim que estoura, sem acumular o resto; [`src/http.ts`](src/http.ts)
  responde `413` em vez de `500`. O [`deploy/Caddyfile`](deploy/Caddyfile) corta
  o mesmo tamanho na borda, como defesa em profundidade. O teto é folgado de
  propósito: as mensagens JSON-RPC do `/mcp` têm poucos KB, então nada legítimo
  quebra.

- **Uma enxurrada no `/register` não desconecta mais a equipe.** O teto de 500
  registros descartava sempre os mais antigos, o que transformava o endpoint —
  público por especificação — numa arma: quinhentos registros anônimos
  empurravam para fora os conectores reais, e cada pessoa caía num
  `invalid_client` do qual não se recupera sozinha, porque a saída é remover e
  readicionar o conector. Agora o despejo só alcança registro que **ninguém
  está usando**: cliente com sessão viva é intocável, e a lista passa do teto
  de propósito se for esse o caso. Descartar quem nunca completou um login é
  gratuito; deslogar quem está trabalhando, não.

  Junto vieram duas contenções: o `/register` aceita 10 registros por origem a
  cada 10 minutos (o Claude chama duas vezes ao adicionar um conector, então a
  folga é larga), respondendo `429` com `Retry-After`; e os mapas em memória
  deixaram de crescer sem freio — código emitido e nunca trocado agora vence
  junto com os outros, e os logins em andamento têm teto, já que o
  `/authorize` também não pede credencial.

- **O começo do `x-forwarded-for` deixou de ser levado a sério.** O cabeçalho é
  uma lista e quem chama escolhe o começo dela — o proxy só acrescenta, no fim,
  o endereço que ele mesmo enxergou. Ler o primeiro elemento deixava forjar
  linha de log e, pior, escapar de qualquer limite por origem trocando o
  cabeçalho a cada requisição. Passamos a ler o último, e só quando a conexão
  vem do loopback: é o desenho do deploy, com o Caddy terminando o TLS na mesma
  máquina. Exposto direto, o cabeçalho não prova nada e vale o socket.

### Corrigido

- **O token não sai mais nas respostas das tools.** A Graph API monta as URLs
  de `paging.next` e `paging.previous` já autenticadas, com o `access_token` na
  query string. O `graph_api_get` devolvia o corpo cru, então o System User
  token inteiro caía dentro da conversa — onde vira histórico e sai do nosso
  controle. O novo [`src/redact.ts`](src/redact.ts) entra em `text()` e
  `fail()`, que são o único caminho de saída das tools: a redação cobre as 31
  de uma vez, não só a que vazou. Pega token em query string, token solto no
  corpo e chaves de segredo em objeto. O `fail()` também redige porque a Graph
  API às vezes ecoa a URL da chamada na mensagem de erro.

  Nada muda no uso: o cursor `after` sobrevive à redação, e o `getAll` consome
  `paging.next` antes do limite da tool, então `paginate: true` continua
  funcionando.

  Vale para quem já rodava: **o fix impede o próximo vazamento, não desfaz os
  anteriores.** Um token que já apareceu numa conversa deve ser considerado
  comprometido — gere outro e invalide o antigo em Configurações do negócio →
  Usuários do sistema. Isso pesa mais desde que a chave passou a levar
  `ads_management`: quem lê o vazamento escreve nas contas.

## [0.2.0] — 2026-08-11

Instalar o conector deixou de exigir Node na máquina de cada pessoa, e passou a
funcionar no app de celular. O servidor ganhou um authorization server próprio
com login pelo Google Workspace: quem entra usa a conta que já tem, e a lista
de quem pode usar virou uma lista de e-mails em vez de uma lista de segredos.

A pessoa preenche dois campos — nome e URL — deixa os campos avançados em
branco, clica em Connect e escolhe a conta do Google. Nada de token circulando
por chat, nada de `claude_desktop_config.json`.

O Google entra **só no login**, para provar identidade. Não guardamos token
dele nem chamamos API deles depois: o acesso ao Meta continua sendo o
`META_ACCESS_TOKEN` único da VPS, e o login não muda o que alguém alcança no
portfólio — só quem pode entrar.

### Adicionado

- **Authorization server** em [`src/oauth.ts`](src/oauth.ts): `/authorize`,
  `/token`, `/register` e `/oauth/google/callback`, mais os dois documentos de
  descoberta que o cliente MCP consulta.
- **Dynamic Client Registration** (RFC 7591). É o que permite deixar Client ID
  e Secret em branco na janela do conector — o Claude se registra sozinho.
- **Login pelo Google Workspace** em [`src/google.ts`](src/google.ts), isolado
  do resto para que o servidor não passe a depender de nenhuma API deles.
- **`MCP_ALLOWED_EMAILS`** (`ana@empresa.com:write,bruno@empresa.com`) — quem
  pode entrar, com o mesmo sufixo `:write` que já separava leitura de escrita.
- **`MCP_OAUTH_ISSUER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e
  `GOOGLE_HD`** para configurar o login.
- **Sessões persistidas** em `oauth-sessions.json` e clientes registrados em
  `oauth-clients.json`, ambos no `META_DATA_DIR`. Os dois sobrevivem ao restart:
  sem isso a equipe refaria login (ou readicionaria o conector) a cada deploy.

### Alterado

- **`MCP_HTTP_TOKENS` virou opcional**, como saída de emergência para o `curl`
  de diagnóstico e para a ponte local stdio→HTTP. O bearer estático continua
  aceito direto no `/mcp`, então quem já usava a ponte não perde acesso — a
  migração pode ser feita pessoa a pessoa.
- **O servidor se recusa a subir** com configuração pela metade: issuer sem
  Google, Google sem allowlist, ou nenhuma das duas formas de autenticação
  definida.
- **`loadConfig` valida a escrita no `META_DATA_DIR` no boot**, e por isso vale
  para os três entrypoints — servidor HTTP, stdio e o CLI de snapshot. Sem essa
  checagem o sintoma é traiçoeiro: o processo sobe, responde `/healthz` e
  autentica, e só quebra quando alguém tenta gravar — no primeiro `/register`,
  ou de madrugada no snapshot, que falha em silêncio e leva junto um dia da
  janela de 30 dias do `follower_count`. Não basta o `mkdir`: quando o
  diretório já existe pertencendo a outro usuário, ele passa calado, então a
  permissão é testada de fato.
- README: a seção de tokens da equipe virou "quem pode entrar", e o passo 5
  passou a descrever o Google Cloud Console.
- README: Atualização do descritivo e updates das novas funções.


### Segurança

- **PKCE S256 obrigatório**; `plain` não é aceito.
- **O parâmetro `hd` da URL do Google não é controle de acesso** — ele só filtra
  o seletor de contas. Quem barra é a verificação da claim `hd` no `id_token`,
  no servidor, junto com `iss`, `aud`, `exp` e `email_verified`. Sem
  `email_verified`, uma conta com e-mail não confirmado poderia reivindicar o
  endereço de outra pessoa da allowlist.
- **A assinatura do `id_token` não é verificada, de propósito.** Ele vem direto
  do endpoint do Google, por TLS, numa requisição nossa — o caso que o OIDC Core
  §3.1.3.7 dispensa. Verificar exigiria buscar e cachear o JWKS sem comprar
  segurança nenhuma aqui.
- **`client_id` e `redirect_uri` inválidos nunca viram redirect**, para não
  transformar o `/authorize` num open redirect que entrega o código a quem
  escolheu a URL. O `redirect_uri` é conferido contra o que aquele cliente
  declarou no registro.
- **Código de autorização é de uso único e queima na tentativa inválida**,
  inclusive para o dono legítimo: um código que alguém já tentou usar
  indevidamente não deve continuar valendo. Um cliente também não troca o código
  emitido para outro.
- **Revogação continua sendo apagar uma linha.** As sessões são ancoradas no
  e-mail; o boot descarta as que saíram da allowlist, matando access e refresh
  juntos. Os scopes são relidos da lista viva a cada request, então conceder
  `:write` dispensa relogin.
- **Em disco só ficam digests** — nem access token, nem refresh token, nem
  client secret. O backup do `META_DATA_DIR` não devolve credencial utilizável.

### Notas

- O login prova *quem é a pessoa*, não *o que ela alcança no Meta*. Um acesso
  que respeitasse o cargo de cada um no Business Manager exigiria delegar ao
  Facebook Login em vez do Google — e aí entram App Review, expiração de token
  de usuário e particionar o cache de snapshots por identidade, que hoje é um
  arquivo só.
- O Claude registra o cliente mais de uma vez (observadas duas chamadas ao
  `/register` em menos de dois segundos). É inofensivo, mas explica o
  `oauth-clients.json` crescer mais rápido que o número de pessoas; há teto de
  500 registros, descartando os mais antigos.

### Descobertas de operação

Custaram tempo no primeiro deploy e não estão em lugar nenhum óbvio:

- **`git pull` não atualiza o `dist/`**, que está no `.gitignore`. Sem
  `npm ci && npm run build`, a VPS continua rodando o build antigo — e o sintoma
  é enganoso: `/healthz` responde, o `/mcp` autentica, e só as rotas novas somem.
- **`META_DATA_DIR` vazio não é o mesmo que ausente do ponto de vista de quem
  edita**, mas cai no mesmo default (`~/.meta-business-insights-mcp`) — que não
  existe para o usuário `mcp`, criado com `--no-create-home` e com
  `ProtectHome=true` no unit. Colar o bloco do `.env.example` por cima do arquivo
  de produção zera a variável e derruba toda escrita em disco, incluindo o
  snapshot diário.

## [0.1.2] — 2026-08-06

Primeira versão com escrita. Até aqui o servidor só lia; agora ele pode
publicar em nome das contas, o que muda o perfil de risco e por isso vem
desligado por padrão.

### Adicionado

- **`reply_comment`** — responde um comentário em nome da conta, nas duas redes.
- **`hide_comment`** — oculta ou reexibe um comentário. Ocultar não notifica o
  autor e mantém o comentário visível para ele; é o caminho usual para spam e
  golpe, menos abrasivo que excluir.
- **`GraphClient.post`** — primeiro método de escrita do cliente.
- **`META_ALLOW_WRITES`** — libera as tools de escrita na instância. Desligado
  por padrão.
- **Sufixo `:write` nos bearers** (`MCP_HTTP_TOKENS=nome:token:write`), separando
  quem consulta dados de quem publica em nome das marcas. O sufixo é
  configuração do servidor: o cliente continua enviando só o token.

### Segurança

Escrita pública em nome de cliente é irreversível na prática — excluir depois
não desfaz quem já leu. Quatro decisões refletem isso:

- **Duas trancas em série** no modo HTTP: a instância precisa permitir escrita
  *e* o bearer precisa do sufixo `:write`. Sem as duas, as tools não aparecem no
  `tools/list` — quem não tem o direito não as enxerga, em vez de vê-las e tomar
  erro ao usar.
- **`reply_comment` exige `confirm: true`.** Sem ele devolve a prévia do que
  seria publicado e não chama a API.
- **Escritas não têm retry** em erro de rede nem em 5xx, ao contrário das
  leituras: um POST que falha de forma ambígua pode ter sido processado, e
  repetir publicaria o comentário duas vezes. Só há retry em rate limit, onde o
  Meta rejeitou explicitamente e nada aconteceu.
- **Auditoria:** toda escrita bem-sucedida vira uma linha `ESCRITA` no journal,
  ao lado da linha de request que identifica quem chamou.

### Permissões

- `pages_manage_engagement` passa a ser necessária para responder e ocultar
  comentários no Facebook. O Instagram usa a mesma `instagram_manage_comments`
  já exigida pela leitura, e a task `Atividade da comunidade` já cobre moderação.

### Notas

- O tom de voz deliberadamente **não** mora no servidor. As tools publicam o
  texto que recebem; a redação fica no Claude, com os documentos da equipe como
  conhecimento de projeto ou Skill — assim ajuste de tom não vira deploy.

## [0.1.1] — 2026-08-06

Duas frentes: o servidor deixou de ser só local e passou a rodar compartilhado
numa VPS, e ganhou a dimensão de **publicação** — antes só existiam períodos e
contas.

### Adicionado

- **Modo HTTP** (`dist/http.js`), servindo o mesmo servidor MCP pela rede atrás
  de bearer token. Permite que a equipe use o servidor sem que o token do Meta
  saia da VPS. O modo stdio (`dist/index.js`) continua igual para uso local.
- **Bearers nomeados** (`MCP_HTTP_TOKENS=nome:token,...`), um por pessoa: o nome
  aparece no log de cada requisição e tirar alguém é remover uma linha, sem
  trocar o segredo dos demais.
- **`content_insights`** — desempenho por publicação nas duas redes: curtidas,
  comentários, compartilhamentos, salvamentos, views, alcance e tempo de
  visualização. Ordenável por qualquer métrica, normalizada ou crua.
- **`content_comments`** — leitura dos comentários das publicações, com filtro
  por palavra. Feita para diagnóstico de reclamações e dúvidas recorrentes.
- **CLI de snapshot** (`npm run snapshot`) e **timer diário do systemd**, para
  que o histórico de seguidores seja alimentado por cron em vez de depender de
  alguém pedir a tool ao Claude.
- **Artefatos de deploy** em [`deploy/`](deploy/): unit do systemd para o
  servidor, unit + timer para o snapshot, e Caddyfile com TLS automático.

### Corrigido

- Sintaxe do filtro de log do Caddy. Campos de filtro não podem ir direto no
  encoder `json` — é preciso o encoder `filter` envolvendo o `json`. Como
  estava, o Caddy recusava a configuração inteira e não subia.

### Alterado

- `src/index.ts` virou apenas o entrypoint stdio; a definição do servidor mudou
  para `src/server.ts`, permitindo que os dois transportes compartilhem o mesmo
  código.
- A captura de snapshot saiu de dentro do handler da tool para `src/snapshot.ts`,
  para ser alcançável fora do MCP.
- Permissões documentadas no README: acrescentadas `pages_read_user_content` e
  `instagram_manage_comments`, exigidas pela leitura de comentários.
- Removido o `chown -R` das instruções de instalação. Ele era desnecessário — o
  serviço só lê o código — e um erro de digitação no caminho o transforma em
  `chown -R /`, que reescreve o dono do sistema inteiro e apaga os bits setuid
  de `sudo`, `su` e `passwd`.

### Descobertas sobre a Graph API

Verificadas contra a v26, não lidas na documentação:

- **Métricas por publicação não são intercambiáveis entre tipos no Instagram.**
  Um reel aceita `ig_reels_avg_watch_time` mas não `profile_visits`; um post de
  feed é o oposto. Pedir a métrica errada derruba o request inteiro com `(#100)`.
  O Facebook é tolerante: métrica de vídeo em post de foto volta vazia.
- **Tempo de visualização vem em milissegundos**, enquanto o Business Suite
  mostra segundos. Sem conversão, o relatório erra por um fator de mil.
- `post_impressions`, `post_impressions_unique` e `post_engaged_users` foram
  desligadas e respondem `(#100) The value must be a valid insights metric`.
- **As duas redes não contam interação igual.** No Facebook, "curtidas" é o total
  de reações e "salvos" não existe. A tabela normaliza para permitir comparação,
  com a ressalva documentada.
- **Permissão sem atribuição de ativo não funciona.** A permissão pode constar no
  token e ainda assim falhar se a Página não estiver atribuída ao System User com
  as tasks corretas — e os erros (`(#190)`, `A Page access token is required`) não
  sugerem essa causa. A configuração mínima verificada é `MODERATE` + `ANALYZE`.
- **Um token existente não ganha permissões novas.** Depois de habilitar
  qualquer uma, é preciso gerar um token novo.

## [0.1.0] — 2026-08-05

Versão inicial.

### Adicionado

- Descoberta do portfólio via Business Manager (`owned_pages`, `client_pages` e
  `/me/accounts`), com resolução e cache dos Page Access Tokens.
- Série histórica de seguidores por dia, semana, mês, trimestre ou ano, com
  ganhos, perdas, saldo e total acumulado — orgânico e pago juntos.
- Tools de insights de Página e de conta do Instagram, com agregação livre por
  período, ativo, superfície, métrica e breakdown.
- Histórico local de snapshots de seguidores, para contornar a janela curta da
  Graph API.
- Catálogo curado de métricas com o mapa das descontinuadas e seus substitutos.
- `graph_api_get` para consultas cruas, com o Page token já resolvido.

### Descobertas sobre a Graph API

- **No batch, o token por operação precisa ir na query string do
  `relative_url`.** Como campo do objeto da operação, o Meta ignora
  silenciosamente e aplica o token do envelope — fazendo Page Insights responder
  `(#190)`.
- **`end_time` tem significados opostos nas duas superfícies.** No Facebook é o
  limite da janela (o dia medido é `end_time - 1`); no Instagram já é o dia
  medido. Aplicar o mesmo deslocamento nos dois faz valores vazarem para o mês
  anterior.
- **O breakdown `follow_type` nomeia o estado resultante**, não a ação:
  `FOLLOWER` é ganho, `NON_FOLLOWER` é perda — o contrário do que várias fontes
  de terceiros afirmam. Casar por substring quebra, porque `NON_FOLLOWER` contém
  `FOLLOWER`.
- **O Business Suite reporta ganhos brutos**, não saldo. Ao comparar, use a
  coluna "Ganhos".
- Quase toda métrica do Instagram é `total_value`-only: só `reach` e
  `follower_count` aceitam `time_series`.
- Janela máxima por request: 93 dias em Page Insights, 30 dias no Instagram.
