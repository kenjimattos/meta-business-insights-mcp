/**
 * Publicações e seus insights — o equivalente à aba "Conteúdo" do Business Suite.
 *
 * Difere do resto do servidor numa coisa estrutural: aqui a linha é uma
 * *publicação*, não um período. Por isso não passa pela camada de agregação —
 * o que se quer é ordenar e cortar ("os 10 posts com mais salvamentos"), não
 * somar por mês.
 *
 * As duas redes contam interação de forma diferente, então além das métricas
 * cruas o módulo devolve um conjunto normalizado (`views`, `likes`, `comments`,
 * `shares`, `saved`, `interactions`) que permite comparar as duas numa tabela
 * só. Onde a tradução não é exata, o comentário no código diz o que foi feito.
 */

import type { GraphClient } from "./graph/client.js";
import type { PageAsset } from "./graph/assets.js";
import { FB_POST_METRICS, igMediaMetricsFor } from "./metrics.js";
import { addDays, unix } from "./dates.js";

export type Surface = "facebook" | "instagram";

export interface ContentRow {
  surface: Surface;
  assetId: string;
  assetName: string;
  postId: string;
  /** YYYY-MM-DD em UTC. */
  date: string;
  /** added_video, added_photos (FB) ou REELS, FEED (IG). */
  type: string;
  caption: string;
  permalink?: string;
  /** Conjunto comparável entre as redes. */
  normalized: Record<string, number>;
  /** Nomes originais da Graph API, para quem quiser o detalhe. */
  raw: Record<string, number>;
  /** Reações por tipo (só Facebook). */
  reactionsByType?: Record<string, number>;
}

export interface ContentIssue {
  asset: string;
  detail: string;
}

interface Collected {
  rows: ContentRow[];
  issues: ContentIssue[];
}

/**
 * Teto de páginas por ativo. Uma conta que publica diariamente gera ~30 itens
 * por mês; 20 páginas de 50 cobrem anos. O limite existe para que um intervalo
 * digitado errado não vire centenas de requisições.
 */
const MAX_PAGES = 20;
const PAGE_SIZE = 50;

const FB_FIELDS =
  "id,created_time,message,story,permalink_url,status_type,shares," +
  "comments.summary(true).limit(0),reactions.summary(true).limit(0)";
const IG_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp";

export async function fetchContent(
  client: GraphClient,
  pages: PageAsset[],
  range: { since: string; until: string },
  surfaces: Surface[],
): Promise<Collected> {
  const rows: ContentRow[] = [];
  const issues: ContentIssue[] = [];

  for (const page of pages) {
    if (surfaces.includes("facebook")) {
      try {
        rows.push(...(await facebookRows(client, page, range, issues)));
      } catch (err) {
        issues.push({ asset: page.name, detail: describe(err) });
      }
    }
    if (surfaces.includes("instagram") && page.instagram) {
      const label = igLabel(page);
      try {
        rows.push(...(await instagramRows(client, page, range, issues)));
      } catch (err) {
        issues.push({ asset: label, detail: describe(err) });
      }
    }
  }

  return { rows, issues };
}

/* -------------------------------- Facebook -------------------------------- */

interface RawPost {
  id: string;
  created_time?: string;
  message?: string;
  story?: string;
  permalink_url?: string;
  status_type?: string;
  shares?: { count?: number };
  comments?: { summary?: { total_count?: number } };
  reactions?: { summary?: { total_count?: number } };
}

async function facebookRows(
  client: GraphClient,
  page: PageAsset,
  range: { since: string; until: string },
  issues: ContentIssue[],
): Promise<ContentRow[]> {
  const posts = await paginate<RawPost>(
    client,
    `/${page.id}/feed`,
    FB_FIELDS,
    page.accessToken,
    range,
    (p) => p.created_time,
  );
  if (posts.length === 0) return [];

  const results = await client.batchGet<{ data?: InsightEntry[] }>(
    posts.map((post) => ({
      path: `/${post.id}/insights`,
      params: { metric: FB_POST_METRICS.join(",") },
      token: page.accessToken,
    })),
  );

  return posts.map((post, i) => {
    const result = results[i];
    let raw: Record<string, number> = {};
    let reactionsByType: Record<string, number> | undefined;
    // Somar post_activity_by_action_type dá o total de interações do post, que
    // é o análogo do total_interactions do Instagram.
    let activity: Record<string, number> | undefined;

    if (result?.ok) {
      const parsed = parseInsights(result.data.data ?? []);
      raw = parsed.numbers;
      reactionsByType = parsed.objects["post_reactions_by_type_total"];
      activity = parsed.objects["post_activity_by_action_type"];
    } else if (result && !result.ok) {
      issues.push({ asset: page.name, detail: `${post.id}: ${result.error.message}` });
    }

    const normalized: Record<string, number> = {
      views: raw["post_media_view"] ?? 0,
      // "likes" aqui é o total de *reações* (like + amei + haha…). O Facebook
      // não separa a curtida clássica num contador próprio no feed.
      likes: post.reactions?.summary?.total_count ?? 0,
      comments: post.comments?.summary?.total_count ?? 0,
      shares: post.shares?.count ?? 0,
      interactions: activity
        ? Object.values(activity).reduce((a, b) => a + b, 0)
        : (post.reactions?.summary?.total_count ?? 0) +
          (post.comments?.summary?.total_count ?? 0) +
          (post.shares?.count ?? 0),
    };

    return {
      surface: "facebook" as const,
      assetId: page.id,
      assetName: page.name,
      postId: post.id,
      date: (post.created_time ?? "").slice(0, 10),
      type: post.status_type ?? "?",
      caption: clean(post.message ?? post.story ?? ""),
      permalink: post.permalink_url,
      normalized,
      raw,
      reactionsByType,
    };
  });
}

