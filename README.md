# meta-business-insights-mcp

Servidor MCP para o Claude Desktop ler dados do Meta Business
(Facebook Pages e Instagram) via Graph API, com agregação cross-account do portfólio.

Complementa o MCP de Meta Ads: lá você vê o que veio de campanha; aqui você vê o
número real da conta — inclusive o crescimento orgânico.

## O que dá para perguntar

- "Quantos seguidores o portfólio inteiro ganhou por mês em 2026?"
- "Compare o crescimento de seguidores do Instagram entre as 5 contas maiores."
- "Qual página teve mais visitas de perfil no último trimestre?"
- "Mostre alcance e interações por mês, consolidado, com variação mês a mês."

## Instalação

```bash
npm install
npm run build
```

Crie o `.env` a partir do exemplo e preencha o token:

```bash
cp .env.example .env
```

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `META_ACCESS_TOKEN` | sim | System User token de longa duração |
| `META_BUSINESS_ID` | não | Fixa o portfólio; sem ele a descoberta usa `/me/businesses` e `/me/accounts` |
| `META_API_VERSION` | não | Default `v26.0` |
| `META_DATA_DIR` | não | Onde os snapshots locais são gravados (default `~/.meta-business-insights-mcp`) |
| `META_PAGE_IDS` | não | Restringe o portfólio a Page IDs específicos |

### Permissões necessárias no token

| Permissão | Para quê |
| --- | --- |
| `pages_show_list` | descobrir as Páginas do portfólio |
| `pages_read_engagement` | Page Access Token real e publicações da Página |
| `pages_read_user_content` | comentários de terceiros no Facebook |
| `read_insights` | insights de Página e de publicação |
| `instagram_basic` | mídias e legendas do Instagram |
| `instagram_manage_insights` | insights do Instagram |
| `instagram_manage_comments` | comentários do Instagram |

`business_management` é opcional: habilita a descoberta via
`/{business}/owned_pages`, mas o fallback por `/me/accounts` encontra as mesmas
Páginas.

**Tasks por Página**, atribuídas ao System User em Configurações do negócio:
`Atividade da comunidade` (MODERATE) e `Insights` (ANALYZE). Verificado — não é
preciso acesso total nem tarefas de criação de conteúdo.

Duas armadilhas aqui, ambas custaram tempo:

Um token existente **não ganha permissões novas**. Depois de habilitar qualquer
uma, gere um token novo e substitua o antigo.

A permissão no token **só vale onde há atribuição de ativo**. Sem a Página
atribuída ao System User com as tasks acima, a permissão existe e não funciona —
e o erro (`(#190)`, `A Page access token is required`) não sugere a causa.

Valide tudo antes de plugar no Claude:

```bash
npm run probe
```

O probe imprime o portfólio descoberto, avisa quais páginas estão sem Page Access
Token e puxa 4 meses de seguidores como amostra.

## Dois modos de execução

| Modo | Entrypoint | Quando usar |
| --- | --- | --- |
| stdio | `dist/index.js` | Só você. O Claude Desktop sobe o processo local; o token do Meta fica na sua máquina |
| HTTP | `dist/http.js` | A equipe inteira. O servidor roda numa VPS e o token do Meta nunca sai de lá |

O servidor MCP é o mesmo nos dois — muda só quem o serve.

