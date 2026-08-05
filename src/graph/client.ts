/**
 * Cliente HTTP da Graph API do Meta.
 *
 * Cuida do que quase sempre dá dor de cabeça em integrações com a Graph API:
 * paginação por cursor, backoff em rate limit / erros transitórios, e o uso do
 * Page Access Token correto (Page e Instagram Insights exigem token da Página,
 * não o token do usuário/system user).
 */

export interface GraphErrorBody {
  message: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export class GraphError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, body: GraphErrorBody) {
    const detail = body.error_user_msg ? ` (${body.error_user_msg})` : "";
    super(`Graph API ${status} em ${path}: ${body.message}${detail}`);
    this.name = "GraphError";
    this.status = status;
    this.path = path;
    this.code = body.code;
    this.subcode = body.error_subcode;
    this.type = body.type;
    this.fbtraceId = body.fbtrace_id;
  }

  /** Erros de limite de uso: vale esperar e tentar de novo. */
  get isRateLimit(): boolean {
    return [4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004].includes(
      this.code ?? -1,
    );
  }

  /** Métrica inexistente/descontinuada — não adianta repetir. */
  get isInvalidMetric(): boolean {
    return /invalid metric|metric.*not.*(valid|supported)|\(#100\)/i.test(
      this.message,
    );
  }
}

export interface GraphPage<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
    previous?: string;
  };
}

export type ParamValue = string | number | boolean | undefined | null;
export type Params = Record<string, ParamValue>;

export interface RequestOptions {
  /** Sobrescreve o token (ex.: Page Access Token). */
  token?: string;
  /** Máximo de páginas a seguir em getAll (default 25). */
  maxPages?: number;
  signal?: AbortSignal;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GraphClient {
  private readonly base: string;
  /** Contadores de uso reportados pelo header x-business-use-case-usage. */
  lastUsageHeader: string | undefined;

  constructor(
    private readonly defaultToken: string,
    readonly apiVersion: string,
    host = "https://graph.facebook.com",
  ) {
    this.base = `${host}/${apiVersion}`;
  }

  private buildUrl(path: string, params: Params, token: string): string {
    const clean = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(`${this.base}/${clean}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("access_token", token);
    return url.toString();
  }

  /** GET em um nó/edge, com retry e backoff exponencial. */
  async get<T = unknown>(
    path: string,
    params: Params = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const token = opts.token ?? this.defaultToken;
    const url = this.buildUrl(path, params, token);
    return this.fetchWithRetry<T>(url, path, opts.signal);
  }

  private async fetchWithRetry<T>(
    url: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal,
        });
      } catch (err) {
        lastError = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      const usage = res.headers.get("x-business-use-case-usage");
      if (usage) this.lastUsageHeader = usage;

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Resposta não-JSON da Graph API em ${path}: ${text.slice(0, 300)}`,
        );
      }

      if (res.ok) return json as T;

      const body = (json as { error?: GraphErrorBody }).error ?? {
        message: text.slice(0, 300),
      };
      const error = new GraphError(res.status, path, body);
      lastError = error;

      const retryable = RETRY_STATUS.has(res.status) || error.isRateLimit;
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;

      // Rate limit do Meta costuma exigir espera maior que um 5xx comum.
      const baseDelay = error.isRateLimit ? 5_000 : 700;
      await sleep(baseDelay * 2 ** (attempt - 1));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Falha ao chamar ${path}`);
  }

  /** GET seguindo paginação por cursor e concatenando `data`. */
  async getAll<T = unknown>(
    path: string,
    params: Params = {},
    opts: RequestOptions = {},
  ): Promise<T[]> {
    const maxPages = opts.maxPages ?? 25;
    const token = opts.token ?? this.defaultToken;
    let url = this.buildUrl(path, { limit: 100, ...params }, token);
    const out: T[] = [];

    for (let page = 0; page < maxPages; page++) {
      const res = await this.fetchWithRetry<GraphPage<T>>(
        url,
        path,
        opts.signal,
      );
      if (Array.isArray(res.data)) out.push(...res.data);
      const next = res.paging?.next;
      if (!next) break;
      url = next;
    }

    return out;
  }

  /**
   * Executa várias chamadas GET em um único request (batch API).
   * Cada item retorna sucesso ou erro isoladamente — um erro em uma conta não
   * derruba as demais, o que importa quando o portfólio tem dezenas de ativos.
   */
  async batchGet<T = unknown>(
    requests: Array<{ path: string; params?: Params; token?: string }>,
    opts: RequestOptions = {},
  ): Promise<Array<{ ok: true; data: T } | { ok: false; error: GraphError }>> {
    const results: Array<
      { ok: true; data: T } | { ok: false; error: GraphError }
    > = [];

    // A Graph API aceita no máximo 50 operações por batch.
    for (let i = 0; i < requests.length; i += 50) {
      const chunk = requests.slice(i, i + 50);
      const payload = chunk.map((req) => {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(req.params ?? {})) {
          if (value === undefined || value === null || value === "") continue;
          qs.set(key, String(value));
        }
        // O token por operação precisa viajar na query string do relative_url.
        // Como campo do objeto da operação, a Graph API ignora e aplica o token
        // do envelope — o que faz Page Insights responder (#190).
        if (req.token) qs.set("access_token", req.token);
        const clean = req.path.startsWith("/") ? req.path.slice(1) : req.path;
        const relative = qs.toString() ? `${clean}?${qs}` : clean;
        return { method: "GET", relative_url: relative };
      });

      const body = new URLSearchParams({
        access_token: opts.token ?? this.defaultToken,
        include_headers: "false",
        batch: JSON.stringify(payload),
      });

      const res = await fetch(`${this.base}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: opts.signal,
      });

      const outer = (await res.json()) as
        | Array<{ code: number; body: string } | null>
        | { error?: GraphErrorBody };

      if (!Array.isArray(outer)) {
        throw new GraphError(res.status, "batch", outer.error ?? {
          message: "Resposta de batch inesperada",
        });
      }

      for (let j = 0; j < chunk.length; j++) {
        const item = outer[j];
        const path = chunk[j]!.path;
        if (!item) {
          results.push({
            ok: false,
            error: new GraphError(504, path, {
              message: "Operação do batch expirou (timeout)",
            }),
          });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(item.body);
        } catch {
          parsed = { error: { message: item.body.slice(0, 300) } };
        }
        const errBody = (parsed as { error?: GraphErrorBody }).error;
        if (item.code >= 400 || errBody) {
          results.push({
            ok: false,
            error: new GraphError(
              item.code,
              path,
              errBody ?? { message: "Erro desconhecido no batch" },
            ),
          });
        } else {
          results.push({ ok: true, data: parsed as T });
        }
      }
    }

    return results;
  }
}
