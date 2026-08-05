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
  verifyBearerToken,
} from "@modelcontextprotocol/server";

import { createServer } from "./server.js";
import { createStaticTokenVerifier, parseTokens } from "./auth.js";
import { toWebRequest, writeNodeResponse } from "./http-bridge.js";

const port = Number(process.env.MCP_HTTP_PORT ?? 8787);
const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
const mcpPath = process.env.MCP_HTTP_PATH?.trim() || "/mcp";

// Falha ao subir, e não na primeira requisição: um servidor sem token exposto
// por engano entrega o portfólio inteiro para quem descobrir a URL.
const verifier = createStaticTokenVerifier(parseTokens(process.env.MCP_HTTP_TOKENS));

const handler = createMcpHandler(createServer, {
  onerror: (err) => log(`erro do handler: ${err.message}`),
});

const server = createNodeServer((req, res) => {
  handle(req, res).catch((err) => {
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

  if (url.pathname !== mcpPath) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
    return;
  }

  let authInfo;
  try {
    authInfo = await verifyBearerToken(req.headers.authorization, { verifier });
  } catch (err) {
    log(`401 ${req.method} ${url.pathname} de ${clientIp(req)}`);
    await writeNodeResponse(res, bearerAuthChallengeResponse(err));
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

function clientIp(req: IncomingMessage): string {
  // Atrás do proxy o socket é sempre 127.0.0.1; o IP real vem no header.
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
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
