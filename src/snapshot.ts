/**
 * Captura do snapshot de seguidores, compartilhada entre a tool MCP e o CLI.
 *
 * A duplicata importa mais do que parece: o valor do histórico local vem de ele
 * ser gravado *todo dia*, o que só acontece num cron. Se a lógica vivesse só
 * dentro do handler da tool, o cron precisaria falar MCP para chamá-la.
 */

import type { PortfolioService } from "./graph/assets.js";
import type { SnapshotStore, Snapshot } from "./store.js";
import { today } from "./dates.js";

export interface CaptureOptions {
  /** IDs, nomes ou @usuario. Vazio = portfólio inteiro. */
  assets?: string[];
  /** Data do snapshot (YYYY-MM-DD). Default: hoje. */
  date?: string;
}

export interface CaptureResult {
  date: string;
  written: number;
  total: number;
  file: string;
}

export async function captureSnapshot(
  portfolio: PortfolioService,
  store: SnapshotStore,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const pages = await portfolio.resolveTargets(options.assets);
  const date = options.date ?? today();
  const capturedAt = new Date().toISOString();
  const snapshots: Snapshot[] = [];

  for (const page of pages) {
    snapshots.push({
      date,
      capturedAt,
      surface: "facebook",
      assetId: page.id,
      assetName: page.name,
      followers: page.followersCount ?? null,
    });
    if (page.instagram) {
      snapshots.push({
        date,
        capturedAt,
        surface: "instagram",
        assetId: page.instagram.id,
        assetName: page.instagram.username
          ? `@${page.instagram.username}`
          : (page.instagram.name ?? page.instagram.id),
        followers: page.instagram.followersCount ?? null,
      });
    }
  }

  const { written, total } = store.save(snapshots);
  return { date, written, total, file: store.path };
}
