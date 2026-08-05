/**
 * Autenticação do entrypoint HTTP: bearer tokens estáticos.
 *
 * Não há OAuth aqui de propósito. O servidor é interno e o Claude só oferece
 * duas formas de mandar um token fixo (conector com static_headers ou a ponte
 * local stdio→HTTP), ambas por header `Authorization: Bearer`.
 *
 * Os tokens são nomeados — `ana:abc123,bruno:def456` — para que o log diga
 * *quem* consultou e para que a saída de alguém da equipe seja resolvida
 * removendo uma linha, sem trocar o segredo de todo mundo.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";

/** Validade devolvida no AuthInfo; recalculada a cada request. */
const TOKEN_TTL_SECONDS = 3600;

export interface StaticToken {
  /** Rótulo humano ("ana"), usado só em log. Nunca é o segredo. */
  name: string;
  /** SHA-256 do token, para comparar sem manter o segredo em memória crua. */
  digest: Buffer;
}

/**
 * Lê `MCP_HTTP_TOKENS` no formato `nome:token,nome:token`.
 *
 * O nome é opcional (`token` sozinho vira `token-1`), mas recomendado: sem ele
 * o log não distingue as pessoas. O split é no *primeiro* `:`, então gere
 * tokens sem dois-pontos — `openssl rand -hex 32` serve.
 */
export function parseTokens(raw: string | undefined): StaticToken[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return entries.map((entry, i) => {
    const sep = entry.indexOf(":");
    const name = sep > 0 ? entry.slice(0, sep).trim() : `token-${i + 1}`;
    const secret = sep > 0 ? entry.slice(sep + 1).trim() : entry;
    if (!secret) {
      throw new Error(
        `MCP_HTTP_TOKENS: a entrada "${name}" não tem token depois do ":".`,
      );
    }
    return { name, digest: sha256(secret) };
  });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Verificador no formato que o SDK espera. Compara digests de tamanho fixo com
 * timingSafeEqual: comparar as strings direto vazaria o prefixo do token pelo
 * tempo de resposta, e comparar comprimentos vazaria o tamanho.
 */
export function createStaticTokenVerifier(tokens: StaticToken[]) {
  if (tokens.length === 0) {
    throw new Error(
      "Nenhum token configurado. Defina MCP_HTTP_TOKENS antes de expor o " +
        "servidor — sem isso qualquer pessoa com a URL lê os dados do portfólio.",
    );
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const digest = sha256(token);
      const match = tokens.find((t) => timingSafeEqual(t.digest, digest));

      if (!match) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token inválido.");
      }

      return {
        token,
        clientId: match.name,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      };
    },
  };
}
