/**
 * Respostas cruas da Graph API trazem o token na query string de `paging.next`
 * e `paging.previous` — a Meta monta as URLs de paginação já autenticadas. Em
 * `graph_api_get` isso despejava o System User token inteiro dentro da
 * conversa, onde ele vira histórico e sai do nosso controle. Com o token tendo
 * `ads_management`, quem lê o vazamento consegue escrever nas contas.
 *
 * Nada sai do servidor sem passar por aqui: `text()` e `fail()` são o único
 * caminho de saída das tools.
 */

/**
 * Token em query string. Cobre `paging.next`, `paging.previous` e qualquer URL
 * que a Graph API devolva pronta (imagens, vídeos, batch).
 */
const TOKEN_IN_QUERY =
  /([?&](?:access_token|client_secret|input_token|code)=)[^&\s"'`\\]+/gi;

/**
 * Token solto no corpo, sem estar numa URL. Os prefixos são os que a Meta usa:
 * `EAA` para tokens de app/usuário/página, `EAAB` para os antigos.
 */
const BARE_TOKEN = /\bEAA[A-Za-z0-9]{20,}\b/g;

/** Chaves cujo valor é sempre segredo, independente do formato. */
const SECRET_KEYS = new Set([
  "access_token",
  "client_secret",
  "input_token",
  "page_access_token",
]);

const MASK = "[REDACTED]";

export function redactText(value: string): string {
  return value.replace(TOKEN_IN_QUERY, `$1${MASK}`).replace(BARE_TOKEN, MASK);
}

/**
 * Percorre a estrutura trocando segredos. Devolve o mesmo valor quando não há
 * nada a trocar, para não copiar payload grande à toa.
 */
export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = walk(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) {
        out[key] = MASK;
        changed = true;
        continue;
      }
      const next = walk(item);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }

  return value;
}
