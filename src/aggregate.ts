/**
 * Agregação cross-account: pega as séries diárias devolvidas pela Graph API e
 * as consolida no recorte que o usuário pediu (por mês, por conta, por métrica,
 * por breakdown — em qualquer combinação).
 */

import type { MetricSeries } from "./graph/insights.js";
import { bucketLabel, type Granularity } from "./dates.js";

export type Aggregation = "sum" | "avg" | "max" | "min" | "last";
export type GroupDimension = "period" | "asset" | "surface" | "metric" | "breakdown";

export interface AggregatedRow {
  period?: string;
  asset?: string;
  assetId?: string;
  surface?: string;
  metric?: string;
  breakdown?: string;
  value: number;
  /** Quantidade de pontos diários por trás do valor. */
  samples: number;
}

export interface AggregateOptions {
  granularity: Granularity;
  groupBy: GroupDimension[];
  aggregation: Aggregation;
}

function breakdownKey(breakdown: Record<string, string> | undefined): string {
  if (!breakdown) return "";
  return Object.entries(breakdown)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function aggregate(
  series: MetricSeries[],
  options: AggregateOptions,
): AggregatedRow[] {
  const { granularity, groupBy, aggregation } = options;
  const groups = new Map<
    string,
    { row: Omit<AggregatedRow, "value" | "samples">; values: Array<{ date: string; value: number }> }
  >();

  for (const s of series) {
    for (const point of s.points) {
      const dims: Omit<AggregatedRow, "value" | "samples"> = {};
      if (groupBy.includes("period")) dims.period = bucketLabel(point.date, granularity);
      if (groupBy.includes("asset")) {
        dims.asset = s.assetName;
        dims.assetId = s.assetId;
      }
      if (groupBy.includes("surface")) dims.surface = s.surface;
      if (groupBy.includes("metric")) dims.metric = s.metric;
      if (groupBy.includes("breakdown")) dims.breakdown = breakdownKey(point.breakdown);

      const key = JSON.stringify([
        dims.period ?? "",
        dims.assetId ?? "",
        dims.surface ?? "",
        dims.metric ?? "",
        dims.breakdown ?? "",
      ]);

      const group = groups.get(key) ?? { row: dims, values: [] };
      groups.set(key, group);
      group.values.push({ date: point.date, value: point.value });
    }
  }

  const rows: AggregatedRow[] = [];
  for (const { row, values } of groups.values()) {
    rows.push({ ...row, value: apply(values, aggregation), samples: values.length });
  }

  return rows.sort(
    (a, b) =>
      (a.period ?? "").localeCompare(b.period ?? "") ||
      (a.metric ?? "").localeCompare(b.metric ?? "") ||
      (a.asset ?? "").localeCompare(b.asset ?? "") ||
      (a.breakdown ?? "").localeCompare(b.breakdown ?? ""),
  );
}

function apply(
  values: Array<{ date: string; value: number }>,
  aggregation: Aggregation,
): number {
  if (values.length === 0) return 0;
  const nums = values.map((v) => v.value);
  switch (aggregation) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "max":
      return Math.max(...nums);
    case "min":
      return Math.min(...nums);
    case "last":
      return [...values].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!.value;
  }
}

/** Variação percentual entre períodos consecutivos de uma mesma série. */
export function withDeltas(rows: AggregatedRow[]): Array<AggregatedRow & { delta?: number; deltaPct?: number }> {
  const bySeries = new Map<string, Array<AggregatedRow & { delta?: number; deltaPct?: number }>>();
  const out: Array<AggregatedRow & { delta?: number; deltaPct?: number }> = [];

  for (const row of rows) {
    const key = `${row.assetId ?? ""}|${row.surface ?? ""}|${row.metric ?? ""}|${row.breakdown ?? ""}`;
    const list = bySeries.get(key) ?? [];
    bySeries.set(key, list);
    const enriched: AggregatedRow & { delta?: number; deltaPct?: number } = { ...row };
    const prev = list.at(-1);
    if (prev) {
      enriched.delta = row.value - prev.value;
      enriched.deltaPct = prev.value === 0 ? undefined : (enriched.delta / prev.value) * 100;
    }
    list.push(enriched);
    out.push(enriched);
  }

  return out;
}