## Configuração no Claude Desktop (modo stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-business-insights": {
      "command": "node",
      "args": ["/caminho/para/meta-business-insights-mcp/dist/index.js"],
      "env": {
        "META_ACCESS_TOKEN": "SEU_TOKEN",
        "META_BUSINESS_ID": "SEU_BUSINESS_ID"
      }
    }
  }
}
```

Reinicie o Claude Desktop depois de salvar.

## Servidor compartilhado numa VPS (modo HTTP)

O ganho não é performance: é que o token do Meta fica só na VPS. Distribuir o
`.env` para cada pessoa colocaria um token com acesso de escrita ao portfólio
inteiro em N notebooks, sem forma de revogar um sem revogar todos.

### 1. Tokens da equipe

Um bearer por pessoa, não um compartilhado. Custa o mesmo e permite tirar
alguém removendo uma linha:

```bash
openssl rand -hex 32   # repita por pessoa
```

```
MCP_HTTP_TOKENS=ana:3f9c…,bruno:a71d…,carla:88e2…
```

O nome antes do `:` só serve para o log — cada linha do journal diz quem
consultou. O servidor se recusa a subir com `MCP_HTTP_TOKENS` vazio, para que
ninguém exponha o portfólio por esquecimento.

### 2. Na VPS

Conta de sistema sem login e sem home — o `useradd` do `shadow-utils` funciona
tanto em Debian/Ubuntu quanto em RHEL/Alma/Rocky, ao contrário do `adduser`,
que tem sintaxes diferentes em cada família:

```bash
useradd --system --user-group --shell /usr/sbin/nologin --no-create-home mcp
git clone <repo> /opt/meta-business-insights-mcp
cd /opt/meta-business-insights-mcp
npm ci && npm run build
```

Os arquivos ficam de `root`, e está certo assim: o serviço só precisa **ler** o
código, e as permissões padrão (`644`/`755`) já permitem isso. A única coisa que
ele escreve são os snapshots, em `/var/lib/meta-mcp`, que o systemd cria com o
dono correto pelo `StateDirectory`.

Resista à tentação de rodar um `chown -R` aqui. Além de desnecessário, um erro
de digitação no caminho — uma barra sobrando, um `opt` faltando — vira
`chown -R mcp:mcp /`, que reescreve o dono do sistema inteiro e apaga os bits
setuid de `sudo`, `su` e `passwd`. Não há como desfazer com outro `chown`.

O `.env` **não** vai para a VPS. As variáveis ficam em `/etc/meta-mcp.env`
(dono `root`, modo `0600`), que o systemd lê:

```bash
install -m 600 /dev/null /etc/meta-mcp.env
$EDITOR /etc/meta-mcp.env     # META_ACCESS_TOKEN, META_BUSINESS_ID,
                              # MCP_HTTP_TOKENS, META_DATA_DIR=/var/lib/meta-mcp
cp deploy/meta-mcp.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now meta-mcp
journalctl -u meta-mcp -f
```

### 3. Snapshot diário

A janela de `follower_count` do Instagram é de **30 dias**. O que não for
capturado dentro dela não existe em lugar nenhum depois — não há como pedir ao
Meta o total de seguidores de seis meses atrás. O histórico longo só passa a
existir a partir do dia em que você começa a acumulá-lo.

```bash
cp deploy/meta-mcp-snapshot.service deploy/meta-mcp-snapshot.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meta-mcp-snapshot.timer
systemctl start meta-mcp-snapshot          # roda uma vez agora, para conferir
journalctl -u meta-mcp-snapshot -n 5 --no-pager
systemctl list-timers meta-mcp-snapshot
```

O log deve trazer uma linha como
`snapshot 2026-08-06: 6 ativos gravados, 12 no histórico`.

O timer usa `Persistent=true`: se a VPS estiver desligada na hora marcada, ele
roda assim que ela volta. Sem isso, um reboot no horário errado abriria um
buraco permanente na série.

O mesmo CLI serve para rodar à mão, inclusive para uma data específica:

```bash
npm run snapshot -- --date 2026-08-06 --assets @programa_dotz
```

Depois é a tool `snapshot_history` que lê essa série pelo Claude.

### 4. TLS

Aponte um subdomínio para o IP da VPS, ajuste o host no
[deploy/Caddyfile](deploy/Caddyfile) e copie para `/etc/caddy/Caddyfile`. O
Caddy emite o certificado sozinho.

O `flush_interval -1` no proxy não é detalhe: sem ele o Caddy segura os eventos
SSE até o fim do stream, e consultas longas — o Meta demora vários segundos —
parecem travadas no Claude.

O processo escuta em `127.0.0.1`. Não abra a porta 8787 no firewall: sem TLS o
bearer viajaria em texto claro.

Teste antes de plugar no Claude:

```bash
curl https://mcp.exemplo.com/healthz
curl -X POST https://mcp.exemplo.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 5. Conectar o Claude Desktop de cada pessoa

