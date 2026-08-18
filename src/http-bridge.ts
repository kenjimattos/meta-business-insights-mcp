/**
 * Ponte entre o `http` do Node e o handler web-standard do SDK.
 *
 * Usada por `http.ts`. O SDK expõe `handler.fetch(Request) => Response`; o Node fala
 * `(IncomingMessage, ServerResponse)`. O pacote oficial
 * `@modelcontextprotocol/node` faz essa conversão, mas arrasta o Hono junto —
 * caro demais para as ~40 linhas abaixo.
 *
 * O corpo da *requisição* é bufferizado (mensagens JSON-RPC são pequenas), o
 * que evita a complicação de `duplex: "half"`. O corpo da *resposta* é
 * transmitido em streaming respeitando backpressure, porque respostas SSE são
 * longas e o Meta é lento: escrever sem checar o retorno de `res.write` faria
 * a memória crescer sem limite quando o cliente lê devagar.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";

/** Métodos sem corpo, segundo o fetch spec — passar body neles lança TypeError. */
const BODYLESS = new Set(["GET", "HEAD"]);

/**
 * Teto do corpo da requisição, aplicado *durante* a leitura.
 *
 * `/register` e `/token` são públicos (a autenticação vem depois), então sem
 * este limite um POST anônimo de vários GB seria bufferizado inteiro na memória
 * antes de qualquer validação — esgotando o processo. 1 MB é folga larga: as
 * mensagens JSON-RPC do `/mcp` têm alguns KB e o `/register` tem o próprio teto
 * de 16 KB depois desta camada.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Corpo acima do teto; `http.ts` traduz para 413. */
export class PayloadTooLargeError extends Error {
  constructor() {
    super("Corpo da requisição excede o limite.");
    this.name = "PayloadTooLargeError";
  }
}

export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // Headers repetidos chegam como array (ex.: set-cookie).
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(key, item);
    }
  }

  const body = BODYLESS.has(method) ? undefined : await readBody(req);

  return new Request(url, { method, headers, body });
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    // Aborta assim que estoura, sem acumular o resto — o objetivo é não deixar
    // a memória crescer com um corpo hostil.
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

export async function writeNodeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // false = buffer interno cheio; esperar o dreno é o que aplica o
      // backpressure de volta no produtor.
      if (!res.write(value)) await once(res, "drain");
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
