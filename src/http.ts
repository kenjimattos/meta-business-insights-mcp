#!/usr/bin/env node
/**
 * Entrypoint HTTP: o mesmo servidor MCP, servido pela rede para a equipe.
 *
 * O token do Meta fica só aqui, na VPS — quem consulta manda apenas o próprio
 * bearer. É a diferença que justifica este modo em vez de distribuir o `.env`
 * para todo mundo (veja `index.ts` para o modo stdio local).
 *
 * O processo escuta em 127.0.0.1 por padrão: quem termina o TLS e expõe para
 * fora é o reverse proxy (veja `deploy/`). Abrir direto na internet sem TLS
 * mandaria o bearer em texto claro.
 */

import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
  type AuthInfo,
} from "@modelcontextprotocol/server";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { createStaticTokenVerifier, parseAllowedEmails, parseTokens } from "./auth.js";
import { PayloadTooLargeError, toWebRequest, writeNodeResponse } from "./http-bridge.js";
import { loadGoogleConfig } from "./google.js";
import { AuthorizationServer, loadOAuthConfig } from "./oauth.js";

const port = Number(process.env.MCP_HTTP_PORT ?? 8787);
const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
const mcpPath = process.env.MCP_HTTP_PATH?.trim() || "/mcp";

const tokens = parseTokens(process.env.MCP_HTTP_TOKENS);
const staticVerifier = createStaticTokenVerifier(tokens);
const allowedUsers = parseAllowedEmails(process.env.MCP_ALLOWED_EMAILS);

const { allowWrites, dataDir } = loadConfig();

// OAuth é opcional: sem MCP_OAUTH_ISSUER o servidor segue só com bearer
// estático, do jeito que a ponte local espera.
const oauthConfig = loadOAuthConfig(dataDir);
const googleConfig = oauthConfig ? loadGoogleConfig(oauthConfig.issuer) : undefined;

// Todas as validações de configuração falham aqui, no boot, e não na primeira
// requisição: um servidor exposto por engano entrega o portfólio inteiro para
// quem descobrir a URL.
if (oauthConfig && !googleConfig) {
  throw new Error(
    "MCP_OAUTH_ISSUER definido, mas o login Google não está configurado. " +
      "Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.",
  );
}
if (googleConfig && allowedUsers.length === 0) {
  throw new Error(
    "MCP_ALLOWED_EMAILS está vazio. Sem a allowlist, qualquer conta do " +
      "domínio entraria — defina quem do time pode usar o servidor.",
  );
}
if (tokens.length === 0 && !googleConfig) {
  throw new Error(
    "Nenhuma forma de autenticação configurada. Defina MCP_ALLOWED_EMAILS " +
      "com o login Google (MCP_OAUTH_ISSUER + GOOGLE_CLIENT_*), ou " +
      "MCP_HTTP_TOKENS — sem isso qualquer pessoa com a URL lê o portfólio.",
  );
}

const oauth =
  oauthConfig && googleConfig
    ? new AuthorizationServer(oauthConfig, googleConfig, allowedUsers, log)
    : undefined;

const authMetadata = oauthConfig
  ? {
      oauthMetadata: oauth!.metadata(),
      resourceServerUrl: new URL(`${oauthConfig.issuer}${mcpPath}`),
      resourceName: "Meta Business Insights",
      scopesSupported: ["write"],
    }
  : undefined;

const resourceMetadataUrl = authMetadata
  ? getOAuthProtectedResourceMetadataUrl(authMetadata.resourceServerUrl)
  : undefined;

/**
 * Aceita as duas credenciais. A sessão OAuth vinda do login Google é o caminho
 * normal; o bearer estático cru continua valendo como saída de emergência —
 * o `curl` de diagnóstico e a ponte `mcp-remote`. Tenta o estático primeiro
 * por ser o mais barato.
 */
async function verifyAccessToken(token: string): Promise<AuthInfo> {
  try {
    return await staticVerifier.verifyAccessToken(token);
  } catch (err) {
    if (!oauth) throw err;
    return await oauth.verifyAccessToken(token);
  }
}

