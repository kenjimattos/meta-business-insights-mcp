#!/usr/bin/env node
/**
 * Smoke test fora do Claude Desktop: valida token, descobre o portfólio e puxa
 * seguidores dos últimos meses. Rode `npm run build && npm run probe` para
 * confirmar permissões antes de plugar o servidor no Claude.
 */

import { loadConfig } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { PortfolioService } from "./graph/assets.js";
import { fetchFollowerSeries } from "./followers.js";
import { addDays, today } from "./dates.js";

const config = loadConfig();
const client = new GraphClient(config.accessToken, config.apiVersion);

console.log(`Graph API ${config.apiVersion}`);

const me = await client.get<{ id: string; name?: string }>("/me", {
  fields: "id,name",
});
console.log(`Token válido para: ${me.name ?? "(sem nome)"} (${me.id})`);

const portfolio = new PortfolioService(client, config.businessId, config.pageIdFilter);
const result = await portfolio.get(true);

console.log(
  `\nPortfólio: ${result.businessName ?? "(via /me/accounts)"} — ${result.pages.length} páginas`,
);
for (const page of result.pages) {
  const ig = page.instagram;
  console.log(
    `  • ${page.name} (${page.id}) — FB ${page.followersCount ?? "?"} seguidores` +
      (ig ? ` | IG @${ig.username ?? ig.id}: ${ig.followersCount ?? "?"}` : "") +
      (page.accessToken ? "" : "  [SEM PAGE TOKEN]"),
  );
}
for (const warning of result.warnings) console.log(`  ! ${warning}`);

const sample = result.pages.slice(0, 3);
if (sample.length > 0) {
  const until = today();
  const since = addDays(until, -120);
  console.log(`\nSeguidores por mês (${since} → ${until}), ${sample.length} ativos:`);
  const series = await fetchFollowerSeries(
    client,
    sample,
    { since, until, granularity: "month" },
    config.accessToken,
  );
  for (const row of series.rows) {
    console.log(
      `  ${row.period}  ${row.surface === "facebook" ? "FB" : "IG"}  ${row.assetName}` +
        `  +${row.gained ?? "?"} / -${row.lost ?? "?"} = ${row.net ?? "?"}` +
        `  total ${row.total ?? "?"}${row.totalIsEstimated ? " (est.)" : ""}`,
    );
  }
  for (const issue of series.issues) {
    console.log(`  ! ${issue.assetName} [${issue.surface}]: ${issue.message}`);
  }
}
