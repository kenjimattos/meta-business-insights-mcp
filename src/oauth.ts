/**
 * Authorization server do conector, com login pelo Google.
 *
 * O que ele resolve: a janela "Add custom connector" do Claude não tem campo
 * para bearer fixo, e a ponte `mcp-remote` roda na máquina de quem usa — no
 * celular não há máquina. Um conector remoto com OAuth vive na conta, então
 * aparece no Desktop, no claude.ai e no app de uma vez só.
 *
 * O que ele deliberadamente *não* faz: não fala com a Graph API e não decide o
 * que a pessoa alcança no Meta. O `META_ACCESS_TOKEN` continua único, na VPS. O
 * Google entra uma vez, no login, só para dizer quem é a pessoa; a
 * `MCP_ALLOWED_EMAILS` diz se ela entra. Nenhum segredo é distribuído para
 * ninguém.
 *
 * Revogação continua sendo apagar uma linha e reiniciar: as sessões são
 * ancoradas no e-mail e o boot descarta as que não estão mais na allowlist —
 * access token e refresh token juntos.
 *
 * O cliente se registra sozinho (RFC 7591), que é o que permite deixar os
 * campos avançados da janela em branco. A pessoa preenche dois campos: nome e
 * URL.
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

import { sha256, type AllowedUser } from "./auth.js";
import {
  exchangeGoogleCode,
  googleAuthorizationUrl,
  GoogleLoginError,
  type GoogleConfig,
} from "./google.js";

/** Vida do access token. Curto porque o refresh é automático e invisível. */
const ACCESS_TTL_SECONDS = 3600;

/** Vida do código de autorização. O Claude troca em segundos; 10 min é folga. */
const CODE_TTL_MS = 10 * 60_000;

/** Janela para a pessoa escolher a conta no Google e voltar. */
const PENDING_TTL_MS = 10 * 60_000;

/** Teto de clientes guardados, para o `/register` público não crescer sem fim. */
const MAX_CLIENTS = 500;

/** Teto do corpo do `/register`, pelo mesmo motivo. */
const MAX_REGISTRATION_BYTES = 16 * 1024;

/**
 * Registros por origem, por janela. O Claude chama o `/register` duas vezes ao
 * adicionar um conector, então dez é folga para várias pessoas atrás do mesmo
 * IP de escritório e ainda assim longe do que uma enxurrada precisaria.
 */
const REGISTER_LIMIT = 10;
const REGISTER_WINDOW_MS = 10 * 60_000;

/** Teto de origens rastreadas pelo limitador, para ele mesmo não virar o vazamento. */
const MAX_RATE_KEYS = 10_000;

/** Teto de logins em andamento. O `/authorize` não exige autenticação. */
const MAX_PENDING = 1000;

export interface OAuthConfig {
  /** URL pública do servidor, sem barra final. Vira o `issuer`. */
  issuer: string;
  clientsFile: string;
  sessionFile: string;
}

export function loadOAuthConfig(dataDir: string): OAuthConfig | undefined {
  const issuer = process.env.MCP_OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer) return undefined;

  if (!issuer.startsWith("https://") && !issuer.startsWith("http://localhost")) {
    throw new Error(
      `MCP_OAUTH_ISSUER precisa ser https:// (recebido: ${issuer}). ` +
        "O Google recusa redirect_uri sem TLS, e o código de autorização " +
        "viajaria em texto claro.",
    );
  }

  return {
    issuer,
    clientsFile: join(dataDir, "oauth-clients.json"),
    sessionFile: join(dataDir, "oauth-sessions.json"),
  };
}

interface RegisteredClient {
  clientId: string;
  /** Digest do segredo, ou `null` para cliente público (só PKCE). */
  secretDigest: string | null;
  redirectUris: string[];
  name: string;
  createdAt: number;
}

interface Session {
  email: string;
  clientId: string;
  accessDigest: string;
  accessExpiresAt: number;
  refreshDigest: string;
}

