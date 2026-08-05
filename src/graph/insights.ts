/**
 * Leitura de insights orgânicos de Facebook Pages e contas do Instagram.
 *
 * Três particularidades da Graph API estão encapsuladas aqui:
 *
 * 1. `end_time` significa coisas diferentes nas duas superfícies — ver
 *    measuredDate(). Ignorar isso desloca a série do Instagram em um dia.
 * 2. As janelas máximas por request diferem: Page Insights aceita ~93 dias,
 *    Instagram apenas 30.
 * 3. Quase toda métrica do Instagram só existe como `total_value`, devolvendo
 *    um número por janela em vez de série diária — ver fetchInstagramInsights.
 */

import type { GraphClient } from "./client.js";
import { GraphError } from "./client.js";
import type { PageAsset } from "./assets.js";
import { addDays, buildBuckets, chunkRange, unix, type Granularity } from "../dates.js";
import { IG_REQUIRES_TIMEFRAME, IG_TIME_SERIES_METRICS } from "../metrics.js";

type BatchOutcome = {
  results: Array<
    { ok: true; data: { data: RawInsight[] } } | { ok: false; error: GraphError }
  >;
  perMetricErrors: Array<{ index: number; metric: string; error: GraphError }>;
};

export const PAGE_MAX_WINDOW_DAYS = 90;
/** Ver measuredDate(): Facebook nomeia o limite da janela, Instagram o próprio dia. */
const PAGE_END_TIME_SHIFT = -1;
const IG_END_TIME_SHIFT = 0;
export const IG_MAX_WINDOW_DAYS = 30;

export interface SeriesPoint {
  date: string;
  value: number;
  breakdown?: Record<string, string>;
}

export interface MetricSeries {
  assetId: string;
  assetName: string;
  surface: "facebook" | "instagram";
  metric: string;
  period: string;
  points: SeriesPoint[];
}

export interface FetchIssue {
  assetId: string;
  assetName: string;
  surface: "facebook" | "instagram";
  metric?: string;
  message: string;
}

export interface FetchResult {
  series: MetricSeries[];
  issues: FetchIssue[];
}

interface RawInsight {
  name: string;
  period: string;
  values?: Array<{ value: unknown; end_time?: string }>;
  total_value?: {
    value?: number;
    breakdowns?: Array<{
      dimension_keys: string[];
      results: Array<{ dimension_values: string[]; value: number }>;
    }>;
  };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * end_time -> dia efetivamente medido.
 *
 * As duas superfícies usam convenções opostas, verificado contra a API pedindo
 * a mesma janela (2026-07-01 a 2026-07-10) nas duas:
 *
 *   Facebook  → end_time começa em since+1 (07-02…07-11): é o *limite* da
 *               janela, então o dia medido é end_time - 1.
 *   Instagram → end_time começa em since   (07-01…07-10): já é o dia medido.
 *
 * Aplicar o mesmo deslocamento nos dois joga a série do Instagram um dia para
 * trás, o que faz valores vazarem para o mês anterior no relatório.
 */
function measuredDate(
  endTime: string | undefined,
  fallback: string,
  shiftDays: number,
): string {
  if (!endTime) return fallback;
  return shiftDays === 0 ? endTime.slice(0, 10) : addDays(endTime.slice(0, 10), shiftDays);
}

function toPoints(raw: RawInsight, windowEnd: string, shiftDays: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];

  for (const entry of raw.values ?? []) {
    const date = measuredDate(entry.end_time, windowEnd, shiftDays);
    const flat = numeric(entry.value);
    if (flat !== undefined) {
      points.push({ date, value: flat });
      continue;
    }
    // Métricas com breakdown chegam como objeto { chave: número }.
    if (entry.value && typeof entry.value === "object") {
      for (const [key, val] of Object.entries(entry.value as Record<string, unknown>)) {
        const n = numeric(val);
        if (n !== undefined) {
          points.push({ date, value: n, breakdown: { [raw.name]: key } });
        }
      }
    }
  }

  if (raw.total_value) {
    const { value, breakdowns } = raw.total_value;
    if (typeof value === "number") {
      points.push({ date: windowEnd, value });
    }
    for (const bd of breakdowns ?? []) {
      for (const result of bd.results) {
        const dims: Record<string, string> = {};
        bd.dimension_keys.forEach((key, i) => {
          dims[key] = result.dimension_values[i] ?? "";
        });
        points.push({ date: windowEnd, value: result.value, breakdown: dims });
      }
    }
  }

  return points;
}

function mergeSeries(target: Map<string, MetricSeries>, series: MetricSeries): void {
  const key = `${series.surface}:${series.assetId}:${series.metric}`;
  const existing = target.get(key);
  if (existing) {
    existing.points.push(...series.points);
  } else {
    target.set(key, series);
  }
}

export interface PageInsightsQuery {
  metrics: string[];
  since: string;
  until: string;
  period?: "day" | "week" | "days_28";
}

