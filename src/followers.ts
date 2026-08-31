/**
 * Série histórica de seguidores por período — orgânico + pago somados.
 *
 * O MCP de Meta Ads só enxerga os seguidores atribuídos a campanhas. Aqui a
 * base é o número real da conta, que inclui crescimento orgânico.
 *
 * Facebook expõe `page_follows`, um snapshot diário do total acumulado, então
 * o total no fim de cada mês vem direto da API.
 *
 * Instagram não tem equivalente: só dá para saber quantos seguidores foram
 * ganhos e perdidos em cada janela (`follows_and_unfollows`). O total histórico
 * é então reconstruído de trás para frente a partir do `followers_count` de
 * hoje — por isso a série é sempre buscada até a data atual, mesmo quando o
 * usuário pede um intervalo que termina no passado.
 */

import type { GraphClient } from "./graph/client.js";
import type { PageAsset } from "./graph/assets.js";
import {
  addDays,
  buildBuckets,
  chunkRange,
  today,
  unix,
  type Bucket,
  type Granularity,
} from "./dates.js";
import { IG_MAX_WINDOW_DAYS, PAGE_MAX_WINDOW_DAYS, type FetchIssue } from "./graph/insights.js";

export interface FollowerRow {
  period: string;
  surface: "facebook" | "instagram";
  assetId: string;
  assetName: string;
  gained: number | null;
  lost: number | null;
  net: number | null;
  /** Total de seguidores no fim do período. */
  total: number | null;
  /** true quando o total foi reconstruído a partir do valor atual. */
  totalIsEstimated: boolean;
}

export interface FollowerSeriesResult {
  rows: FollowerRow[];
  issues: FetchIssue[];
  /** Totais atuais por ativo, direto do nó (fonte de verdade). */
  currentTotals: Array<{
    surface: "facebook" | "instagram";
    assetId: string;
    assetName: string;
    followers: number | null;
  }>;
}

