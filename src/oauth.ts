/**
 * Authorization server mínimo, para que o conector do Claude funcione no
 * celular e no claude.ai.
 *
 * O que ele *não* faz: não fala com o Meta e não cria identidade nova. O
 * `META_ACCESS_TOKEN` continua sendo um só, na VPS, e os bearers pessoais de
 * `MCP_HTTP_TOKENS` continuam sendo a credencial — a diferença é que agora a
 * pessoa digita o dela uma vez numa página deste servidor, em vez de colar num
 * arquivo de configuração local. O Claude sai dali com uma sessão OAuth e
 * renova sozinho.
 *
 * Por que isso destrava o celular: a ponte `mcp-remote` roda na máquina de
 * quem usa, e no telefone não há máquina. Um conector remoto com OAuth vive na
 * conta, não no aparelho.
 *
 * Cada sessão fica amarrada ao *digest* do token estático que a originou, não
 * ao nome. Assim revogar continua sendo apagar a linha de `MCP_HTTP_TOKENS` e
 * reiniciar: as sessões daquela pessoa morrem junto, sem varredura manual.
 * Trocar o token de alguém tem o mesmo efeito, de graça.
 *
 * Não há `registration_endpoint` de propósito. O Claude aceita client_id e
 * client_secret fixos nos campos avançados de "Add custom connector", o que
 * dispensa Dynamic Client Registration e um endpoint a menos para proteger.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";

import { sha256, type StaticToken } from "./auth.js";

/** Vida do access token. Curto porque o refresh é automático e invisível. */
const ACCESS_TTL_SECONDS = 3600;

/** Vida do código de autorização. O Claude troca em segundos; 10 min é folga. */
const CODE_TTL_MS = 10 * 60_000;

/**
 * Callbacks aceitos por padrão. O Claude web e o app usam os dois primeiros; o
 * Desktop abre um servidor local em porta variável, tratado à parte por ser
 * loopback (RFC 8252).
 */
const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export interface OAuthConfig {
  /** URL pública do servidor, sem barra final. Vira o `issuer`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Allowlist exata de redirect_uri, além do loopback. */
  redirectUris: string[];
  /** Arquivo onde as sessões sobrevivem ao restart. */
  sessionFile: string;
}

/**
 * Lê a configuração do ambiente. Devolve `undefined` quando `MCP_OAUTH_ISSUER`
 * não está definido — sem isso o servidor segue exatamente como antes, só com
 * bearer estático, e nada quebra para quem já usa a ponte local.
 */
export function loadOAuthConfig(dataDir: string): OAuthConfig | undefined {
  const issuer = process.env.MCP_OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer) return undefined;

  const clientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();

  // Falha ao subir, não na primeira tentativa de login: um issuer anunciado
  // sem cliente configurado deixa a equipe travada numa tela de erro do Claude
  // que não diz o que houve.
  if (!clientId || !clientSecret) {
    throw new Error(
      "MCP_OAUTH_ISSUER definido, mas MCP_OAUTH_CLIENT_ID e/ou " +
        "MCP_OAUTH_CLIENT_SECRET estão vazios. Gere os dois com " +
        "`openssl rand -hex 16` e `openssl rand -hex 32`.",
    );
  }
  if (!issuer.startsWith("https://") && !issuer.startsWith("http://localhost")) {
    throw new Error(
      `MCP_OAUTH_ISSUER precisa ser https:// (recebido: ${issuer}). ` +
        "Sem TLS o token pessoal viaja em texto claro no POST do /authorize.",
    );
  }

  const extra = (process.env.MCP_OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUris: [...DEFAULT_REDIRECT_URIS, ...extra],
    sessionFile: join(dataDir, "oauth-sessions.json"),
  };
}

interface Session {
  /** Rótulo da pessoa, herdado do MCP_HTTP_TOKENS. Só para log. */
  name: string;
  /** Digest do token estático que autorizou. A âncora da revogação. */
  staticDigest: string;
  accessDigest: string;
  accessExpiresAt: number;
  refreshDigest: string;
}