/** Insights de Facebook Pages para vários ativos, em paralelo por janela. */
export async function fetchPageInsights(
  client: GraphClient,
  pages: PageAsset[],
  query: PageInsightsQuery,
  fallbackToken: string,
): Promise<FetchResult> {
  const period = query.period ?? "day";
  const windows = chunkRange(query.since, query.until, PAGE_MAX_WINDOW_DAYS);
  const issues: FetchIssue[] = [];
  const merged = new Map<string, MetricSeries>();

  const requests: Array<{
    path: string;
    params: Record<string, string | number>;
    token: string;
    page: PageAsset;
    windowEnd: string;
    metrics: string[];
  }> = [];

  for (const page of pages) {
    for (const window of windows) {
      requests.push({
        path: `/${page.id}/insights`,
        params: {
          metric: query.metrics.join(","),
          period,
          // Page Insights precisa de until exclusivo para incluir o último dia.
          since: window.start,
          until: addDays(window.end, 1),
        },
        token: page.accessToken ?? fallbackToken,
        page,
        windowEnd: window.end,
        metrics: query.metrics,
      });
    }
  }

  const { results: responses, perMetricErrors } = await executeWithPerMetricFallback(
    client,
    requests,
  );

  const reported = new Set<string>();
  for (const { index, metric, error } of perMetricErrors) {
    const req = requests[index]!;
    const key = `${req.page.id}|${metric}`;
    if (reported.has(key)) continue;
    reported.add(key);
    issues.push({
      assetId: req.page.id,
      assetName: req.page.name,
      surface: "facebook",
      metric,
      message: error.isInvalidMetric
        ? `${error.message} — a métrica pode ter sido descontinuada; veja list_metrics.`
        : error.message,
    });
  }

  responses.forEach((res, i) => {
    const req = requests[i]!;
    if (!res.ok) {
      if (!req.metrics.every((m) => reported.has(`${req.page.id}|${m}`))) {
        issues.push({
          assetId: req.page.id,
          assetName: req.page.name,
          surface: "facebook",
          metric: req.metrics.join(","),
          message: res.error.isInvalidMetric
            ? `${res.error.message} — a métrica pode ter sido descontinuada; veja list_metrics.`
            : res.error.message,
        });
      }
      return;
    }
    for (const raw of res.data.data ?? []) {
      mergeSeries(merged, {
        assetId: req.page.id,
        assetName: req.page.name,
        surface: "facebook",
        metric: raw.name,
        period: raw.period,
        points: toPoints(raw, req.windowEnd, PAGE_END_TIME_SHIFT),
      });
    }
  });

  return { series: dedupe([...merged.values()]), issues };
}

export interface IgInsightsQuery {
  metrics: string[];
  since: string;
  until: string;
  /** Necessária porque métricas total_value exigem uma chamada por período. */
  granularity: Granularity;
  breakdown?: string;
  timeframe?: string;
}

/** Teto de requisições por consulta, para não estourar rate limit sem querer. */
const MAX_IG_REQUESTS = 600;

