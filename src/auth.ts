/**
 * Quem pode usar o servidor HTTP, nas duas formas que ele aceita.
 *
 * A principal é a **allowlist de e-mails** (`MCP_ALLOWED_EMAILS`), usada pelo
 * login Google em `oauth.ts`. Não há segredo para distribuir: a pessoa entra
 * com a conta do Workspace que já tem, e desligá-la é apagar uma linha.
 *
 * A secundária são os **bearers estáticos** (`MCP_HTTP_TOKENS`), que sobrevivem
 * como saída de emergência — o `curl` de diagnóstico do README e a ponte local
 * stdio→HTTP. Ficaram opcionais quando o Google entrou.
 *
 * As duas listas são nomeadas e carregam scopes pelo mesmo sufixo `:write`,
 * para que o log diga *quem* consultou em qualquer um dos caminhos.
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
  /** Vazio = só leitura. `["write"]` libera as tools que publicam. */
  scopes: string[];
}

/**
 * Lê `MCP_HTTP_TOKENS` no formato `nome:token[:write]`, separados por vírgula.
 *
 * O nome é opcional (`token` sozinho vira `token-1`), mas recomendado: sem ele
 * o log não distingue as pessoas. Gere tokens sem dois-pontos —
 * `openssl rand -hex 32` serve.
 *
 * O sufixo `:write` é o que separa quem consulta dados de quem publica em nome
 * das marcas. Sem ele, as tools de escrita nem aparecem para aquele bearer.
 */
export function parseTokens(raw: string | undefined): StaticToken[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return entries.map((entry, i) => {
    const parts = entry.split(":").map((p) => p.trim());

    let name: string;
    let secret: string;
    let suffix: string | undefined;

    if (parts.length === 1) {
      name = `token-${i + 1}`;
      secret = parts[0]!;
    } else {
      name = parts[0]!;
      secret = parts[1]!;
      suffix = parts[2];
    }

    if (!secret) {
      throw new Error(
        `MCP_HTTP_TOKENS: a entrada "${name}" não tem token depois do ":".`,
      );
    }
    if (parts.length > 3 || (suffix !== undefined && suffix !== "write")) {
      throw new Error(
        `MCP_HTTP_TOKENS: entrada "${name}" malformada. ` +
          `O formato é nome:token ou nome:token:write.`,
      );
    }

    return { name, digest: sha256(secret), scopes: suffix ? [suffix] : [] };
  });
}

/** Exportado porque `oauth.ts` usa o mesmo digest para guardar sessões sem
 * manter nenhum token utilizável em disco. */
export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export interface AllowedUser {
  /** E-mail em minúsculas, como vem normalizado do `id_token`. */
  email: string;
  /** Vazio = só leitura. `["write"]` libera as tools que publicam. */
  scopes: string[];
}

/**
 * Lê `MCP_ALLOWED_EMAILS` no formato `ana@empresa.com[:write]`, separados por
 * vírgula.
 *
 * É a lista de quem pode entrar pelo Google. Estar no domínio do Workspace não
 * basta de propósito: o `hd` diz que a pessoa é da empresa, e esta lista diz
 * que ela é do time que olha o portfólio.
 */
export function parseAllowedEmails(raw: string | undefined): AllowedUser[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const users: AllowedUser[] = [];

  for (const entry of entries) {
    const parts = entry.split(":").map((p) => p.trim());
    const email = parts[0]!.toLowerCase();
    const suffix = parts[1];

    if (!email.includes("@")) {
      throw new Error(
        `MCP_ALLOWED_EMAILS: "${entry}" não parece um e-mail. ` +
          "O formato é ana@empresa.com ou ana@empresa.com:write.",
      );
    }
    if (parts.length > 2 || (suffix !== undefined && suffix !== "write")) {
      throw new Error(
        `MCP_ALLOWED_EMAILS: entrada "${entry}" malformada. ` +
          "O formato é e-mail ou e-mail:write.",
      );
    }
    // Duplicata seria ambígua na hora de resolver os scopes, e o erro passaria
    // despercebido — alguém ficaria sem `write` sem entender por quê.
    if (users.some((u) => u.email === email)) {
      throw new Error(`MCP_ALLOWED_EMAILS: "${email}" aparece mais de uma vez.`);
    }

    users.push({ email, scopes: suffix ? [suffix] : [] });
  }

  return users;
}

/**
 * Verificador no formato que o SDK espera. Compara digests de tamanho fixo com
 * timingSafeEqual: comparar as strings direto vazaria o prefixo do token pelo
 * tempo de resposta, e comparar comprimentos vazaria o tamanho.
 *
 * Lista vazia é aceita — significa "sem saída de emergência", e quem garante
 * que o servidor não ficou aberto é a checagem em `http.ts`, que exige pelo
 * menos um dos dois caminhos de autenticação configurado.
 */
export function createStaticTokenVerifier(tokens: StaticToken[]) {
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
        scopes: match.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      };
    },
  };
}