interface PendingCode {
  staticDigest: string;
  name: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

function hex(value: string): string {
  return sha256(value).toString("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Comparação de segredos em tempo constante, tolerante a tamanhos diferentes. */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * Sessões em memória, espelhadas em disco.
 *
 * O arquivo guarda só digests — vazar o backup não devolve nenhum token
 * utilizável. A escrita é atômica (tmp + rename) porque o restart do systemd
 * pode cair no meio de um flush e um JSON truncado deslogaria a equipe.
 */
class SessionStore {
  private sessions: Session[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: Session[] };
      this.sessions = parsed.sessions ?? [];
    } catch {
      // Arquivo ausente ou corrompido: começar vazio custa um login novo,
      // enquanto abortar o boot deixaria o servidor fora do ar.
      this.sessions = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }

  /**
   * Descarta sessões órfãs: aquelas cujo token estático saiu do
   * `MCP_HTTP_TOKENS`. Rodada no boot, é o que transforma "apagar a linha e
   * reiniciar" em revogação de verdade, inclusive do refresh token.
   *
   * Sessões com access token vencido ficam — o refresh não expira, e é ele que
   * evita que a equipe refaça login toda hora.
   */
  prune(live: Set<string>): void {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => live.has(s.staticDigest));
    if (this.sessions.length !== before) this.persist();
  }

  create(name: string, staticDigest: string): { access: string; refresh: string } {
    const access = randomToken();
    const refresh = randomToken();
    this.sessions.push({
      name,
      staticDigest,
      accessDigest: hex(access),
      accessExpiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
      refreshDigest: hex(refresh),
    });
    this.persist();
    return { access, refresh };
  }

  findByAccess(token: string): Session | undefined {
    const digest = hex(token);
    return this.sessions.find((s) => s.accessDigest === digest);
  }

  findByRefresh(token: string): Session | undefined {
    const digest = hex(token);
    return this.sessions.find((s) => s.refreshDigest === digest);
  }

  /** Rotaciona só o access token; o refresh continua valendo. */
  renew(session: Session): string {
    const access = randomToken();
    session.accessDigest = hex(access);
    session.accessExpiresAt = Date.now() + ACCESS_TTL_SECONDS * 1000;
    this.persist();
    return access;
  }
}

export class AuthorizationServer {
  private readonly store: SessionStore;
  private readonly codes = new Map<string, PendingCode>();

  constructor(
    private readonly config: OAuthConfig,
    private readonly tokens: StaticToken[],
    private readonly log: (message: string) => void,
  ) {
    this.store = new SessionStore(config.sessionFile);
    this.store.prune(new Set(tokens.map((t) => t.digest.toString("hex"))));
  }

  /** Documento RFC 8414, servido pelo helper do SDK em `http.ts`. */
  metadata(): OAuthMetadata {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/authorize`,
      token_endpoint: `${this.config.issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      // Só S256: `plain` não protege contra interceptação do código.
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      scopes_supported: ["write"],
    };
  }

  /**
   * Verificador do `/mcp` para sessões OAuth. `http.ts` encadeia este com o de
   * bearer estático, para não quebrar quem já usa a ponte local nem o `curl`
   * de diagnóstico do README.
   */
  verifyAccessToken = async (token: string): Promise<AuthInfo> => {
    const session = this.store.findByAccess(token);
    if (!session) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token inválido.");

    if (session.accessExpiresAt <= Date.now()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Sessão expirada.");
    }

    // Relê os scopes da lista viva em vez de congelá-los na sessão: adicionar
    // `:write` para alguém passa a valer no próximo restart, sem relogin.
    const owner = this.findStatic(session.staticDigest);
    if (!owner) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Acesso revogado.");
    }

    return {
      token,
      clientId: owner.name,
      scopes: owner.scopes,
      expiresAt: Math.floor(session.accessExpiresAt / 1000),
    };
  };

  private findStatic(digest: string): StaticToken | undefined {
    return this.tokens.find((t) => t.digest.toString("hex") === digest);
  }

  private matchStatic(secret: string): StaticToken | undefined {
    const digest = sha256(secret);
    return this.tokens.find((t) => timingSafeEqual(t.digest, digest));
  }