/** Insights de contas do Instagram para vários ativos. */
export async function fetchInstagramInsights(
  client: GraphClient,
  pages: PageAsset[],
  query: IgInsightsQuery,
  fallbackToken: string,
): Promise<FetchResult> {
  const issues: FetchIssue[] = [];
  const merged = new Map<string, MetricSeries>();

  // No v26 quase toda métrica do Instagram é total_value-only: apenas `reach` e
  // `follower_count` aceitam time_series. Métricas total_value devolvem um único
  // número por janela, então a janela precisa coincidir com o bucket do
  // relatório — caso contrário o valor de uma janela a cavalo entre dois meses
  // seria atribuído inteiro a um deles.
  const demographic = query.metrics.filter((m) => IG_REQUIRES_TIMEFRAME.has(m));
  const timeSeries = query.metrics.filter(
    (m) => !IG_REQUIRES_TIMEFRAME.has(m) && IG_TIME_SERIES_METRICS.has(m),
  );
  const totalValue = query.metrics.filter(
    (m) => !IG_REQUIRES_TIMEFRAME.has(m) && !IG_TIME_SERIES_METRICS.has(m),
  );

  interface IgReq {
    path: string;
    params: Record<string, string | number>;
    token: string;
    igId: string;
    igName: string;
    windowEnd: string;
    metrics: string[];
  }

  const requests: IgReq[] = [];
  const buckets = buildBuckets(query.since, query.until, query.granularity);

  for (const page of pages) {
    if (!page.instagram) continue;
    const ig = page.instagram;
    const igName = ig.username ? `@${ig.username}` : (ig.name ?? ig.id);
    const token = page.accessToken ?? fallbackToken;

    const base = (metrics: string[], metricType: string, start: string, end: string) => {
      const params: Record<string, string | number> = {
        metric: metrics.join(","),
        period: "day",
        metric_type: metricType,
        since: unix(start),
        until: unix(addDays(end, 1)),
      };
      if (query.breakdown) params.breakdown = query.breakdown;
      return {
        path: `/${ig.id}/insights`,
        params,
        token,
        igId: ig.id,
        igName,
        windowEnd: end,
        metrics,
      };
    };

    if (timeSeries.length > 0) {
      for (const window of chunkRange(query.since, query.until, IG_MAX_WINDOW_DAYS)) {
        requests.push(base(timeSeries, "time_series", window.start, window.end));
      }
    }

    if (totalValue.length > 0) {
      for (const bucket of buckets) {
        for (const window of chunkRange(bucket.start, bucket.end, IG_MAX_WINDOW_DAYS)) {
          requests.push(base(totalValue, "total_value", window.start, window.end));
        }
      }
    }

    if (demographic.length > 0) {
      const req = base(demographic, "total_value", query.since, query.until);
      req.params.timeframe = query.timeframe ?? "this_month";
      delete req.params.since;
      delete req.params.until;
      requests.push(req);
    }
  }

  if (requests.length > MAX_IG_REQUESTS) {
    throw new Error(
      `A consulta exigiria ${requests.length} chamadas à Graph API (limite ${MAX_IG_REQUESTS}). ` +
        `Métricas total_value do Instagram precisam de uma chamada por período, por conta. ` +
        `Reduza o intervalo, use granularidade maior (month em vez de day), ` +
        `menos métricas ou menos contas.`,
    );
  }

  const { results: responses, perMetricErrors } = await executeWithPerMetricFallback(
    client,
    requests,
  );

  // Uma métrica que falhou sozinha no retry vira aviso, sem descartar as outras.
  const reported = new Set<string>();
  for (const { index, metric, error } of perMetricErrors) {
    const req = requests[index]!;
    const key = `${req.igId}|${metric}`;
    if (reported.has(key)) continue;
    reported.add(key);
    issues.push({
      assetId: req.igId,
      assetName: req.igName,
      surface: "instagram",
      metric,
      message: error.message,
    });
  }

  responses.forEach((res, i) => {
    const req = requests[i]!;
    if (!res.ok) {
      const alreadyReported = req.metrics.every((m) => reported.has(`${req.igId}|${m}`));
      if (!alreadyReported) {
        issues.push({
          assetId: req.igId,
          assetName: req.igName,
          surface: "instagram",
          metric: req.metrics.join(","),
          message: res.error.message,
        });
      }
      return;
    }
    for (const raw of res.data.data ?? []) {
      mergeSeries(merged, {
        assetId: req.igId,
        assetName: req.igName,
        surface: "instagram",
        metric: raw.name,
        period: raw.period,
        points: toPoints(raw, req.windowEnd, IG_END_TIME_SHIFT),
      });
    }
  });

  return { series: dedupe([...merged.values()]), issues };
}

/**
 * Executa o batch e, quando uma requisição com várias métricas falha, refaz
 * aquela janela métrica a métrica. Sem isso, uma única métrica inválida
 * (ou incompatível com o metric_type) descarta o resultado das demais.
 */
async function executeWithPerMetricFallback<
  R extends {
    path: string;
    params: Record<string, string | number>;
    token: string;
    metrics: string[];
  },
>(
  client: GraphClient,
  requests: R[],
): Promise<BatchOutcome> {
  const results = await client.batchGet<{ data: RawInsight[] }>(
    requests.map((r) => ({ path: r.path, params: r.params, token: r.token })),
  );

  const retryIndexes: number[] = [];
  const retryRequests: Array<{
    path: string;
    params: Record<string, string | number>;
    token: string;
  }> = [];
  const retryOwner: number[] = [];

  results.forEach((res, i) => {
    const req = requests[i]!;
    if (res.ok || req.metrics.length < 2) return;
    retryIndexes.push(i);
    for (const metric of req.metrics) {
      retryRequests.push({
        path: req.path,
        params: { ...req.params, metric },
        token: req.token,
      });
      retryOwner.push(i);
    }
  });

  if (retryRequests.length === 0) return { results, perMetricErrors: [] };

  const retried = await client.batchGet<{ data: RawInsight[] }>(retryRequests);
  const salvaged = new Map<number, RawInsight[]>();
  const perMetricErrors: Array<{ index: number; metric: string; error: GraphError }> = [];

  retried.forEach((res, j) => {
    const owner = retryOwner[j]!;
    const metric = String(retryRequests[j]!.params.metric);
    if (res.ok) {
      const list = salvaged.get(owner) ?? [];
      list.push(...(res.data.data ?? []));
      salvaged.set(owner, list);
    } else {
      perMetricErrors.push({ index: owner, metric, error: res.error });
    }
  });

  for (const i of retryIndexes) {
    const rescued = salvaged.get(i);
    if (rescued && rescued.length > 0) {
      results[i] = { ok: true, data: { data: rescued } };
    }
  }

  return { results, perMetricErrors };
}

/** Janelas sobrepostas podem repetir pontos; mantém um por (data, breakdown). */
function dedupe(all: MetricSeries[]): MetricSeries[] {
  for (const series of all) {
    const seen = new Map<string, SeriesPoint>();
    for (const point of series.points) {
      const key = `${point.date}|${JSON.stringify(point.breakdown ?? {})}`;
      seen.set(key, point);
    }
    series.points = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  return all;
}

export function isGraphError(err: unknown): err is GraphError {
  return err instanceof GraphError;
}
