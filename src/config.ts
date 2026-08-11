import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";

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
  /**
   * Libera as tools que publicam (responder e ocultar comentários).
   *
   * Desligado por padrão porque escrita é irreversível na prática: um
   * comentário publicado em nome do cliente fica visível na hora, e excluir
   * depois não desfaz quem já leu. No modo HTTP isto é apenas a primeira
   * tranca — o bearer ainda precisa do sufixo `:write`.
   */
  allowWrites: boolean;
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

  const configured = process.env.META_DATA_DIR?.trim();
  const dataDir = configured || join(homedir(), ".meta-business-insights-mcp");
  assertWritable(dataDir, Boolean(configured));

  return {
    accessToken,
    apiVersion: process.env.META_API_VERSION?.trim() || "v26.0",
    businessId: process.env.META_BUSINESS_ID?.trim() || undefined,
    dataDir,
    pageIdFilter: csv(process.env.META_PAGE_IDS),
    allowWrites: /^(1|true|yes)$/i.test(process.env.META_ALLOW_WRITES ?? ""),
  };
}

/**
 * Falha no boot se não der para escrever no `dataDir`.
 *
 * Vale o custo de tocar o disco durante a configuração porque o sintoma sem
 * isto é traiçoeiro: o servidor sobe, responde `/healthz` e autentica, e só
 * quebra quando alguém tenta gravar — no primeiro `/register`, ou de madrugada
 * no snapshot diário, que falha em silêncio e leva junto um dia da janela de
 * 30 dias do `follower_count`.
 *
 * O caso real: `META_DATA_DIR=` vazio no arquivo de produção (fácil de fazer
 * colando o bloco do `.env.example` por cima) cai no default `~/`, que não
 * existe para o usuário de sistema `mcp` — criado com `--no-create-home` e com
 * `ProtectHome=true` no unit do systemd.
 */
function assertWritable(dataDir: string, configured: boolean): void {
  const origem = configured
    ? `META_DATA_DIR=${dataDir}`
    : `${dataDir} (default, porque META_DATA_DIR está vazio ou ausente)`;

  try {
    mkdirSync(dataDir, { recursive: true });
    // Testa a permissão de verdade: o mkdir passa quando o diretório já
    // existe, mesmo pertencendo a outro usuário.
    accessSync(dataDir, constants.W_OK);
  } catch (err) {
    const causa = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sem permissão de escrita em ${origem}.\n` +
        `Causa: ${causa}\n` +
        "Na VPS, aponte META_DATA_DIR para o StateDirectory do systemd " +
        "(META_DATA_DIR=/var/lib/meta-mcp) e confira que o diretório " +
        "pertence ao usuário do serviço.",
    );
  }
}