/* -------------------------------- Instagram ------------------------------- */

interface RawMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
}

async function instagramRows(
  client: GraphClient,
  page: PageAsset,
  range: { since: string; until: string },
  issues: ContentIssue[],
): Promise<ContentRow[]> {
  const ig = page.instagram!;
  const label = igLabel(page);
  const media = await paginate<RawMedia>(
    client,
    `/${ig.id}/media`,
    IG_FIELDS,
    page.accessToken,
    range,
    (m) => m.timestamp,
  );
  if (media.length === 0) return [];

  // Agrupado por tipo porque cada um aceita um conjunto de métricas diferente.
  const byType = new Map<string, RawMedia[]>();
  for (const item of media) {
    const type = item.media_product_type ?? "";
    const list = byType.get(type);
    if (list) list.push(item);
    else byType.set(type, [item]);
  }

  const rows: ContentRow[] = [];

  for (const [type, items] of byType) {
    const results = await client.batchGet<{ data?: InsightEntry[] }>(
      items.map((item) => ({
        path: `/${item.id}/insights`,
        params: { metric: igMediaMetricsFor(type).join(",") },
        token: page.accessToken,
      })),
    );

    items.forEach((item, i) => {
      const result = results[i];
      let raw: Record<string, number> = {};
      if (result?.ok) {
        raw = parseInsights(result.data.data ?? []).numbers;
      } else if (result && !result.ok) {
        issues.push({ asset: label, detail: `${item.id}: ${result.error.message}` });
      }

      rows.push({
        surface: "instagram",
        assetId: ig.id,
        assetName: label,
        postId: item.id,
        date: (item.timestamp ?? "").slice(0, 10),
        type: item.media_product_type ?? item.media_type ?? "?",
        caption: clean(item.caption ?? ""),
        permalink: item.permalink,
        normalized: {
          views: raw["views"] ?? 0,
          likes: raw["likes"] ?? 0,
          comments: raw["comments"] ?? 0,
          shares: raw["shares"] ?? 0,
          saved: raw["saved"] ?? 0,
          interactions: raw["total_interactions"] ?? 0,
        },
        raw,
      });
    });
  }

  return rows;
}

/* --------------------------------- comuns --------------------------------- */

/**
 * Pagina do mais recente para trás e para ao passar da data inicial.
 *
 * Manda `since`/`until` para a API e *também* filtra no cliente. A redundância
 * é intencional: se a edge ignorar os parâmetros, o corte por data ainda
 * devolve o resultado certo — só ao custo de páginas extras.
 */
async function paginate<T>(
  client: GraphClient,
  path: string,
  fields: string,
  token: string | undefined,
  range: { since: string; until: string },
  dateOf: (item: T) => string | undefined,
): Promise<T[]> {
  const collected: T[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      fields,
      limit: String(PAGE_SIZE),
      since: String(unix(range.since)),
      // `until` é inclusivo para quem pergunta; para a API é um instante.
      until: String(unix(addDays(range.until, 1)) - 1),
    };
    if (after) params.after = after;

    const response = await client.get<{
      data?: T[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(path, params, { token });

    const batch = response.data ?? [];
    if (batch.length === 0) break;

    let passedStart = false;
    for (const item of batch) {
      const date = (dateOf(item) ?? "").slice(0, 10);
      if (!date) continue;
      if (date < range.since) {
        passedStart = true;
        continue;
      }
      if (date > range.until) continue;
      collected.push(item);
    }

    if (passedStart || !response.paging?.next) break;
    after = response.paging.cursors?.after;
    if (!after) break;
  }

  return collected;
}

interface InsightEntry {
  name: string;
  values?: Array<{ value?: unknown }>;
}

/** Separa os valores escalares dos que vêm como mapa (reações por tipo etc.). */
function parseInsights(entries: InsightEntry[]): {
  numbers: Record<string, number>;
  objects: Record<string, Record<string, number>>;
} {
  const numbers: Record<string, number> = {};
  const objects: Record<string, Record<string, number>> = {};

  for (const entry of entries) {
    const value = entry.values?.[0]?.value;
    if (typeof value === "number") {
      numbers[entry.name] = value;
    } else if (value && typeof value === "object") {
      const map: Record<string, number> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "number") map[k] = v;
      }
      objects[entry.name] = map;
      // Um mapa também vira escalar pela soma, para poder ordenar por ele.
      numbers[entry.name] = Object.values(map).reduce((a, b) => a + b, 0);
    }
  }

  return { numbers, objects };
}

function igLabel(page: PageAsset): string {
  const ig = page.instagram!;
  return ig.username ? `@${ig.username}` : (ig.name ?? ig.id);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