  /**
   * Roteia as rotas do AS. Devolve `undefined` quando o caminho não é dele,
   * para `http.ts` seguir com o roteamento normal.
   */
  async handle(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return this.authorizeForm(url);
      if (request.method === "POST") return this.authorizeSubmit(request);
      return methodNotAllowed("GET, POST");
    }

    if (url.pathname === "/token") {
      if (request.method === "OPTIONS") return preflight("POST");
      if (request.method !== "POST") return methodNotAllowed("POST");
      return this.token(request);
    }

    return undefined;
  }

  /** Valida os parâmetros e devolve a tela onde a pessoa cola o token dela. */
  private authorizeForm(url: URL): Response {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") ?? "";
    const clientId = params.get("client_id") ?? "";

    // redirect_uri e client_id inválidos nunca podem virar redirect: seria um
    // open redirect e entregaria o código a quem escolheu a URL.
    if (clientId !== this.config.clientId) {
      this.log(`/authorize recusado: client_id desconhecido "${clientId}"`);
      return errorPage(
        "Client ID não confere",
        "Confira o campo OAuth Client ID nas configurações avançadas do conector.",
      );
    }
    if (!this.allowsRedirect(redirectUri)) {
      this.log(`/authorize recusado: redirect_uri não permitido "${redirectUri}"`);
      return errorPage(
        "Callback não permitido",
        `A URL ${redirectUri || "(vazia)"} não está na allowlist. ` +
          "Adicione-a em MCP_OAUTH_REDIRECT_URIS se for legítima.",
      );
    }

    const challenge = params.get("code_challenge") ?? "";
    const method = params.get("code_challenge_method") ?? "";
    if (!challenge || method !== "S256") {
      return redirectError(redirectUri, params.get("state"), "invalid_request", "PKCE S256 obrigatório.");
    }
    if (params.get("response_type") !== "code") {
      return redirectError(redirectUri, params.get("state"), "unsupported_response_type", "Só response_type=code.");
    }

    return loginPage({
      redirectUri,
      state: params.get("state") ?? "",
      challenge,
      error: null,
    });
  }

  /** Valida o token pessoal e devolve o código de autorização. */
  private async authorizeSubmit(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const redirectUri = form.get("redirect_uri") ?? "";
    const state = form.get("state") ?? "";
    const challenge = form.get("challenge") ?? "";
    const secret = form.get("token")?.trim() ?? "";

    // Revalida em vez de confiar no hidden field: o POST chega do navegador e
    // pode ter sido montado à mão.
    if (!this.allowsRedirect(redirectUri) || !challenge) {
      return errorPage("Requisição inválida", "Reinicie a conexão pelo Claude.");
    }

    const owner = secret ? this.matchStatic(secret) : undefined;
    if (!owner) {
      this.log(`/authorize: token pessoal inválido`);
      return loginPage({
        redirectUri,
        state,
        challenge,
        error: "Token não reconhecido. Confira se copiou a linha inteira.",
      });
    }

    const code = randomToken();
    this.codes.set(hex(code), {
      staticDigest: owner.digest.toString("hex"),
      name: owner.name,
      redirectUri,
      challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.log(`/authorize: código emitido para ${owner.name}`);

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());

    if (!this.authenticateClient(request, form)) {
      return oauthError("invalid_client", "client_id ou client_secret incorretos.", 401);
    }

    const grant = form.get("grant_type");
    if (grant === "authorization_code") return this.exchangeCode(form);
    if (grant === "refresh_token") return this.refresh(form);
    return oauthError("unsupported_grant_type", `grant_type "${grant}" não suportado.`);
  }

  private authenticateClient(request: Request, form: URLSearchParams): boolean {
    let id = form.get("client_id") ?? "";
    let secret = form.get("client_secret") ?? "";

    // client_secret_basic: as credenciais vêm no header, não no corpo.
    const header = request.headers.get("authorization");
    if (header?.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep > 0) {
        id = decodeURIComponent(decoded.slice(0, sep));
        secret = decodeURIComponent(decoded.slice(sep + 1));
      }
    }

    return (
      Boolean(id) &&
      Boolean(secret) &&
      secretEquals(id, this.config.clientId) &&
      secretEquals(secret, this.config.clientSecret)
    );
  }

  private exchangeCode(form: URLSearchParams): Response {
    const code = form.get("code") ?? "";
    const key = hex(code);
    const pending = this.codes.get(key);

    // Uso único: consumir antes de validar impede que uma corrida troque o
    // mesmo código duas vezes.
    this.codes.delete(key);

    if (!pending || pending.expiresAt <= Date.now()) {
      return oauthError("invalid_grant", "Código inválido ou expirado.");
    }
    if (form.get("redirect_uri") !== pending.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri diferente do usado no /authorize.");
    }

    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || pkceChallenge(verifier) !== pending.challenge) {
      return oauthError("invalid_grant", "code_verifier não confere.");
    }

    const owner = this.findStatic(pending.staticDigest);
    if (!owner) return oauthError("invalid_grant", "Acesso revogado.");

    const { access, refresh } = this.store.create(owner.name, pending.staticDigest);
    this.log(`/token: sessão criada para ${owner.name}`);
    return tokenResponse(access, refresh, owner.scopes);
  }

  private refresh(form: URLSearchParams): Response {
    const token = form.get("refresh_token") ?? "";
    const session = token ? this.store.findByRefresh(token) : undefined;
    if (!session) return oauthError("invalid_grant", "Refresh token inválido.");

    // A checagem que faz a revogação valer: sumiu do MCP_HTTP_TOKENS, o
    // refresh para de funcionar no próximo ciclo de uma hora.
    const owner = this.findStatic(session.staticDigest);
    if (!owner) {
      this.log(`/token: refresh negado, acesso revogado (${session.name})`);
      return oauthError("invalid_grant", "Acesso revogado.");
    }

    const access = this.store.renew(session);
    return tokenResponse(access, token, owner.scopes);
  }

  private allowsRedirect(uri: string): boolean {
    if (this.config.redirectUris.includes(uri)) return true;

    // Loopback com porta variável: o Claude Desktop sobe um servidor efêmero e
    // a porta muda a cada execução, então casar exato é inviável.
    try {
      const parsed = new URL(uri);
      return (
        parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      );
    } catch {
      return false;
    }
  }
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function tokenResponse(access: string, refresh: string, scopes: string[]): Response {
  return json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope: scopes.join(" "),
    },
    200,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function oauthError(code: string, description: string, status = 400): Response {
  return json({ error: code, error_description: description }, status);
}

