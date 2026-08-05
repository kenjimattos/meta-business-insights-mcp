/**
 * Formatação em Markdown. As tools devolvem tabela legível *e*
 * structuredContent — a tabela é o que o Claude lê para conversar sobre os
 * números, o JSON é o que ele usa para cálculos posteriores.
 */

export type Cell = string | number | null | undefined;

export function markdownTable(
  headers: string[],
  rows: Cell[][],
  options: { emptyMessage?: string; maxRows?: number } = {},
): string {
  if (rows.length === 0) {
    return options.emptyMessage ?? "_Sem dados para o recorte solicitado._";
  }

  const maxRows = options.maxRows ?? 500;
  const shown = rows.slice(0, maxRows);
  const body = shown.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const truncated =
    rows.length > maxRows
      ? `\n\n_Exibindo ${maxRows} de ${rows.length} linhas._`
      : "";

  return `${head}\n${sep}\n${body}${truncated}`;
}

function cell(value: Cell): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return formatNumber(value);
  return value.replace(/\|/g, "\\|");
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return rounded.toLocaleString("pt-BR");
}

export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value)}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  // Variações pequenas são comuns em contas grandes; 1 casa decimal viraria "0%".
  const decimals = Math.abs(value) < 1 ? 2 : 1;
  return `${sign}${value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

export function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function issuesBlock(
  issues: Array<{ assetName: string; surface: string; metric?: string; message: string }>,
): string {
  if (issues.length === 0) return "";
  const lines = issues.map(
    (i) =>
      `- **${i.assetName}** (${i.surface}${i.metric ? `, ${i.metric}` : ""}): ${i.message}`,
  );
  return `\n\n### Avisos\n\n${lines.join("\n")}`;
}
