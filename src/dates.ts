/**
 * Utilitários de data em UTC. Toda a lógica de janelas usa strings YYYY-MM-DD
 * para evitar surpresas de fuso — a Graph API entrega insights diários já
 * ancorados no fuso da conta, e reprocessar isso em horário local só introduz
 * deslocamento de um dia.
 */

export type Granularity = "day" | "week" | "month" | "quarter" | "year";

export interface Bucket {
  /** Rótulo do período: 2026-03, 2026-W12, 2026-03-14, 2026-Q1, 2026 */
  label: string;
  /** Primeiro dia do bucket (YYYY-MM-DD, inclusivo). */
  start: string;
  /** Último dia do bucket (YYYY-MM-DD, inclusivo). */
  end: string;
}

export function toDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function addMonths(iso: string, months: number): string {
  const d = toDate(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return toIso(d);
}

/** Timestamp Unix (segundos) do início do dia UTC. */
export function unix(iso: string): number {
  return Math.floor(toDate(iso).getTime() / 1000);
}

export function daysBetween(startIso: string, endIso: string): number {
  return Math.round(
    (toDate(endIso).getTime() - toDate(startIso).getTime()) / 86_400_000,
  );
}

function isoWeekLabel(date: Date): string {
  const d = new Date(date.getTime());
  // ISO 8601: a semana pertence ao ano da sua quinta-feira.
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Rótulo do bucket ao qual uma data pertence. */
export function bucketLabel(iso: string, granularity: Granularity): string {
  const d = toDate(iso);
  switch (granularity) {
    case "day":
      return iso;
    case "week":
      return isoWeekLabel(d);
    case "month":
      return iso.slice(0, 7);
    case "quarter":
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "year":
      return String(d.getUTCFullYear());
  }
}

/**
 * Divide [start, end] em buckets alinhados ao calendário. O primeiro e o
 * último bucket são recortados nos limites do intervalo pedido, para que a
 * soma dos buckets seja exatamente o intervalo — sem dias fantasma.
 */
export function buildBuckets(
  startIso: string,
  endIso: string,
  granularity: Granularity,
): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = startIso;

  while (cursor <= endIso) {
    const label = bucketLabel(cursor, granularity);
    const naturalEnd = naturalBucketEnd(cursor, granularity);
    const end = naturalEnd > endIso ? endIso : naturalEnd;
    buckets.push({ label, start: cursor, end });
    cursor = addDays(end, 1);
  }

  return buckets;
}

function naturalBucketEnd(iso: string, granularity: Granularity): string {
  const d = toDate(iso);
  switch (granularity) {
    case "day":
      return iso;
    case "week": {
      // Semana ISO termina no domingo.
      const dayNum = (d.getUTCDay() + 6) % 7;
      return addDays(iso, 6 - dayNum);
    }
    case "month":
      return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    case "quarter": {
      const endMonth = Math.floor(d.getUTCMonth() / 3) * 3 + 3;
      return toIso(new Date(Date.UTC(d.getUTCFullYear(), endMonth, 0)));
    }
    case "year":
      return `${d.getUTCFullYear()}-12-31`;
  }
}

/**
 * Quebra um intervalo em fatias de no máximo `maxDays` — a Graph API limita a
 * janela por request (30 dias no Instagram, ~93 dias em Page Insights).
 */
export function chunkRange(
  startIso: string,
  endIso: string,
  maxDays: number,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = startIso;
  while (cursor <= endIso) {
    const tentative = addDays(cursor, maxDays - 1);
    const end = tentative > endIso ? endIso : tentative;
    chunks.push({ start: cursor, end });
    cursor = addDays(end, 1);
  }
  return chunks;
}

/** Resolve `since`/`until` opcionais para um intervalo concreto. */
export function resolveRange(
  since?: string,
  until?: string,
  defaultDays = 180,
): { since: string; until: string } {
  const end = until ?? today();
  const start = since ?? addDays(end, -(defaultDays - 1));
  if (start > end) {
    throw new Error(`Intervalo inválido: since (${start}) > until (${end}).`);
  }
  return { since: start, until: end };
}