interface PendingCode {
  email: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

/** Pedido do Claude parado enquanto a pessoa escolhe a conta no Google. */
interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  /** O `state` do Claude — diferente do nosso, que vai para o Google. */
  clientState: string;
  challenge: string;
  expiresAt: number;
}

function hex(value: string): string {
  return sha256(value).toString("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Arquivo JSON com escrita atômica (tmp + rename) e modo 0600.
 *
 * O rename importa: o restart do systemd pode cair no meio de um flush, e um
 * JSON truncado deslogaria a equipe inteira.
 */
function persistJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // Ausente ou corrompido: começar vazio custa um login novo, enquanto
    // abortar o boot deixaria o servidor fora do ar.
    return fallback;
  }
}

/**
 * Janela deslizante por origem, em memória.
 *
 * Existe para o `/register`, que é público por especificação — não há como
 * exigir credencial de quem ainda não tem nenhuma. O limite não é o que
 * protege os registros da equipe (isso é o despejo seletivo abaixo); é o que
 * evita que a enxurrada chegue a custar disco e CPU.
 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  /** `true` libera e consome uma vaga. */
  take(key: string, now = Date.now()): boolean {
    // Varrer a cada chamada seria O(origens) por request. Uma vez por janela
    // basta, porque o que se acumula entre varreduras tem o teto de chaves.
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);

    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      this.sweep(now);
      // Cheio mesmo depois da varredura são milhares de origens distintas
      // registrando na mesma janela, que não é uso real. Recusar é melhor que
      // guardar: quem já tem conector segue funcionando de qualquer forma,
      // porque sessão viva protege o registro do despejo.
      if (this.hits.size >= this.maxKeys) return false;
    }

    const fresh = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.set(key, fresh);
    if (fresh.length >= this.limit) return false;

    fresh.push(now);
    return true;
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
    this.lastSweep = now;
  }
}

/**
 * Clientes registrados. Precisa persistir: o Claude registra uma vez e guarda o
 * `client_id` na conta — se a lista sumisse no restart, todo mundo cairia num
 * `invalid_client` sem forma de se recuperar sozinho.
 */
class ClientStore {
  private clients: RegisteredClient[];

  constructor(private readonly file: string) {
    this.clients = readJson<{ clients?: RegisteredClient[] }>(file, {}).clients ?? [];
  }

  find(clientId: string): RegisteredClient | undefined {
    return this.clients.find((c) => c.clientId === clientId);
  }

  /**
   * Guarda o registro, abrindo espaço só entre os que ninguém está usando.
   *
   * `inUse` são os clientes com sessão viva. Sem essa distinção, o teto vira
   * uma arma: o `/register` é público, e quinhentos registros anônimos
   * empurrariam para fora os conectores reais da equipe — cada pessoa caindo
   * num `invalid_client` do qual não se recupera sozinha, porque a saída é
   * remover e readicionar o conector. Descartar quem nunca completou um login
   * é gratuito: aquele registro não vale nada para ninguém.
   *
   * Se sobrar só cliente em uso, a lista passa do teto de propósito. Ela é
   * limitada na prática por quantas pessoas estão na allowlist, e estourar a
   * contagem é muito melhor que deslogar alguém que está trabalhando.
   */
  add(client: RegisteredClient, inUse: Set<string>): { evicted: number; total: number } {
    this.clients.push(client);

    let evicted = 0;
    const excess = this.clients.length - MAX_CLIENTS;
    if (excess > 0) {
      // O recém-criado também é poupado: ele ainda não tem sessão, mas o
      // `/token` está a segundos de distância.
      const doomed = new Set(
        this.clients
          .filter((c) => c.clientId !== client.clientId && !inUse.has(c.clientId))
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, excess)
          .map((c) => c.clientId),
      );
      if (doomed.size > 0) {
        this.clients = this.clients.filter((c) => !doomed.has(c.clientId));
        evicted = doomed.size;
      }
    }