Duas formas, porque a interface de conectores do Claude só tem campos de OAuth
— não há campo para um bearer fixo.

**a) Conector personalizado com `static_headers`.** É o caminho limpo: o Owner
da organização adiciona o conector uma vez em Configurações da organização, com
o header, e cada pessoa só habilita. Só que `static_headers` está em **beta** e
o credencial é único para a organização inteira — o que anula os tokens por
pessoa. Confira se sua conta tem a opção antes de contar com ela.

**b) Ponte local stdio→HTTP.** Funciona hoje, em qualquer plano, e preserva um
token por pessoa. Cada uma põe no próprio `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-business-insights": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.exemplo.com/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer SEU_TOKEN_PESSOAL"
      }
    }
  }
}
```

O `Authorization:${AUTH_HEADER}` sem espaço depois do `:` é intencional: o
Claude Desktop no Windows não escapa espaços dentro de `args` ao chamar o
`npx`, e o header chega quebrado. O espaço vai dentro da variável.

O que essa forma **não** dá: acesso pelo claude.ai ou pelo app de celular — a
ponte roda na máquina de cada pessoa. Se isso for necessário, o caminho é (a)
ou implementar OAuth.

### O que um bearer fixo não resolve

Vale ter explícito, porque é fácil descobrir tarde:

- **Sem consentimento por pessoa.** Quem tem o token tem tudo que as 9 tools
  fazem, incluindo `graph_api_get`.
- **Revogação é manual.** Sai alguém → editar `/etc/meta-mcp.env` e
  `systemctl restart meta-mcp`.
- **O token não expira sozinho.** Vale trocar periodicamente.
- **Nunca coloque o token na URL** (`?token=…`). A especificação do MCP proíbe,
  e URLs vazam em log de proxy, histórico e referrer. É por isso que aqui ele
  vai no header.

## Tools

| Tool | Para quê |
| --- | --- |
| `list_portfolio` | Lista Páginas e contas do Instagram do portfólio, com IDs e seguidores |
| `followers_overview` | Total de seguidores agora, por ativo e consolidado |
| `followers_timeseries` | Seguidores por mês/semana/dia: ganhos, perdidos, saldo e total acumulado |
| `page_insights` | Métricas de Page Insights com agregação livre |
| `instagram_insights` | Métricas de Instagram Insights com agregação livre |
| `content_insights` | Desempenho por publicação: curtidas, salvamentos, comentários, tempo de visualização |
| `content_comments` | Comentários das publicações, com filtro por palavra |
| `list_metrics` | Catálogo de métricas válidas + mapa das descontinuadas |
| `save_followers_snapshot` | Grava o total de seguidores no histórico local |
| `snapshot_history` | Lê o histórico local acumulado |
| `reply_comment` | Responde um comentário em nome da conta (exige escrita liberada) |
| `hide_comment` | Oculta ou reexibe um comentário (exige escrita liberada) |
| `graph_api_get` | GET cru na Graph API, com o Page token já resolvido |

Todas as tools de dados aceitam `assets` (IDs, nomes de Página ou `@usuario`),
`since`/`until` e `granularity`. Deixar `assets` vazio significa portfólio inteiro.

## Como os números de seguidores são obtidos

Essa é a parte que exige atenção ao ler os relatórios.

**Facebook.** A métrica `page_follows` é um snapshot diário do total acumulado, então
o total no fim de cada período vem direto da API (coluna "Fonte do total" = `API`).
Ganhos e perdas vêm de `page_daily_follows_unique` e `page_daily_unfollows_unique`.

**Instagram.** Não existe métrica de total acumulado. A API só informa quantos
seguidores entraram e saíram em cada janela (`follows_and_unfollows`). O total
histórico é **reconstruído de trás para frente** a partir do `followers_count` atual —
por isso a série é sempre buscada até hoje, mesmo quando você pede um intervalo que
termina no passado, e a coluna "Fonte do total" mostra `estimado`.

