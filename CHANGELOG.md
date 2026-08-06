# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
