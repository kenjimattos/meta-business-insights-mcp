/**
 * MCP server: Meta Business Insights (orgânico + pago).
 *
 * Complementa o MCP de Meta Ads, que só enxerga o que veio de campanha. Aqui a
 * fonte é o Business Manager inteiro: todas as Páginas e contas do Instagram do
 * portfólio, com os números reais das contas.
 *
 * Este módulo só define o servidor. Quem o serve são os entrypoints:
 * `index.ts` (stdio, execução local) e `http.ts` (remoto, atrás de bearer).
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { loadConfig } from "./config.js";
import { GraphClient, GraphError } from "./graph/client.js";
import { PortfolioService, type PageAsset } from "./graph/assets.js";
import {
  fetchInstagramInsights,
  fetchPageInsights,
  type FetchIssue,
  type MetricSeries,
} from "./graph/insights.js";
import { fetchFollowerSeries } from "./followers.js";
import { aggregate, withDeltas, type GroupDimension } from "./aggregate.js";
import { SnapshotStore, type Snapshot } from "./store.js";
import { resolveRange, today, type Granularity } from "./dates.js";
import {
  IG_METRICS,
  PAGE_DEPRECATIONS,
  PAGE_METRICS,
  checkDeprecated,
} from "./metrics.js";
import {
  formatPct,
  formatSigned,
  issuesBlock,
  markdownTable,
  section,
} from "./format.js";

const config = loadConfig();
const client = new GraphClient(config.accessToken, config.apiVersion);
const portfolio = new PortfolioService(client, config.businessId, config.pageIdFilter);
const store = new SnapshotStore(config.dataDir);

const granularitySchema = z
  .enum(["day", "week", "month", "quarter", "year"])
  .default("month")
  .describe("Granularidade dos períodos retornados.");

const assetsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "IDs ou nomes de Páginas / contas do Instagram (@usuario). Vazio = portfólio inteiro.",
  );

const sinceSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Data inicial YYYY-MM-DD (default: 180 dias atrás).");

const untilSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Data final YYYY-MM-DD, inclusiva (default: hoje).");

function text(body: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: body }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function fail(err: unknown) {
  const message =
    err instanceof GraphError
      ? `${err.message}${err.fbtraceId ? ` [fbtrace_id: ${err.fbtraceId}]` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text" as const, text: `Erro: ${message}` }], isError: true };
}

function assetLine(page: PageAsset): string {
  const ig = page.instagram;
  return ig
    ? `${ig.username ? `@${ig.username}` : ig.id} (${ig.followersCount?.toLocaleString("pt-BR") ?? "—"})`
    : "—";
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "meta-business-insights",
    version: "0.1.0",
  });

  /* ------------------------------ portfólio ------------------------------ */

  server.registerTool(
    "list_portfolio",
    {
      title: "Listar portfólio",
      description:
        "Lista todas as Páginas do Facebook e contas do Instagram do portfólio (Business Manager), " +
        "com IDs e total de seguidores atual. Use antes das outras tools para descobrir os IDs.",
      inputSchema: z.object({
        refresh: z
          .boolean()
          .default(false)
          .describe("Ignora o cache de 10 minutos e redescobre os ativos."),
      }),
    },
    async ({ refresh }) => {
      try {
        const result = await portfolio.get(refresh);
        const rows = result.pages.map((p) => [
          p.name,
          p.id,
          p.followersCount ?? null,
          assetLine(p),
          p.accessToken ? "ok" : "faltando",
        ]);

        const header = result.businessName
          ? `**Portfólio:** ${result.businessName} (${result.businessId})`
          : "**Portfólio:** descoberto via /me/accounts";

        const totalFb = sum(result.pages.map((p) => p.followersCount ?? 0));
        const totalIg = sum(result.pages.map((p) => p.instagram?.followersCount ?? 0));

        const body = [
          header,
          "",
          markdownTable(
            ["Página", "Page ID", "Seguidores FB", "Instagram (seguidores)", "Page token"],
            rows,
          ),
          "",
          `**${result.pages.length} páginas** · Facebook: ${totalFb.toLocaleString("pt-BR")} seguidores · Instagram: ${totalIg.toLocaleString("pt-BR")} seguidores`,
        ].join("\n");

        return text(body + issuesBlock(
          result.warnings.map((w) => ({ assetName: "portfólio", surface: "geral", message: w })),
        ), {
          businessId: result.businessId,
          businessName: result.businessName,
          pages: result.pages.map((p) => ({
            id: p.id,
            name: p.name,
            followersCount: p.followersCount ?? null,
            hasPageToken: Boolean(p.accessToken),
            instagram: p.instagram ?? null,
            source: p.source,
          })),
          totals: { facebook: totalFb, instagram: totalIg },
          warnings: result.warnings,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ------------------------------ seguidores ----------------------------- */

  server.registerTool(
    "followers_overview",
    {
      title: "Seguidores agora",
      description:
        "Foto do momento: total de seguidores por ativo e consolidado do portfólio " +
        "(Facebook + Instagram). Inclui crescimento orgânico e pago, pois usa o número real da conta.",
      inputSchema: z.object({
        assets: assetsSchema,
      }),
    },
    async ({ assets }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const rows: Array<[string, string, string, number | null]> = [];
        for (const page of pages) {
          rows.push(["Facebook", page.name, page.id, page.followersCount ?? null]);
          if (page.instagram) {
            rows.push([
              "Instagram",
              page.instagram.username ? `@${page.instagram.username}` : (page.instagram.name ?? page.instagram.id),
              page.instagram.id,
              page.instagram.followersCount ?? null,
            ]);
          }
        }

        const total = sum(rows.map((r) => r[3] ?? 0));
        const body = [
          markdownTable(["Rede", "Ativo", "ID", "Seguidores"], rows),
          "",
          `**Total do portfólio: ${total.toLocaleString("pt-BR")} seguidores** (${rows.length} ativos, em ${today()})`,
        ].join("\n");

        return text(body, {
          date: today(),
          assets: rows.map(([surface, name, id, followers]) => ({
            surface,
            name,
            id,
            followers,
          })),
          total,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "followers_timeseries",
    {
      title: "Seguidores por período",
      description:
        "Evolução de seguidores por mês (ou dia/semana/trimestre/ano), com ganhos, perdas, " +
        "saldo e total acumulado ao fim de cada período — orgânico + pago juntos. " +
        "Cobre Facebook e Instagram, por ativo ou consolidado no portfólio.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
        granularity: granularitySchema,
        surface: z
          .enum(["all", "facebook", "instagram"])
          .default("all")
          .describe("Filtra a rede."),
        consolidate: z
          .boolean()
          .default(false)
          .describe(
            "true soma todos os ativos em uma única linha por período (visão de portfólio).",
          ),
      }),
    },
    async ({ assets, since, until, granularity, surface, consolidate }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const range = resolveRange(since, until, 365);
        const result = await fetchFollowerSeries(
          client,
          pages,
          { ...range, granularity: granularity as Granularity },
          config.accessToken,
        );

        let rows = result.rows;
        if (surface !== "all") rows = rows.filter((r) => r.surface === surface);

        if (consolidate) {
          const byPeriod = new Map<
            string,
            { gained: number; lost: number; total: number; estimated: boolean; assets: number }
          >();
          for (const row of rows) {
            const slot =
              byPeriod.get(row.period) ??
              { gained: 0, lost: 0, total: 0, estimated: false, assets: 0 };
            byPeriod.set(row.period, slot);
            slot.gained += row.gained ?? 0;
            slot.lost += row.lost ?? 0;
            slot.total += row.total ?? 0;
            slot.estimated ||= row.totalIsEstimated;
            slot.assets += 1;
          }

          const consolidated = [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b));
          let prevTotal: number | undefined;
          const table = consolidated.map(([period, s]) => {
            const delta = prevTotal === undefined ? null : s.total - prevTotal;
            const pct = prevTotal ? ((s.total - prevTotal) / prevTotal) * 100 : null;
            prevTotal = s.total;
            return [
              period,
              s.assets,
              s.gained,
              -s.lost,
              formatSigned(s.gained - s.lost),
              s.total,
              formatPct(pct ?? undefined),
            ];
          });

          const body = [
            section(
              `Seguidores do portfólio por ${labelOf(granularity)}`,
              markdownTable(
                ["Período", "Ativos", "Ganhos", "Perdidos", "Saldo", "Total", "Var. total"],
                table,
              ),
            ),
            "",
            "_Totais do Instagram são reconstruídos a partir do número atual de seguidores (a API não expõe histórico acumulado)._",
          ].join("\n");

          return text(body + issuesBlock(result.issues), {
            granularity,
            range,
            consolidated: consolidated.map(([period, s]) => ({
              period,
              assets: s.assets,
              gained: s.gained,
              lost: s.lost,
              net: s.gained - s.lost,
              total: s.total,
              totalIsEstimated: s.estimated,
            })),
            issues: result.issues,
          });
        }

        const table = rows.map((r) => [
          r.period,
          r.surface === "facebook" ? "FB" : "IG",
          r.assetName,
          r.gained,
          r.lost === null ? null : -r.lost,
          formatSigned(r.net),
          r.total,
          r.totalIsEstimated ? "estimado" : "API",
        ]);

        const body = section(
          `Seguidores por ${labelOf(granularity)}`,
          markdownTable(
            ["Período", "Rede", "Ativo", "Ganhos", "Perdidos", "Saldo", "Total", "Fonte do total"],
            table,
          ),
        );

        return text(body + issuesBlock(result.issues), {
          granularity,
          range,
          rows,
          currentTotals: result.currentTotals,
          issues: result.issues,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* -------------------------------- insights ------------------------------ */

  const insightsInput = z.object({
    metrics: z
      .array(z.string())
      .min(1)
      .describe("Métricas da Graph API. Use list_metrics para ver as válidas."),
    assets: assetsSchema,
    since: sinceSchema,
    until: untilSchema,
    granularity: granularitySchema,
    aggregation: z
      .enum(["sum", "avg", "max", "min", "last"])
      .default("sum")
      .describe("Como consolidar os dias dentro de cada período."),
    groupBy: z
      .array(z.enum(["period", "asset", "surface", "metric", "breakdown"]))
      .default(["period", "asset", "metric"])
      .describe("Dimensões da saída. Remova 'asset' para consolidar o portfólio."),
    includeDeltas: z
      .boolean()
      .default(false)
      .describe("Acrescenta variação vs. o período anterior."),
  });

  server.registerTool(
    "page_insights",
    {
      title: "Insights de Páginas do Facebook",
      description:
        "Métricas orgânicas de Páginas do Facebook, agregadas do jeito que você pedir " +
        "(por mês, por conta, consolidado no portfólio). Ex.: page_follows, " +
        "page_daily_follows_unique, page_views_total, page_post_engagements.",
      inputSchema: insightsInput.extend({
        period: z
          .enum(["day", "week", "days_28"])
          .default("day")
          .describe("Janela nativa da métrica na Graph API."),
      }),
    },
    async (input) => {
      try {
        const pages = await portfolio.resolveTargets(input.assets);
        const range = resolveRange(input.since, input.until, 180);
        const notes = input.metrics
          .map((m) => checkDeprecated(m, "page"))
          .filter(Boolean) as string[];

        const result = await fetchPageInsights(
          client,
          pages,
          { metrics: input.metrics, ...range, period: input.period },
          config.accessToken,
        );

        return text(
          renderInsights(result.series, result.issues, input, range, notes),
          {
            range,
            rows: aggregate(result.series, {
              granularity: input.granularity as Granularity,
              groupBy: input.groupBy as GroupDimension[],
              aggregation: input.aggregation,
            }),
            issues: result.issues,
            deprecationNotes: notes,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "instagram_insights",
    {
      title: "Insights de contas do Instagram",
      description:
        "Métricas orgânicas de contas do Instagram do portfólio, agregadas por período/conta. " +
        "Ex.: reach, views, profile_views, accounts_engaged, total_interactions, follows_and_unfollows.",
      inputSchema: insightsInput.extend({
        breakdown: z
          .string()
          .optional()
          .describe(
            "Breakdown opcional: follow_type, media_product_type, contact_button_type, age, city, country, gender.",
          ),
        timeframe: z
          .string()
          .optional()
          .describe(
            "Obrigatório para métricas demográficas: this_week, this_month, last_14_days, last_30_days, last_90_days, prev_month.",
          ),
      }),
    },
    async (input) => {
      try {
        const pages = await portfolio.resolveTargets(input.assets);
        const range = resolveRange(input.since, input.until, 90);
        const notes = input.metrics
          .map((m) => checkDeprecated(m, "instagram"))
          .filter(Boolean) as string[];

        const result = await fetchInstagramInsights(
          client,
          pages,
          {
            metrics: input.metrics,
            ...range,
            granularity: input.granularity as Granularity,
            breakdown: input.breakdown,
            timeframe: input.timeframe,
          },
          config.accessToken,
        );

        return text(
          renderInsights(result.series, result.issues, input, range, notes),
          {
            range,
            rows: aggregate(result.series, {
              granularity: input.granularity as Granularity,
              groupBy: input.groupBy as GroupDimension[],
              aggregation: input.aggregation,
            }),
            issues: result.issues,
            deprecationNotes: notes,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_metrics",
    {
      title: "Métricas disponíveis",
      description:
        "Catálogo das métricas orgânicas de Page e Instagram Insights, com o mapa das " +
        "métricas descontinuadas pelo Meta e seus substitutos.",
      inputSchema: z.object({
        surface: z.enum(["all", "facebook", "instagram"]).default("all"),
      }),
    },
    async ({ surface }) => {
      const parts: string[] = [];
      if (surface !== "instagram") {
        parts.push(
          section(
            "Facebook Page Insights",
            markdownTable(
              ["Métrica", "Períodos", "Descrição"],
              PAGE_METRICS.map((m) => [m.name, m.periods.join(", "), m.description]),
            ),
          ),
        );
      }
      if (surface !== "facebook") {
        parts.push(
          section(
            "Instagram Insights",
            markdownTable(
              ["Métrica", "Períodos", "Descrição"],
              IG_METRICS.map((m) => [m.name, m.periods.join(", "), m.description]),
            ),
          ),
        );
      }
      parts.push(
        section(
          "Descontinuadas pelo Meta → substituto",
          markdownTable(
            ["Antiga", "Usar no lugar"],
            Object.entries(PAGE_DEPRECATIONS).map(([o, n]) => [o, n]),
          ),
        ),
      );
      return text(parts.join("\n\n"), {
        page: PAGE_METRICS,
        instagram: IG_METRICS,
        deprecations: PAGE_DEPRECATIONS,
      });
    },
  );

  /* -------------------------------- snapshots ----------------------------- */

  server.registerTool(
    "save_followers_snapshot",
    {
      title: "Gravar snapshot de seguidores",
      description:
        "Grava o total de seguidores de todos os ativos em um histórico local. " +
        "Útil porque a Graph API só devolve 30 dias de histórico de seguidores do Instagram — " +
        "rodando isso periodicamente o portfólio constrói a própria série longa.",
      inputSchema: z.object({
        assets: assetsSchema,
        date: sinceSchema.describe("Data do snapshot (default: hoje)."),
      }),
    },
    async ({ assets, date }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const stamp = date ?? today();
        const capturedAt = new Date().toISOString();
        const snapshots: Snapshot[] = [];

        for (const page of pages) {
          snapshots.push({
            date: stamp,
            capturedAt,
            surface: "facebook",
            assetId: page.id,
            assetName: page.name,
            followers: page.followersCount ?? null,
          });
          if (page.instagram) {
            snapshots.push({
              date: stamp,
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
        return text(
          `Gravados **${written}** snapshots de ${stamp} (${total} no histórico).\n\nArquivo: \`${store.path}\``,
          { date: stamp, written, total, file: store.path },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "snapshot_history",
    {
      title: "Histórico local de seguidores",
      description:
        "Lê a série de seguidores gravada localmente por save_followers_snapshot, " +
        "sem depender da janela curta da Graph API.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
      }),
    },
    async ({ assets, since, until }) => {
      try {
        const assetIds = assets
          ? (await portfolio.resolveTargets(assets)).flatMap((p) =>
              p.instagram ? [p.id, p.instagram.id] : [p.id],
            )
          : undefined;
        const snapshots = store.query({ since, until, assetIds });
        const table = snapshots.map((s) => [
          s.date,
          s.surface === "facebook" ? "FB" : "IG",
          s.assetName,
          s.followers,
        ]);
        return text(
          markdownTable(["Data", "Rede", "Ativo", "Seguidores"], table, {
            emptyMessage:
              "_Histórico vazio. Rode save_followers_snapshot para começar a acumular._",
          }),
          { snapshots, file: store.path },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ------------------------------- escape hatch --------------------------- */

  server.registerTool(
    "graph_api_get",
    {
      title: "GET cru na Graph API",
      description:
        "Chamada GET direta a qualquer nó/edge da Graph API, com o token certo já resolvido. " +
        "Use quando a métrica ou campo desejado não estiver coberto pelas outras tools.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Caminho sem a versão. Ex.: '123456/insights' ou 'me/accounts'."),
        params: z
          .record(z.string(), z.string())
          .default({})
          .describe("Query params. Não inclua access_token."),
        usePageToken: z
          .string()
          .optional()
          .describe("ID ou nome da Página cujo Page Access Token deve ser usado."),
        paginate: z
          .boolean()
          .default(false)
          .describe("Segue a paginação e concatena todos os data[]."),
      }),
    },
    async ({ path, params, usePageToken, paginate }) => {
      try {
        let token: string | undefined;
        if (usePageToken) {
          const [page] = await portfolio.resolveTargets([usePageToken]);
          token = page?.accessToken;
        }
        const data = paginate
          ? await client.getAll(path, params, { token })
          : await client.get(path, params, { token });
        const json = JSON.stringify(data, null, 2);
        const truncated =
          json.length > 60_000 ? `${json.slice(0, 60_000)}\n… (truncado)` : json;
        return text("```json\n" + truncated + "\n```", { data } as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/* --------------------------------- helpers -------------------------------- */

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function labelOf(granularity: string): string {
  return (
    { day: "dia", week: "semana", month: "mês", quarter: "trimestre", year: "ano" }[
      granularity
    ] ?? granularity
  );
}

function renderInsights(
  series: MetricSeries[],
  issues: FetchIssue[],
  input: {
    granularity: string;
    groupBy: string[];
    aggregation: "sum" | "avg" | "max" | "min" | "last";
    includeDeltas: boolean;
    metrics: string[];
  },
  range: { since: string; until: string },
  notes: string[],
): string {
  const rows = aggregate(series, {
    granularity: input.granularity as Granularity,
    groupBy: input.groupBy as GroupDimension[],
    aggregation: input.aggregation,
  });
  const enriched = input.includeDeltas ? withDeltas(rows) : rows;

  const headers: string[] = [];
  if (input.groupBy.includes("period")) headers.push("Período");
  if (input.groupBy.includes("surface")) headers.push("Rede");
  if (input.groupBy.includes("asset")) headers.push("Ativo");
  if (input.groupBy.includes("metric")) headers.push("Métrica");
  if (input.groupBy.includes("breakdown")) headers.push("Breakdown");
  headers.push("Valor");
  if (input.includeDeltas) headers.push("Δ", "Δ%");

  const table = enriched.map((row) => {
    const cells: Array<string | number | null> = [];
    if (input.groupBy.includes("period")) cells.push(row.period ?? "—");
    if (input.groupBy.includes("surface")) cells.push(row.surface ?? "—");
    if (input.groupBy.includes("asset")) cells.push(row.asset ?? "—");
    if (input.groupBy.includes("metric")) cells.push(row.metric ?? "—");
    if (input.groupBy.includes("breakdown")) cells.push(row.breakdown || "—");
    cells.push(row.value);
    if (input.includeDeltas) {
      const e = row as { delta?: number; deltaPct?: number };
      cells.push(formatSigned(e.delta), formatPct(e.deltaPct));
    }
    return cells;
  });

  const head = `**${input.metrics.join(", ")}** · ${range.since} → ${range.until} · ${input.aggregation} por ${labelOf(input.granularity)}`;
  const notesBlock = notes.length > 0 ? `\n\n> ${notes.join("\n> ")}` : "";

  return (
    `${head}${notesBlock}\n\n${markdownTable(headers, table)}` +
    issuesBlock(issues)
  );
}