O breakdown `follow_type` dessa métrica nomeia o **estado resultante** da transição,
não quem executou a ação:

| Valor | Significa |
| --- | --- |
| `FOLLOWER` | a conta passou a seguir → **ganho** |
| `NON_FOLLOWER` | a conta deixou de seguir → **perda** |

Isso contraria o que várias fontes de terceiros afirmam (que `NON_FOLLOWER` seriam os
novos seguidores). Duas verificações independentes concordam:

1. A soma de `FOLLOWER` bate exatamente com a soma de `follower_count` — que é bruto,
   nunca negativo em nenhum dos 30 dias medidos — nas três contas testadas.
2. Numa conta do portfólio, a soma de `FOLLOWER` de jan a jul/2026 deu 5.369 —
   exatamente o número que o Business Suite reporta como seguidores ganhos no
   período.

Cuidado ao mexer em `classifyFollowType`: casar por substring quebra, porque
`NON_FOLLOWER` também contém `FOLLOWER`.

**O Business Suite reporta ganhos brutos.** No mesmo período acima, 4.208 contas
deixaram de seguir, então o crescimento líquido foi de +1.161 — não 5.369. Ao comparar
os relatórios deste servidor com a interface do Meta, compare a coluna "Ganhos", não o
"Saldo".

Consequência prática: se a conta ficou fora do ar para a API em algum período, a
reconstrução para no primeiro buraco e devolve `—` dali para trás, em vez de inventar
um número.

