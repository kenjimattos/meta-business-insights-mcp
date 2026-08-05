/**
 * Descoberta do portfólio: Business Manager -> Páginas -> contas do Instagram,
 * junto com o Page Access Token de cada Página.
 *
 * Page Insights e Instagram Insights recusam o token do usuário/system user:
 * exigem o token da Página dona do ativo. Resolver isso uma vez e cachear é o
 * que permite consultar dezenas de contas sem estourar rate limit.
 */

import type { GraphClient } from "./client.js";
import { GraphError } from "./client.js";

export interface InstagramAsset {
  id: string;
  username?: string;
  name?: string;
  followersCount?: number;
  mediaCount?: number;
}

export interface PageAsset {
  id: string;
  name: string;
  category?: string;
  followersCount?: number;
  /** Token da Página; cai para o token padrão se o Meta não devolver um. */
  accessToken?: string;
  instagram?: InstagramAsset;
  /** De onde o ativo veio: owned_pages, client_pages ou me/accounts. */
  source: string;
}

export interface Portfolio {
  businessId?: string;
  businessName?: string;
  pages: PageAsset[];
  /** Problemas não-fatais encontrados na descoberta (ex.: página sem token). */
  warnings: string[];
  discoveredAt: string;
}

interface RawPage {
  id: string;
  name?: string;
  category?: string;
  followers_count?: number;
  access_token?: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    followers_count?: number;
    media_count?: number;
  };
}

const PAGE_FIELDS =
  "id,name,category,followers_count,access_token," +
  "instagram_business_account{id,username,name,followers_count,media_count}";

const CACHE_TTL_MS = 10 * 60 * 1000;

export class PortfolioService {
  private cache: { portfolio: Portfolio; at: number } | undefined;

