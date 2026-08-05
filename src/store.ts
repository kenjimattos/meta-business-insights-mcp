/**
 * Histórico local de snapshots.
 *
 * A Graph API tem memória curta para o que interessa aqui: `follower_count` do
 * Instagram só volta 30 dias e Page Insights ~2 anos. Gravando um snapshot dos
 * totais periodicamente, o portfólio acumula um histórico próprio que não
 * depende da janela do Meta e sobrevive às deprecações de métrica.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface Snapshot {
  /** Data do snapshot (YYYY-MM-DD). */
  date: string;
  capturedAt: string;
  surface: "facebook" | "instagram";
  assetId: string;
  assetName: string;
  followers: number | null;
}

export class SnapshotStore {
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, "follower-snapshots.json");
  }

  private read(): Snapshot[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as Snapshot[]) : [];
    } catch {
      return [];
    }
  }

  private write(snapshots: Snapshot[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshots, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  /** Grava snapshots substituindo os do mesmo (data, ativo). */
  save(snapshots: Snapshot[]): { written: number; total: number } {
    const existing = this.read();
    const key = (s: Snapshot) => `${s.date}|${s.surface}|${s.assetId}`;
    const merged = new Map(existing.map((s) => [key(s), s]));
    for (const snapshot of snapshots) merged.set(key(snapshot), snapshot);
    const all = [...merged.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.assetName.localeCompare(b.assetName),
    );
    this.write(all);
    return { written: snapshots.length, total: all.length };
  }

  query(filter: { since?: string; until?: string; assetIds?: string[] } = {}): Snapshot[] {
    const allow = filter.assetIds ? new Set(filter.assetIds) : undefined;
    return this.read().filter(
      (s) =>
        (!filter.since || s.date >= filter.since) &&
        (!filter.until || s.date <= filter.until) &&
        (!allow || allow.has(s.assetId)),
    );
  }

  get path(): string {
    return this.file;
  }
}