function redirectError(
  redirectUri: string,
  state: string | null,
  code: string,
  description: string,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: target.toString() } });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { allow } });
}

function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": methods,
      "access-control-allow-headers": "authorization, content-type",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Página única, sem asset externo: é servida antes de qualquer autenticação. */
function loginPage(opts: {
  redirectUri: string;
  state: string;
  challenge: string;
  error: string | null;
}): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar ao Meta Business Insights</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { width: min(26rem, 100%); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; opacity: .75; }
  label { display: block; font-weight: 600; margin-bottom: .375rem; }
  input { width: 100%; box-sizing: border-box; padding: .625rem .75rem; font: inherit; font-family: ui-monospace, monospace; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: .5rem; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 1rem; padding: .625rem; font: inherit; font-weight: 600; border: 0; border-radius: .5rem; background: #2563eb; color: #fff; cursor: pointer; }
  .erro { padding: .75rem; border-radius: .5rem; background: color-mix(in srgb, #dc2626 15%, transparent); margin-bottom: 1rem; }
</style>
<main>
  <h1>Conectar ao Meta Business Insights</h1>
  <p>Cole o token pessoal que você recebeu. Ele fica só neste servidor — o Claude guarda uma sessão, não o token.</p>
  ${opts.error ? `<div class="erro">${escapeHtml(opts.error)}</div>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
    <input type="hidden" name="challenge" value="${escapeHtml(opts.challenge)}">
    <label for="token">Token pessoal</label>
    <input id="token" name="token" type="password" autocomplete="off" autocapitalize="off"
           autocorrect="off" spellcheck="false" required autofocus>
    <button type="submit">Autorizar</button>
  </form>
</main>
</html>`;

  return new Response(html, {
    // 200 mesmo no caso de erro de token: é a mesma tela, repetida.
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorPage(title: string, detail: string): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { width: min(26rem, 100%); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>
</html>`;

  return new Response(html, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