    persistJson(this.file, { clients: this.clients });
    return { evicted, total: this.clients.length };
  }
}

/**
 * Sessões em memória, espelhadas em disco. O arquivo guarda só digests — vazar
 * o backup não devolve nenhum token utilizável.
 */
class SessionStore {
  private sessions: Session[];

  constructor(private readonly file: string) {
    this.sessions = readJson<{ sessions?: Session[] }>(file, {}).sessions ?? [];
  }

  /**
   * Descarta sessões de quem saiu da allowlist. Rodada no boot, é o que
   * transforma "apagar a linha e reiniciar" em revogação de verdade, inclusive
   * do refresh token.
   *
   * Sessões com access token vencido ficam — o refresh não expira, e é ele que
   * evita que a equipe refaça login toda hora.
   */
  prune(allowed: Set<string>): number {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => allowed.has(s.email));
    const removed = before - this.sessions.length;
    if (removed > 0) persistJson(this.file, { sessions: this.sessions });
    return removed;
  }

  /**
   * Clientes com sessão viva. É o que separa, na hora do despejo, o conector
   * que alguém usa todo dia do registro que nunca completou um login.
   */
  activeClientIds(): Set<string> {
    return new Set(this.sessions.map((s) => s.clientId));
  }

  create(email: string, clientId: string): { access: string; refresh: string } {
    const access = randomToken();
    const refresh = randomToken();
    this.sessions.push({
      email,
      clientId,
      accessDigest: hex(access),
      accessExpiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
      refreshDigest: hex(refresh),
    });
    persistJson(this.file, { sessions: this.sessions });
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
    persistJson(this.file, { sessions: this.sessions });
    return access;
  }
}

export class AuthorizationServer {
  private readonly clients: ClientStore;
  private readonly sessions: SessionStore;
  private readonly codes = new Map<string, PendingCode>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly registerLimit = new RateLimiter(
    REGISTER_LIMIT,
    REGISTER_WINDOW_MS,
    MAX_RATE_KEYS,
  );

  constructor(
    private readonly config: OAuthConfig,
    private readonly google: GoogleConfig,
    private readonly users: AllowedUser[],
    private readonly log: (message: string) => void,
  ) {
    this.clients = new ClientStore(config.clientsFile);
    this.sessions = new SessionStore(config.sessionFile);

    const removed = this.sessions.prune(new Set(users.map((u) => u.email)));
    if (removed > 0) log(`${removed} sessão(ões) descartada(s): fora da allowlist`);
  }

  /** Documento RFC 8414, servido pelo helper do SDK em `http.ts`. */
  metadata(): OAuthMetadata {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/authorize`,
      token_endpoint: `${this.config.issuer}/token`,
      // É o que permite deixar Client ID e Secret em branco na janela.
      registration_endpoint: `${this.config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      // Só S256: `plain` não protege contra interceptação do código.
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
      scopes_supported: ["write"],
    };
  }

  /**
   * Verificador do `/mcp` para sessões OAuth. `http.ts` encadeia este com o de
   * bearer estático, que segue valendo como saída de emergência.
   */
  verifyAccessToken = async (token: string): Promise<AuthInfo> => {
    const session = this.sessions.findByAccess(token);
    if (!session) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token inválido.");

    if (session.accessExpiresAt <= Date.now()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Sessão expirada.");
    }

    // Relê os scopes da lista viva em vez de congelá-los na sessão: conceder
    // `:write` a alguém passa a valer no próximo restart, sem relogin.
    const user = this.findUser(session.email);
    if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Acesso revogado.");

    return {
      token,
      clientId: user.email,
      scopes: user.scopes,
      expiresAt: Math.floor(session.accessExpiresAt / 1000),
    };
  };

  private findUser(email: string): AllowedUser | undefined {
    return this.users.find((u) => u.email === email);
  }

