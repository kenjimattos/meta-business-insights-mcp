import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Carrega o .env da raiz do projeto, se existir. Node >= 20.12 traz
 * process.loadEnvFile nativo, então não precisamos da dependência dotenv.
 */
function loadDotEnv(): void {
  const candidates = [
    process.env.META_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(new URL("../.env", import.meta.url).pathname),
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // .env malformado ou runtime sem suporte: seguimos só com env vars reais.
      return;
    }
  }
}

loadDotEnv();

export interface Config {
  accessToken: string;
  apiVersion: string;
  businessId?: string;
  dataDir: string;
  /** Restringe o portfólio a estes Page IDs, se definido. */
  pageIdFilter?: string[];
}

function csv(value: string | undefined): string[] | undefined {
  const parts = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function loadConfig(): Config {
  const accessToken = process.env.META_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(
      "META_ACCESS_TOKEN não definido. Crie um arquivo .env (veja .env.example) " +
        "ou passe a variável de ambiente na configuração do Claude Desktop.",
    );
  }

  return {
    accessToken,
    apiVersion: process.env.META_API_VERSION?.trim() || "v26.0",
    businessId: process.env.META_BUSINESS_ID?.trim() || undefined,
    dataDir:
      process.env.META_DATA_DIR?.trim() ||
      join(homedir(), ".meta-business-insights-mcp"),
    pageIdFilter: csv(process.env.META_PAGE_IDS),
  };
}