interface RawInsightResponse {
  data: Array<{
    name: string;
    period: string;
    values?: Array<{ value: unknown; end_time?: string }>;
    total_value?: {
      value?: number;
      breakdowns?: Array<{
        dimension_keys: string[];
        /** Ausente quando a janela ainda não tem dados (ex.: o dia de hoje). */
        results?: Array<{ dimension_values: string[]; value: number }>;
      }>;
    };
  }>;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Menor sub-janela que cabe no limite da API, alinhada ao bucket. */
function bucketWindows(bucket: Bucket, maxDays: number) {
  return chunkRange(bucket.start, bucket.end, maxDays);
}

export interface FollowerQuery {
  since: string;
  until: string;
  granularity: Granularity;
}

export async function fetchFollowerSeries(
  client: GraphClient,
  pages: PageAsset[],
  query: FollowerQuery,
  fallbackToken: string,
): Promise<FollowerSeriesResult> {
  const issues: FetchIssue[] = [];
  const now = today();
  // A reconstrução do Instagram exige cobrir tudo até hoje.
  const extendedUntil = query.until > now ? query.until : now;
  const buckets = buildBuckets(query.since, extendedUntil, query.granularity);
  const requestedLabels = new Set(
    buildBuckets(query.since, query.until, query.granularity).map((b) => b.label),
  );

  const [fb, ig] = await Promise.all([
    fetchFacebookFollowers(client, pages, buckets, fallbackToken, issues),
    fetchInstagramFollowers(client, pages, buckets, fallbackToken, issues),
  ]);

  const rows = [...fb, ...ig]
    .filter((row) => requestedLabels.has(row.period))
    .sort(
      (a, b) =>
        a.period.localeCompare(b.period) ||
        a.assetName.localeCompare(b.assetName),
    );

  const currentTotals = pages.flatMap((page) => {
    const entries: FollowerSeriesResult["currentTotals"] = [
      {
        surface: "facebook" as const,
        assetId: page.id,
        assetName: page.name,
        followers: page.followersCount ?? null,
      },
    ];
    if (page.instagram) {
      entries.push({
        surface: "instagram",
        assetId: page.instagram.id,
        assetName: page.instagram.username
          ? `@${page.instagram.username}`
          : (page.instagram.name ?? page.instagram.id),
        followers: page.instagram.followersCount ?? null,
      });
    }
    return entries;
  });

  return { rows, issues, currentTotals };
}

/* ------------------------------- Facebook -------------------------------- */

async function fetchFacebookFollowers(
  client: GraphClient,
  pages: PageAsset[],
  buckets: Bucket[],
  fallbackToken: string,
  issues: FetchIssue[],
): Promise<FollowerRow[]> {
  if (pages.length === 0 || buckets.length === 0) return [];

  const start = buckets[0]!.start;
  const end = buckets[buckets.length - 1]!.end;
  const windows = chunkRange(start, end, PAGE_MAX_WINDOW_DAYS);

  const requests = pages.flatMap((page) =>
    windows.map((window) => ({
      page,
      req: {
        path: `/${page.id}/insights`,
        params: {
          metric: "page_follows,page_daily_follows_unique,page_daily_unfollows_unique",
          period: "day",
          since: window.start,
          until: addDays(window.end, 1),
        },
        token: page.accessToken ?? fallbackToken,
      },
    })),
  );

  const responses = await client.batchGet<RawInsightResponse>(
    requests.map((r) => r.req),
  );

  // pageId -> métrica -> dia -> valor
  const daily = new Map<string, Map<string, Map<string, number>>>();

  responses.forEach((res, i) => {
    const page = requests[i]!.page;
    if (!res.ok) {
      issues.push({
        assetId: page.id,
        assetName: page.name,
        surface: "facebook",
        message: res.error.message,
      });
      return;
    }
    const byMetric = daily.get(page.id) ?? new Map<string, Map<string, number>>();
    daily.set(page.id, byMetric);

    for (const insight of res.data.data ?? []) {
      const series = byMetric.get(insight.name) ?? new Map<string, number>();
      byMetric.set(insight.name, series);
      for (const entry of insight.values ?? []) {
        const value = num(entry.value);
        if (value === undefined || !entry.end_time) continue;
        series.set(addDays(entry.end_time.slice(0, 10), -1), value);
      }
    }
  });

  const rows: FollowerRow[] = [];

  for (const page of pages) {
    const byMetric = daily.get(page.id);
    const totals = byMetric?.get("page_follows");
    const adds = byMetric?.get("page_daily_follows_unique");
    const removes = byMetric?.get("page_daily_unfollows_unique");

    const perBucket = buckets.map((bucket) => {
      const gained = sumRange(adds, bucket);
      const lost = sumRange(removes, bucket);
      const total = lastInRange(totals, bucket);
      return { bucket, gained, lost, total };
    });

    // Sem page_follows (métrica pode falhar por permissão), reconstrói do total atual.
    const anyTotal = perBucket.some((b) => b.total !== null);
    const reconstructed = anyTotal
      ? null
      : reconstructTotals(
          perBucket.map((b) => netOf(b.gained, b.lost)),
          page.followersCount ?? null,
        );

    perBucket.forEach((entry, i) => {
      rows.push({
        period: entry.bucket.label,
        surface: "facebook",
        assetId: page.id,
        assetName: page.name,
        gained: entry.gained,
        lost: entry.lost,
        net: netOf(entry.gained, entry.lost),
        total: anyTotal ? entry.total : (reconstructed?.[i] ?? null),
        totalIsEstimated: !anyTotal,
      });
    });
  }

  return rows;
}

/* ------------------------------- Instagram ------------------------------- */

async function fetchInstagramFollowers(
  client: GraphClient,
  pages: PageAsset[],
  buckets: Bucket[],
  fallbackToken: string,
  issues: FetchIssue[],
): Promise<FollowerRow[]> {
  const igPages = pages.filter((p) => p.instagram);
  if (igPages.length === 0 || buckets.length === 0) return [];

  interface IgRequest {
    page: PageAsset;
    bucketIndex: number;
  }

  const meta: IgRequest[] = [];
  const requests: Array<{
    path: string;
    params: Record<string, string | number>;
    token?: string;
  }> = [];

  buckets.forEach((bucket, bucketIndex) => {
    for (const page of igPages) {
      for (const window of bucketWindows(bucket, IG_MAX_WINDOW_DAYS)) {
        meta.push({ page, bucketIndex });
        requests.push({
          path: `/${page.instagram!.id}/insights`,
          params: {
            metric: "follows_and_unfollows",
            metric_type: "total_value",
            period: "day",
            breakdown: "follow_type",
            since: unix(window.start),
            until: unix(addDays(window.end, 1)),
          },
          token: page.accessToken ?? fallbackToken,
        });
      }
    }
  });

  const responses = await client.batchGet<RawInsightResponse>(requests);

  // igId -> bucketIndex -> { gained, lost }
  const acc = new Map<string, Map<number, { gained: number; lost: number }>>();
  const failed = new Set<string>();

  responses.forEach((res, i) => {
    const { page, bucketIndex } = meta[i]!;
    const ig = page.instagram!;
    if (!res.ok) {
      if (!failed.has(ig.id)) {
        failed.add(ig.id);
        issues.push({
          assetId: ig.id,
          assetName: igLabel(page),
          surface: "instagram",
          metric: "follows_and_unfollows",
          message: res.error.message,
        });
      }
      return;
    }

    const byBucket = acc.get(ig.id) ?? new Map();
    acc.set(ig.id, byBucket);
    const slot = byBucket.get(bucketIndex) ?? { gained: 0, lost: 0 };
    byBucket.set(bucketIndex, slot);

    for (const insight of res.data.data ?? []) {
      for (const bd of insight.total_value?.breakdowns ?? []) {
        for (const result of bd.results ?? []) {
          const bucket = classifyFollowType(result.dimension_values[0]);
          if (bucket === "gained") slot.gained += result.value;
          else if (bucket === "lost") slot.lost += result.value;
        }
      }
    }
  });

  const rows: FollowerRow[] = [];

  for (const page of igPages) {
    const ig = page.instagram!;
    const byBucket = acc.get(ig.id);
    if (!byBucket) continue;

    const nets = buckets.map((_, i) => {
      const slot = byBucket.get(i);
      return slot ? slot.gained - slot.lost : null;
    });
    const totals = reconstructTotals(nets, ig.followersCount ?? null);

    buckets.forEach((bucket, i) => {
      const slot = byBucket.get(i);
      rows.push({
        period: bucket.label,
        surface: "instagram",
        assetId: ig.id,
        assetName: igLabel(page),
        gained: slot ? slot.gained : null,
        lost: slot ? slot.lost : null,
        net: nets[i] ?? null,
        total: totals?.[i] ?? null,
        totalIsEstimated: true,
      });
    });
  }

  return rows;
}

/**
 * O breakdown `follow_type` de `follows_and_unfollows` nomeia o *estado
 * resultante* da transição, não quem executou a ação:
 *
 *   FOLLOWER      → a conta passou a seguir  (ganho)
 *   NON_FOLLOWER  → a conta deixou de seguir (perda)
 *
 * Confirmado empiricamente: a soma de `FOLLOWER` bate exatamente com a soma de
 * `follower_count` (novos seguidores por dia, nunca negativo) na mesma janela.
 * Cuidado ao mexer aqui: casar por substring quebra, porque "NON_FOLLOWER"
 * também contém "FOLLOWER".
 */
function classifyFollowType(value: string | undefined): "gained" | "lost" | undefined {
  switch ((value ?? "").toUpperCase()) {
    case "FOLLOWER":
    case "FOLLOWS":
      return "gained";
    case "NON_FOLLOWER":
    case "UNFOLLOWS":
      return "lost";
    default:
      return undefined;
  }
}

function igLabel(page: PageAsset): string {
  const ig = page.instagram!;
  return ig.username ? `@${ig.username}` : (ig.name ?? ig.id);
}

/* -------------------------------- Helpers -------------------------------- */

function sumRange(
  series: Map<string, number> | undefined,
  bucket: Bucket,
): number | null {
  if (!series) return null;
  let sum = 0;
  let seen = false;
  for (const [date, value] of series) {
    if (date >= bucket.start && date <= bucket.end) {
      sum += value;
      seen = true;
    }
  }
  return seen ? sum : null;
}

function lastInRange(
  series: Map<string, number> | undefined,
  bucket: Bucket,
): number | null {
  if (!series) return null;
  let bestDate = "";
  let bestValue: number | null = null;
  for (const [date, value] of series) {
    if (date >= bucket.start && date <= bucket.end && date > bestDate) {
      bestDate = date;
      bestValue = value;
    }
  }
  return bestValue;
}

function netOf(gained: number | null, lost: number | null): number | null {
  if (gained === null && lost === null) return null;
  return (gained ?? 0) - (lost ?? 0);
}

/**
 * Reconstrói o total ao fim de cada bucket a partir do total atual, andando
 * de trás para frente: total[i] = atual - soma(net dos buckets posteriores).
 * Retorna null nas posições onde falta net para fechar a conta.
 */
function reconstructTotals(
  nets: Array<number | null>,
  currentTotal: number | null,
): Array<number | null> | null {
  if (currentTotal === null) return null;
  const totals: Array<number | null> = new Array(nets.length).fill(null);
  let running = currentTotal;
  let broken = false;

  for (let i = nets.length - 1; i >= 0; i--) {
    if (broken) continue;
    totals[i] = running;
    const net = nets[i];
    if (net === null || net === undefined) {
      broken = true;
      continue;
    }
    running -= net;
  }

  return totals;
}