**Snapshots locais.** `follower_count` do Instagram só volta 30 dias e Page Insights
guarda ~2 anos. Gravando um snapshot dos totais todo dia, o portfólio acumula um
histórico próprio que não depende da janela do Meta nem das deprecações de métrica.
Veja [Snapshot diário](#snapshot-diário).

## Desempenho por publicação e comentários

`content_insights` e `content_comments` trabalham numa dimensão diferente do
resto do servidor: a linha é uma **publicação**, não um período. Por isso não
passam pela camada de agregação — o que se quer ali é ordenar e cortar ("os 10
com mais salvamentos"), não somar por mês.

**As duas redes não contam a mesma coisa.** A tabela traz um conjunto
normalizado para permitir comparação, mas com duas ressalvas que mudam a
leitura:

| Coluna | Facebook | Instagram |
| --- | --- | --- |
| Curtidas | **todas as reações** (like + amei + haha…) | curtidas |
| Salvos | não existe | `saved` |
| Views | `post_media_view` | `views` |
| Interações | soma de `post_activity_by_action_type` | `total_interactions` |

Para o detalhe cru, `sortBy` também aceita o nome original da API (`reach`,
`post_clicks`, `ig_reels_avg_watch_time`), e a métrica pedida vira uma coluna
extra. O `structuredContent` sempre traz todas as métricas brutas.

**Tempo de visualização vem em milissegundos** na Graph API, enquanto o Business
Suite mostra segundos. As colunas de tempo são convertidas na exibição — sem
isso, o relatório erraria por um fator de mil.

**Métricas por publicação não são intercambiáveis entre tipos** no Instagram: um
reel aceita `ig_reels_avg_watch_time` mas não `profile_visits`, e um post de feed
é o oposto. Pedir a métrica errada derruba o request inteiro com `(#100)`, então
as consultas são agrupadas por `media_product_type`. O Facebook é tolerante —
métrica de vídeo num post de foto volta vazia em vez de dar erro.

### Comentários

Exigem permissões que os insights não pedem: `pages_read_user_content` e
`instagram_manage_comments`. Conteúdo publicado pela marca e conteúdo escrito
por terceiros são coisas separadas para o Meta.

O Instagram informa o `@usuario` de quem comentou; o **Facebook quase sempre
não** — só perfis que consentiram ou Páginas aparecem identificados, o resto
volta sem autor. O filtro `contains` serve para rastrear um problema específico
("não consigo", "estorno", "cobrança") através de todas as publicações do
período.

## Responder e ocultar comentários

Desligado por padrão. Ligar exige **duas** condições simultâneas:

```bash
META_ALLOW_WRITES=true                      # na instância
MCP_HTTP_TOKENS=ana:3f9c…:write,bruno:a71d… # e no bearer de quem publica
```

Sem as duas, `reply_comment` e `hide_comment` nem aparecem no `tools/list` —
quem só consulta dados não enxerga as tools de publicação, em vez de vê-las e
tomar um erro. No modo stdio não há bearer, então `META_ALLOW_WRITES` decide
sozinho.

Permissões adicionais: `pages_manage_engagement` no Facebook. O Instagram usa a
mesma `instagram_manage_comments` da leitura. A task `Atividade da comunidade`
já cobre moderação.

**`reply_comment` não publica sem `confirm: true`.** Sem ele, devolve a prévia
do que seria publicado e não chama a API. A resposta é pública e imediata, e
excluir depois não desfaz quem já leu — a revisão antes é barata, o erro não.

Toda escrita bem-sucedida vira uma linha `ESCRITA` no journal, ao lado da linha
de request que identifica quem chamou.

Escritas **não têm retry** em erro de rede ou 5xx, ao contrário das leituras: um
POST que falha de forma ambígua pode ter sido processado, e repetir publicaria o
comentário duas vezes. Só há retry em rate limit, onde o Meta rejeitou
explicitamente.

O tom de voz não mora aqui. A tool publica o texto que recebe; quem redige é o
Claude, com os documentos de tom de voz como conhecimento de projeto ou Skill.
Assim cada ajuste de tom não vira deploy do servidor.

## Métricas descontinuadas

O Meta desligou `page_fans` e toda a família `impressions` em 15/11/2025, e outra leva
cai em 15/06/2026. O catálogo em `src/metrics.ts` mapeia antiga → substituta
(`page_fans` → `page_follows`, `page_impressions` → `page_media_view`,
`impressions` do Instagram → `views`), e as tools avisam quando você pede uma métrica
morta em vez de devolver um erro `#100` sem contexto.

## Limites da Graph API já tratados

Tudo abaixo foi verificado contra a API real na v26, não só lido na documentação.

- **Page Access Token.** Page e Instagram Insights recusam o token do System User
  com `(#190)`. Os tokens de cada Página são resolvidos uma vez e cacheados por 10
  minutos. No batch, o token por operação precisa ir na *query string* do
  `relative_url` — como campo do objeto da operação o Meta ignora silenciosamente.
- **`end_time` tem significados opostos nas duas superfícies.** Pedindo a mesma
  janela (01/07 a 10/07) nas duas: o Facebook devolve `end_time` de 02/07 a 11/07
  (é o limite da janela, o dia medido é `end_time - 1`); o Instagram devolve de
  01/07 a 10/07 (já é o dia medido). Aplicar o mesmo deslocamento nos dois faz
  valores vazarem para o mês anterior.
- **Quase toda métrica do Instagram é `total_value`-only.** Só `reach` e
  `follower_count` aceitam `time_series`; as demais devolvem um único número por
  janela. Por isso as consultas do Instagram fazem uma chamada por período do
  relatório — se a janela cruzasse a fronteira do mês, o valor inteiro cairia em um
  só lado. Consultas que exigiriam mais de 600 chamadas são recusadas com uma
  mensagem explicando como reduzir o recorte.
- **Janela máxima por request**: 93 dias em Page Insights, 30 dias no Instagram
  (`(#100) There cannot be more than 30 days between since and until`). As
  consultas são fatiadas e recombinadas automaticamente.
- **Uma métrica inválida não derruba as outras.** Se um request com várias métricas
  falha, o servidor refaz aquela janela métrica a métrica: as válidas retornam
  normalmente e a inválida vira aviso.
- Requests são agrupados em batches de 50 — o erro de uma conta não afeta as demais.
- Rate limit (códigos 4, 17, 32, 613, 80000+) tem retry com backoff exponencial.
- Os dados dos últimos ~2 dias costumam voltar zerados: é a latência de consolidação
  do próprio Meta, não uma falha do servidor.
