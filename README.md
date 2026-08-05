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

`pages_read_engagement`, `pages_show_list`, `read_insights`, `instagram_basic`,
`instagram_manage_insights` e `business_management`.

Valide tudo antes de plugar no Claude:

```bash
npm run probe
```

O probe imprime o portfólio descoberto, avisa quais páginas estão sem Page Access
Token e puxa 4 meses de seguidores como amostra.

## Configuração no Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-business-insights": {
      "command": "node",
      "args": ["/Users/kenji/Repositories/meta-business-insights-mcp/dist/index.js"],
      "env": {
        "META_ACCESS_TOKEN": "SEU_TOKEN",
        "META_BUSINESS_ID": "SEU_BUSINESS_ID"
      }
    }
  }
}
```

Reinicie o Claude Desktop depois de salvar.

## Tools

| Tool | Para quê |
| --- | --- |
| `list_portfolio` | Lista Páginas e contas do Instagram do portfólio, com IDs e seguidores |
| `followers_overview` | Total de seguidores agora, por ativo e consolidado |
| `followers_timeseries` | Seguidores por mês/semana/dia: ganhos, perdidos, saldo e total acumulado |
| `page_insights` | Métricas de Page Insights com agregação livre |
| `instagram_insights` | Métricas de Instagram Insights com agregação livre |
| `list_metrics` | Catálogo de métricas válidas + mapa das descontinuadas |
| `save_followers_snapshot` | Grava o total de seguidores no histórico local |
| `snapshot_history` | Lê o histórico local acumulado |
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
novos seguidores). A verificação: a soma de `FOLLOWER` bate **exatamente** com a soma
de `follower_count` — que é bruto, nunca negativo em nenhum dos 30 dias medidos — nas
três contas testadas. Cuidado ao mexer em `classifyFollowType`: casar por substring
quebra, porque `NON_FOLLOWER` também contém `FOLLOWER`.

Consequência prática: se a conta ficou fora do ar para a API em algum período, a
reconstrução para no primeiro buraco e devolve `—` dali para trás, em vez de inventar
um número.

**Snapshots locais.** `follower_count` do Instagram só volta 30 dias e Page Insights
guarda ~2 anos. Rodando `save_followers_snapshot` periodicamente (um cron, ou um
`/loop` no Claude Code), o portfólio acumula um histórico próprio que não depende da
janela do Meta nem das deprecações de métrica.

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
