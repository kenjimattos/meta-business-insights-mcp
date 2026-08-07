/**
 * Login pelo Google, usado só para provar quem é a pessoa.
 *
 * Não guardamos token do Google nem chamamos API deles depois do login: o que
 * interessa é o e-mail, uma vez, no momento de autorizar. Isso é o que evita
 * arrastar renovação de token, expiração e escopo de API para dentro deste
 * servidor — o acesso ao Meta continua sendo o `META_ACCESS_TOKEN` único da
 * VPS, e o Google só responde "é a ana mesmo".
 */

/** Endpoints sobrescrevíveis para o teste apontar para um stub local. */
const AUTH_ENDPOINT =
  process.env.GOOGLE_AUTH_ENDPOINT?.trim() ||
  "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT =
  process.env.GOOGLE_TOKEN_ENDPOINT?.trim() || "https://oauth2.googleapis.com/token";

/** Emissores que o Google usa nos dois formatos, ambos legítimos. */
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Domínio do Workspace exigido na claim `hd`. Vazio = qualquer conta. */
  hostedDomain?: string;
  /** Fixo, e registrado no Google Cloud Console. */
  redirectUri: string;
}

export function loadGoogleConfig(issuer: string): GoogleConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;

  // Falha ao subir: um dos dois sozinho significa configuração pela metade, e
  // o sintoma apareceria só no primeiro login de alguém.
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET precisam estar os dois " +
        "definidos, ou nenhum dos dois.",
    );
  }

  return {
    clientId,
    clientSecret,
    hostedDomain: process.env.GOOGLE_HD?.trim() || undefined,
    redirectUri: `${issuer}/oauth/google/callback`,
  };
}

/**
 * URL para onde mandamos a pessoa. O `hd` aqui só filtra o seletor de contas —
 * é conveniência, não controle de acesso. Quem decide é a validação da claim
 * `hd` em `verifyIdToken`, do lado do servidor.
 */
export function googleAuthorizationUrl(config: GoogleConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  // Sem refresh token: a sessão do Claude é nossa, e o Google não é
  // consultado de novo depois do login.
  url.searchParams.set("access_type", "online");
  if (config.hostedDomain) url.searchParams.set("hd", config.hostedDomain);
  return url.toString();
}

export interface GoogleIdentity {
  email: string;
  hostedDomain?: string;
}

/** Erro de login, com mensagem já apresentável para a pessoa. */
export class GoogleLoginError extends Error {}

/**
 * Troca o código pelo `id_token` e devolve a identidade validada.
 *
 * A assinatura do JWT não é verificada de propósito: o token vem direto do
 * endpoint do Google, por TLS, numa requisição nossa — o caso que o OIDC Core
 * §3.1.3.7 dispensa explicitamente. Verificar exigiria buscar e cachear o
 * JWKS, e a dependência não compraria segurança nenhuma aqui. As *claims*
 * continuam todas conferidas abaixo.
 */
export async function exchangeGoogleCode(
  config: GoogleConfig,
  code: string,
): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new GoogleLoginError(
      `O Google recusou a troca do código (HTTP ${res.status}).`,
    );
  }

  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) {
    throw new GoogleLoginError("O Google não devolveu id_token.");
  }

  return verifyIdToken(config, body.id_token);
}

interface IdTokenClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  hd?: string;
}

function verifyIdToken(config: GoogleConfig, idToken: string): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleLoginError("id_token malformado.");

  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new GoogleLoginError("id_token ilegível.");
  }

  if (!claims.iss || !ISSUERS.has(claims.iss)) {
    throw new GoogleLoginError(`Emissor inesperado: ${claims.iss}`);
  }
  if (claims.aud !== config.clientId) {
    throw new GoogleLoginError("id_token emitido para outro aplicativo.");
  }
  if (!claims.exp || claims.exp * 1000 <= Date.now()) {
    throw new GoogleLoginError("id_token expirado.");
  }
  if (!claims.email) {
    throw new GoogleLoginError("id_token sem e-mail — falta o escopo `email`.");
  }
  // Sem isto, uma conta com e-mail não confirmado poderia reivindicar o
  // endereço de outra pessoa da allowlist.
  if (claims.email_verified !== true) {
    throw new GoogleLoginError("E-mail não verificado no Google.");
  }
  // A checagem que o parâmetro `hd` da URL *não* faz.
  if (config.hostedDomain && claims.hd !== config.hostedDomain) {
    throw new GoogleLoginError(
      `Esta conta não pertence ao domínio ${config.hostedDomain}.`,
    );
  }

  return { email: claims.email.toLowerCase(), hostedDomain: claims.hd };
}