// Duas trancas em série para escrita: a instância precisa permitir (variável de
// ambiente) *e* o bearer daquela pessoa precisa ter o sufixo `:write`. Quem não
// tem as duas nem enxerga as tools de publicação no tools/list.
const handler = createMcpHandler(
  (ctx) =>
    createServer({
      canWrite: allowWrites && (ctx.authInfo?.scopes?.includes("write") ?? false),
    }),
  { onerror: (err) => log(`erro do handler: ${err.message}`) },
);

const server = createNodeServer((req, res) => {
  handle(req, res).catch((err) => {
    // Corpo grande demais é rejeição esperada, não erro interno: 413 e uma
    // linha de log, sem stack.
    if (err instanceof PayloadTooLargeError) {
      log(`413 ${req.method} ${req.url} de ${clientIp(req)}`);
      if (!res.headersSent) res.writeHead(413, { "content-type": "text/plain" });
      res.end("Payload Too Large");
      return;
    }
    log(`falha não tratada: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

  // Sem auth de propósito: é o que o systemd/uptime check consulta.
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: mcpPath }));
    return;
  }

  // As rotas do OAuth vêm antes da checagem de bearer: são justamente as que
  // uma pessoa ainda sem sessão precisa alcançar. O teste de caminho evita
  // consumir o corpo da requisição do `/mcp` — `toWebRequest` esgota o stream,
  // e ele só pode ser lido uma vez.
  if (oauth && authMetadata && isOAuthPath(url.pathname)) {
    const request = await toWebRequest(req);

    const discovery = oauthMetadataResponse(request, authMetadata);
    if (discovery) {
      await writeNodeResponse(res, discovery);
      return;
    }

    const handled = await oauth.handle(request, url, clientIp(req));
    if (handled) {
      log(`${handled.status} ${req.method} ${url.pathname} de ${clientIp(req)}`);
      await writeNodeResponse(res, handled);
      return;
    }
  }

  if (url.pathname !== mcpPath) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
    return;
  }

  let authInfo;
  try {
    authInfo = await verifyBearerToken(req.headers.authorization, {
      verifier: { verifyAccessToken },
      // Sem isto o Claude recebe um 401 mudo e não descobre onde autenticar.
      resourceMetadataUrl,
    });
  } catch (err) {
    log(`401 ${req.method} ${url.pathname} de ${clientIp(req)}`);
    await writeNodeResponse(res, bearerAuthChallengeResponse(err, { resourceMetadataUrl }));
    return;
  }

  const started = Date.now();
  res.on("finish", () =>
    log(`${res.statusCode} ${req.method} ${url.pathname} · ${authInfo.clientId} · ${Date.now() - started}ms`),
  );

  const request = await toWebRequest(req);
  const response = await handler.fetch(request, { authInfo });
  await writeNodeResponse(res, response);
}

function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname === "/register" ||
    pathname === "/oauth/google/callback" ||
    pathname.startsWith("/.well-known/")
  );
}

/**
 * Endereço de quem chamou, na forma em que dá para acreditar.
 *
 * O `x-forwarded-for` é uma lista, e quem chama escolhe o começo dela — o
 * proxy só *acrescenta*, no fim, o endereço que ele mesmo enxergou. Por isso
 * lemos o último elemento: o primeiro serve tanto para forjar linha de log
 * quanto para escapar de um limite por origem trocando o cabeçalho a cada
 * requisição.
 *
 * E o cabeçalho só vale quando a conexão veio do loopback, que é o desenho do
 * deploy — o Caddy termina o TLS na mesma máquina. Se o processo estiver
 * exposto direto, o `x-forwarded-for` é de quem chamou e não prova nada; aí o
 * socket é a única fonte honesta. Com o proxy em outra máquina, todo mundo cai
 * no endereço dele e o limite vira global, que é o lado seguro de errar.
 */
function clientIp(req: IncomingMessage): string {
  const socketAddress = req.socket.remoteAddress ?? "";

  if (isLoopback(socketAddress)) {
    const forwarded = req.headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const last = chain?.split(",").pop()?.trim();
    if (last) return last;
  }

  return socketAddress || "?";
}

function isLoopback(address: string): boolean {
  return (
    address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
  );
}

/** Log em stderr, uma linha por request. Nunca imprime o token. */
function log(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal} recebido, encerrando`);
    server.close(() => {
      void handler.close().then(() => process.exit(0));
    });
  });
}

server.listen(port, host, () => {
  log(`meta-business-insights ouvindo em http://${host}:${port}${mcpPath}`);
});
