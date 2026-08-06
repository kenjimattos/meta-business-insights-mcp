#!/usr/bin/env node
/**
 * Grava um snapshot de seguidores sem passar pelo MCP.
 *
 * Existe para o cron: o histórico local só tem valor se for alimentado todo
 * dia, e depender de alguém pedir a tool ao Claude não é uma garantia. A janela
 * de `follower_count` do Instagram é de 30 dias — o que não for capturado nesse
 * intervalo não existe em lugar nenhum depois.
 *
 * Uso: node dist/snapshot-cli.js [--date YYYY-MM-DD] [--assets a,b,c]
 */

import { loadConfig } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { PortfolioService } from "./graph/assets.js";
import { SnapshotStore } from "./store.js";
import { captureSnapshot } from "./snapshot.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = loadConfig();
const client = new GraphClient(config.accessToken, config.apiVersion);
const portfolio = new PortfolioService(client, config.businessId, config.pageIdFilter);
const store = new SnapshotStore(config.dataDir);

const assets = flag("assets")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

try {
  const result = await captureSnapshot(portfolio, store, {
    assets: assets && assets.length > 0 ? assets : undefined,
    date: flag("date"),
  });
  // Uma linha por execução: é o que o journalctl mostra depois.
  console.log(
    `snapshot ${result.date}: ${result.written} ativos gravados, ` +
      `${result.total} no histórico (${result.file})`,
  );
} catch (err) {
  // Sair diferente de zero faz o systemd marcar a unidade como falha, o que
  // torna o problema visível em `systemctl list-units --failed`.
  console.error(
    `falha ao gravar snapshot: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