  /**
   * Roteia as rotas do AS. Devolve `undefined` quando o caminho não é dele,
   * para `http.ts` seguir com o roteamento normal.
   */
  async handle(
    request: Request,
    url: URL,
    clientIp: string,
  ): Promise<Response | undefined> {
    if (url.pathname === "/register") {
      if (request.method === "OPTIONS") return preflight("POST");
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!this.registerLimit.take(clientIp)) {
        this.log(`/register recusado: limite por origem (${clientIp})`);
        return tooManyRequests();
      }
      return this.register(request);
    }

    if (url.pathname === "/authorize") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return this.authorize(url);
    }

    if (url.pathname === "/oauth/google/callback") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return this.googleCallback(url);
    }

    if (url.pathname === "/token") {
      if (request.method === "OPTIONS") return preflight("POST");
      if (request.method !== "POST") return methodNotAllowed("POST");
      return this.token(request);
    }

    return undefined;
  }

  /** Dynamic Client Registration (RFC 7591). */
  private async register(request: Request): Promise<Response> {
    const raw = await request.text();
    if (raw.length > MAX_REGISTRATION_BYTES) {
      return oauthError("invalid_client_metadata", "Corpo grande demais.");
    }

    let metadata: {
      redirect_uris?: unknown;
      client_name?: unknown;
      token_endpoint_auth_method?: unknown;
    };
    try {
      metadata = JSON.parse(raw);
    } catch {
      return oauthError("invalid_client_metadata", "JSON inválido.");
    }

    const redirectUris = Array.isArray(metadata.redirect_uris)
      ? metadata.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];

    if (redirectUris.length === 0) {
      return oauthError("invalid_redirect_uri", "redirect_uris é obrigatório.");
    }
    // Mesmo critério do /authorize: https, ou loopback (o Desktop abre um
    // servidor efêmero em porta variável, RFC 8252).
    const invalid = redirectUris.find((u) => !isUsableRedirect(u));
    if (invalid) {
      return oauthError("invalid_redirect_uri", `redirect_uri inválido: ${invalid}`);
    }

    // Cliente público declara `none` e se autentica só por PKCE. Guardar o que
    // ele declarou é melhor do que apostar num comportamento do Claude: o
    // /token passa a exigir de cada cliente exatamente o que ele prometeu.
    const isPublic = metadata.token_endpoint_auth_method === "none";
    const clientId = randomToken();
    const secret = isPublic ? undefined : randomToken();
    const name =
      typeof metadata.client_name === "string" && metadata.client_name.trim()
        ? metadata.client_name.trim().slice(0, 80)
        : "cliente sem nome";

    const { evicted, total } = this.clients.add(
      {
        clientId,
        secretDigest: secret ? hex(secret) : null,
        redirectUris,
        name,
        createdAt: Date.now(),
      },
      this.sessions.activeClientIds(),
    );
    this.log(`/register: "${name}" registrado (${isPublic ? "público" : "confidencial"})`);
    if (evicted > 0) {
      this.log(`/register: ${evicted} registro(s) sem sessão descartado(s) pelo teto`);
    }
    if (total > MAX_CLIENTS) {
      this.log(`/register: ${total} registros, acima do teto — todos com sessão viva`);
    }

    return json(
      {
        client_id: clientId,
        ...(secret ? { client_secret: secret } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        // 0 = não expira. Rotacionar exigiria um endpoint de gestão que este
        // servidor não tem.
        ...(secret ? { client_secret_expires_at: 0 } : {}),
        redirect_uris: redirectUris,
        client_name: name,
        token_endpoint_auth_method: isPublic ? "none" : "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  /** Valida o pedido do Claude e manda a pessoa para o Google. */
  private authorize(url: URL): Response {
    const params = url.searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";

    // client_id e redirect_uri inválidos nunca podem virar redirect: seria um
    // open redirect e entregaria o código a quem escolheu a URL.
    const client = clientId ? this.clients.find(clientId) : undefined;
    if (!client) {
      this.log(`/authorize recusado: client_id desconhecido`);
      return errorPage(
        "Conector não reconhecido",
        "Remova o conector e adicione de novo — o registro dele não existe " +
          "mais neste servidor.",
      );
    }
    if (!client.redirectUris.includes(redirectUri)) {
      this.log(`/authorize recusado: redirect_uri fora do registro "${redirectUri}"`);
      return errorPage(
        "Callback não permitido",
        "A URL de retorno não é uma das que este conector registrou.",
      );
    }

    const challenge = params.get("code_challenge") ?? "";
    const state = params.get("state");
    if (!challenge || params.get("code_challenge_method") !== "S256") {
      return redirectError(redirectUri, state, "invalid_request", "PKCE S256 obrigatório.");
    }
    if (params.get("response_type") !== "code") {
      return redirectError(redirectUri, state, "unsupported_response_type", "Só response_type=code.");
    }

    // Dois `state` no mesmo fluxo: este é o nosso, para o Google; o do Claude
    // fica guardado aqui dentro e volta no redirect final.
    // Varre antes de guardar mais um: o `/authorize` não pede credencial, então
    // quem registrou um cliente pode chamá-lo em série.
    sweepExpired(this.pending);
    if (this.pending.size >= MAX_PENDING) {
      // Todos ainda dentro do prazo. Descartar o mais antigo custa, no pior
      // caso, um login em andamento que se resolve tentando de novo — bem
      // menos que deixar a memória crescer com abas que ninguém abriu.
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }

    const googleState = randomToken();
    this.pending.set(googleState, {
      clientId,
      redirectUri,
      clientState: state ?? "",
      challenge,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    return new Response(null, {
      status: 302,
      headers: { location: googleAuthorizationUrl(this.google, googleState) },
    });
  }

  /** Volta do Google: valida a identidade e emite o código para o Claude. */
  private async googleCallback(url: URL): Promise<Response> {
    const params = url.searchParams;

    if (params.get("error")) {
      return errorPage("Login cancelado", `O Google respondeu: ${params.get("error")}`);
    }

    const state = params.get("state") ?? "";
    const pending = state ? this.pending.get(state) : undefined;
    // Uso único: consumir antes de validar impede replay do mesmo callback.
    if (state) this.pending.delete(state);

    if (!pending || pending.expiresAt <= Date.now()) {
      return errorPage(
        "Sessão de login expirada",
        "Tente conectar de novo pelo Claude — o pedido demorou mais que o " +
          "permitido ou já foi usado.",
      );
    }

    const code = params.get("code") ?? "";
    if (!code) return errorPage("Login incompleto", "O Google não devolveu um código.");

    let identity;
    try {
      identity = await exchangeGoogleCode(this.google, code);
    } catch (err) {
      const detail = err instanceof GoogleLoginError ? err.message : "Falha inesperada.";
      this.log(`/oauth/google/callback: login recusado — ${detail}`);
      return errorPage("Não foi possível entrar", detail);
    }

    const user = this.findUser(identity.email);
    if (!user) {
      this.log(`/oauth/google/callback: ${identity.email} fora da allowlist`);
      return errorPage(
        "Conta sem acesso",
        `${identity.email} não está na lista de quem pode usar este servidor. ` +
          "Peça para ser incluído e tente de novo.",
      );
    }

    // Código emitido e nunca trocado (a pessoa fechou a aba) ficaria guardado
    // para sempre — o `exchangeCode` só apaga o que alguém veio buscar.
    sweepExpired(this.codes);

    const authCode = randomToken();
    this.codes.set(hex(authCode), {
      email: user.email,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      challenge: pending.challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.log(`/authorize: código emitido para ${user.email}`);

    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", authCode);
    if (pending.clientState) target.searchParams.set("state", pending.clientState);
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());

    const client = this.authenticateClient(request, form);
    if (!client) {
      return oauthError("invalid_client", "client_id ou client_secret incorretos.", 401);
    }

    const grant = form.get("grant_type");
    if (grant === "authorization_code") return this.exchangeCode(form, client);
    if (grant === "refresh_token") return this.refresh(form, client);
    return oauthError("unsupported_grant_type", `grant_type "${grant}" não suportado.`);
  }

  private authenticateClient(
    request: Request,
    form: URLSearchParams,
  ): RegisteredClient | undefined {
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

    const client = id ? this.clients.find(id) : undefined;
    if (!client) return undefined;

    // Cliente público: sem segredo para conferir, quem protege o código é o
    // PKCE. Cliente confidencial: o segredo é obrigatório, sempre.
    if (client.secretDigest === null) return client;
    if (!secret) return undefined;
    return timingSafeEqual(sha256(secret), Buffer.from(client.secretDigest, "hex"))
      ? client
      : undefined;
  }

  private exchangeCode(form: URLSearchParams, client: RegisteredClient): Response {
    const code = form.get("code") ?? "";
    const key = hex(code);
    const pending = this.codes.get(key);

    // Uso único, e consumido *antes* de validar: uma corrida não troca o mesmo
    // código duas vezes, e uma tentativa malsucedida queima o código em vez de
    // deixá-lo disponível para a próxima. Um código que alguém já tentou usar
    // indevidamente não deve continuar valendo.
    this.codes.delete(key);

    if (!pending || pending.expiresAt <= Date.now()) {
      return oauthError("invalid_grant", "Código inválido ou expirado.");
    }
    // Sem isto, um cliente registrado poderia trocar o código emitido para
    // outro.
    if (pending.clientId !== client.clientId) {
      return oauthError("invalid_grant", "Código emitido para outro cliente.");
    }
    if (form.get("redirect_uri") !== pending.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri diferente do usado no /authorize.");
    }

    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || pkceChallenge(verifier) !== pending.challenge) {
      return oauthError("invalid_grant", "code_verifier não confere.");
    }

    const user = this.findUser(pending.email);
    if (!user) return oauthError("invalid_grant", "Acesso revogado.");

    const { access, refresh } = this.sessions.create(user.email, client.clientId);
    this.log(`/token: sessão criada para ${user.email}`);
    return tokenResponse(access, refresh, user.scopes);
  }

  private refresh(form: URLSearchParams, client: RegisteredClient): Response {
    const token = form.get("refresh_token") ?? "";
    const session = token ? this.sessions.findByRefresh(token) : undefined;
    if (!session || session.clientId !== client.clientId) {
      return oauthError("invalid_grant", "Refresh token inválido.");
    }

    // A checagem que faz a revogação valer: saiu da allowlist, o refresh para
    // de funcionar no próximo ciclo de uma hora.
    const user = this.findUser(session.email);
    if (!user) {
      this.log(`/token: refresh negado, acesso revogado (${session.email})`);
      return oauthError("invalid_grant", "Acesso revogado.");
    }

    const access = this.sessions.renew(session);
    return tokenResponse(access, token, user.scopes);
  }

}

/** Limpa o que venceu — logins abandonados e códigos que ninguém veio trocar. */
function sweepExpired(map: Map<string, { expiresAt: number }>): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

/**
 * https, ou loopback em qualquer porta: o Claude Desktop sobe um servidor
 * efêmero e a porta muda a cada execução, então casar exato é inviável.
 */
function isUsableRedirect(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
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

function tooManyRequests(): Response {
  return new Response(
    JSON.stringify({
      error: "too_many_requests",
      error_description: "Registros demais desta origem. Tente de novo em alguns minutos.",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "retry-after": String(Math.ceil(REGISTER_WINDOW_MS / 1000)),
      },
    },
  );
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

/**
 * Única página que este servidor renderiza. O caminho feliz é só redirect —
 * a pessoa vê a tela do Google, não uma nossa. Sem asset externo: é servida
 * antes de qualquer autenticação.
 */
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