  constructor(
    private readonly client: GraphClient,
    private readonly businessId: string | undefined,
    private readonly pageIdFilter: string[] | undefined,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async get(forceRefresh = false): Promise<Portfolio> {
    if (
      !forceRefresh &&
      this.cache &&
      Date.now() - this.cache.at < CACHE_TTL_MS
    ) {
      return this.cache.portfolio;
    }
    const portfolio = await this.discover();
    this.cache = { portfolio, at: Date.now() };
    return portfolio;
  }

  private async discover(): Promise<Portfolio> {
    const warnings: string[] = [];
    const byId = new Map<string, PageAsset>();

    const businessId = this.businessId ?? (await this.detectBusinessId(warnings));
    let businessName: string | undefined;

    if (businessId) {
      try {
        const biz = await this.client.get<{ id: string; name?: string }>(
          `/${businessId}`,
          { fields: "id,name" },
        );
        businessName = biz.name;
      } catch (err) {
        warnings.push(
          `Não foi possível ler o Business ${businessId}: ${describe(err)}`,
        );
      }

      for (const edge of ["owned_pages", "client_pages"]) {
        try {
          const pages = await this.client.getAll<RawPage>(
            `/${businessId}/${edge}`,
            { fields: PAGE_FIELDS },
          );
          for (const raw of pages) {
            const asset = toAsset(raw, edge);
            if (!byId.has(asset.id)) byId.set(asset.id, asset);
          }
        } catch (err) {
          warnings.push(`Falha ao listar ${edge}: ${describe(err)}`);
        }
      }
    }

    // /me/accounts complementa (e cobre o caso sem Business Manager).
    try {
      const pages = await this.client.getAll<RawPage>("/me/accounts", {
        fields: PAGE_FIELDS,
      });
      for (const raw of pages) {
        const asset = toAsset(raw, "me/accounts");
        const existing = byId.get(asset.id);
        if (!existing) {
          byId.set(asset.id, asset);
        } else if (!existing.accessToken && asset.accessToken) {
          // /me/accounts costuma trazer o Page token que a edge do Business omite.
          existing.accessToken = asset.accessToken;
        }
      }
    } catch (err) {
      if (byId.size === 0) throw err;
      warnings.push(`Falha ao listar /me/accounts: ${describe(err)}`);
    }

    let pages = [...byId.values()];

    if (this.pageIdFilter) {
      const allow = new Set(this.pageIdFilter);
      pages = pages.filter((p) => allow.has(p.id));
    }

    await this.fillMissingPageTokens(pages, warnings);
    await this.fillMissingInstagram(pages, warnings);

    pages.sort((a, b) => (b.followersCount ?? 0) - (a.followersCount ?? 0));

    if (pages.length === 0) {
      warnings.push(
        "Nenhuma Página encontrada. Verifique se o token tem pages_show_list " +
          "e se o System User tem acesso aos ativos do portfólio.",
      );
    }

    return {
      businessId,
      businessName,
      pages,
      warnings,
      discoveredAt: new Date().toISOString(),
    };
  }

  private async detectBusinessId(
    warnings: string[],
  ): Promise<string | undefined> {
    try {
      const businesses = await this.client.getAll<{ id: string; name?: string }>(
        "/me/businesses",
        { fields: "id,name" },
      );
      if (businesses.length === 1) return businesses[0]!.id;
      if (businesses.length > 1) {
        warnings.push(
          `O token enxerga ${businesses.length} portfólios (${businesses
            .map((b) => `${b.name ?? "?"}:${b.id}`)
            .join(", ")}). Defina META_BUSINESS_ID para fixar um.`,
        );
      }
    } catch {
      // Token sem business_management: seguimos por /me/accounts.
    }
    return undefined;
  }

  /** Páginas sem token no payload: busca o token individualmente. */
  private async fillMissingPageTokens(
    pages: PageAsset[],
    warnings: string[],
  ): Promise<void> {
    const missing = pages.filter((p) => !p.accessToken);
    if (missing.length === 0) return;

    const results = await this.client.batchGet<{ access_token?: string }>(
      missing.map((p) => ({ path: `/${p.id}`, params: { fields: "access_token" } })),
    );

    results.forEach((result, i) => {
      const page = missing[i]!;
      if (result.ok && result.data.access_token) {
        page.accessToken = result.data.access_token;
      } else {
        warnings.push(
          `Sem Page Access Token para "${page.name}" (${page.id}) — ` +
            `insights dessa página podem falhar.`,
        );
      }
    });
  }

  /** Algumas edges não expandem instagram_business_account; buscamos direto. */
  private async fillMissingInstagram(
    pages: PageAsset[],
    warnings: string[],
  ): Promise<void> {
    const missing = pages.filter((p) => !p.instagram && p.accessToken);
    if (missing.length === 0) return;

    const results = await this.client.batchGet<RawPage>(
      missing.map((p) => ({
        path: `/${p.id}`,
        params: {
          fields:
            "instagram_business_account{id,username,name,followers_count,media_count}",
        },
        token: p.accessToken,
      })),
    );

    results.forEach((result, i) => {
      const page = missing[i]!;
      if (result.ok && result.data.instagram_business_account) {
        page.instagram = toIg(result.data.instagram_business_account);
      } else if (!result.ok && result.error.code !== 100) {
        warnings.push(
          `Falha ao checar Instagram de "${page.name}": ${result.error.message}`,
        );
      }
    });
  }

  /** Resolve os ativos alvo a partir de IDs de Página, IG, nome ou "todos". */
  async resolveTargets(selector?: string[]): Promise<PageAsset[]> {
    const { pages } = await this.get();
    if (!selector || selector.length === 0) return pages;

    const wanted = new Set(selector.map((s) => s.trim().toLowerCase()));
    const matched = pages.filter(
      (p) =>
        wanted.has(p.id.toLowerCase()) ||
        wanted.has(p.name.toLowerCase()) ||
        (p.instagram &&
          (wanted.has(p.instagram.id.toLowerCase()) ||
            (p.instagram.username &&
              wanted.has(p.instagram.username.toLowerCase())))),
    );

    if (matched.length === 0) {
      throw new Error(
        `Nenhum ativo do portfólio corresponde a: ${selector.join(", ")}. ` +
          `Use a tool list_portfolio para ver os IDs disponíveis.`,
      );
    }
    return matched;
  }
}

function toAsset(raw: RawPage, source: string): PageAsset {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    category: raw.category,
    followersCount: raw.followers_count,
    accessToken: raw.access_token,
    instagram: raw.instagram_business_account
      ? toIg(raw.instagram_business_account)
      : undefined,
    source,
  };
}

function toIg(raw: NonNullable<RawPage["instagram_business_account"]>): InstagramAsset {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    followersCount: raw.followers_count,
    mediaCount: raw.media_count,
  };
}

function describe(err: unknown): string {
  if (err instanceof GraphError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
