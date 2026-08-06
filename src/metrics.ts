/**
 * Catálogo curado de métricas orgânicas.
 *
 * A Graph API vem passando por uma limpeza pesada de métricas de Page Insights
 * (page_fans e a família `impressions` foram desligadas em 15/11/2025; outra
 * leva cai em 15/06/2026). Manter o mapa aqui evita que o modelo peça métricas
 * mortas e receba erro #100 sem contexto.
 */

export interface MetricInfo {
  name: string;
  description: string;
  periods: string[];
  /** Nome antigo que esta métrica substitui. */
  replaces?: string;
  notes?: string;
}

export const PAGE_METRICS: MetricInfo[] = [
  {
    name: "page_follows",
    description: "Total acumulado de seguidores da Página (snapshot diário).",
    periods: ["day"],
    replaces: "page_fans",
  },
  {
    name: "page_daily_follows_unique",
    description: "Novos seguidores únicos no período (orgânico + pago).",
    periods: ["day", "week", "days_28"],
    replaces: "page_fan_adds_unique",
  },
  {
    name: "page_daily_unfollows_unique",
    description: "Contas que deixaram de seguir a Página no período.",
    periods: ["day", "week", "days_28"],
    replaces: "page_fan_removes_unique",
  },
  {
    name: "page_views_total",
    description: "Visualizações do perfil da Página.",
    periods: ["day", "week", "days_28"],
  },
  {
    name: "page_post_engagements",
    description: "Interações totais com publicações da Página.",
    periods: ["day", "week", "days_28"],
  },
  {
    name: "page_impressions",
    description:
      "Impressões da Página. DESCONTINUADA — use page_media_view (breakdown is_from_ads separa pago de orgânico).",
    periods: ["day", "week", "days_28"],
    notes: "deprecated",
  },
  {
    name: "page_video_views",
    description: "Views de vídeo de 3+ segundos.",
    periods: ["day", "week", "days_28"],
  },
];

/** Métricas desligadas e o que usar no lugar. */
export const PAGE_DEPRECATIONS: Record<string, string> = {
  page_fans: "page_follows",
  page_fans_city: "page_follows_city",
  page_fans_country: "page_follows_country",
  page_fan_adds: "page_daily_follows_unique",
  page_fan_adds_unique: "page_daily_follows_unique",
  page_fan_removes: "page_daily_unfollows_unique",
  page_fan_removes_unique: "page_daily_unfollows_unique",
  page_impressions: "page_media_view",
  page_impressions_unique: "page_media_view",
  page_impressions_paid: "page_media_view (breakdown is_from_ads)",
  page_impressions_organic: "page_media_view (breakdown is_from_ads)",
  post_impressions: "post_media_view",
  post_impressions_paid: "post_media_view (breakdown is_from_ads)",
  post_impressions_fan: "post_media_view (breakdown is_from_followers)",
  post_impressions_organic: "post_media_view (breakdown is_from_ads)",
};

export const IG_METRICS: MetricInfo[] = [
  {
    name: "follows_and_unfollows",
    description:
      "Seguidores ganhos e perdidos no período. Exige metric_type=total_value; use breakdown=follow_type para separar FOLLOWS de UNFOLLOWS.",
    periods: ["day"],
  },
  {
    name: "follower_count",
    description:
      "Novos seguidores por dia. Janela limitada aos últimos 30 dias e indisponível para contas com menos de 100 seguidores.",
    periods: ["day"],
  },
  {
    name: "reach",
    description: "Contas únicas alcançadas. Única métrica de conteúdo com série diária real.",
    periods: ["day"],
  },
  {
    name: "views",
    description: "Visualizações de conteúdo (substituiu impressions). Só total_value.",
    periods: ["day"],
    replaces: "impressions",
  },
  {
    name: "profile_views",
    description: "Visitas ao perfil. Só total_value.",
    periods: ["day"],
  },
  {
    name: "accounts_engaged",
    description: "Contas únicas que interagiram com o perfil. Só total_value.",
    periods: ["day"],
  },
  {
    name: "total_interactions",
    description:
      "Curtidas + comentários + salvamentos + compartilhamentos. Só total_value.",
    periods: ["day"],
  },
  {
    name: "likes",
    description: "Curtidas recebidas. Só total_value.",
    periods: ["day"],
  },
  {
    name: "comments",
    description: "Comentários recebidos. Só total_value.",
    periods: ["day"],
  },
  {
    name: "shares",
    description: "Compartilhamentos. Só total_value.",
    periods: ["day"],
  },
  {
    name: "saves",
    description: "Salvamentos. Só total_value.",
    periods: ["day"],
  },
  {
    name: "replies",
    description: "Respostas a stories. Só total_value.",
    periods: ["day"],
  },
  {
    name: "reposts",
    description: "Republicações do conteúdo. Só total_value.",
    periods: ["day"],
  },
  {
    name: "profile_links_taps",
    description:
      "Cliques nos links do perfil. Só total_value; breakdown contact_button_type separa por tipo.",
    periods: ["day"],
  },
  {
    name: "website_clicks",
    description: "Cliques no link do site no perfil. Só total_value.",
    periods: ["day"],
  },
  {
    name: "content_views",
    description: "Visualizações de conteúdo. Só total_value.",
    periods: ["day"],
  },
  {
    name: "quotes",
    description: "Citações do conteúdo. Só total_value.",
    periods: ["day"],
  },
  {
    name: "online_followers",
    description:
      "Distribuição horária dos seguidores online. Indisponível abaixo de 100 seguidores.",
    periods: ["lifetime"],
  },
  {
    name: "follower_demographics",
    description:
      "Demografia dos seguidores. Exige metric_type=total_value, timeframe e breakdown (age, city, country, gender).",
    periods: ["lifetime"],
  },
  {
    name: "engaged_audience_demographics",
    description: "Demografia do público engajado. Mesmos requisitos de follower_demographics.",
    periods: ["lifetime"],
  },
  {
    name: "reached_audience_demographics",
    description: "Demografia do público alcançado. Mesmos requisitos de follower_demographics.",
    periods: ["lifetime"],
  },
  // Contas do Threads vinculadas ao perfil do Instagram.
  {
    name: "threads_views",
    description: "Visualizações no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_likes",
    description: "Curtidas no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_replies",
    description: "Respostas no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_reposts",
    description: "Republicações no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_clicks",
    description: "Cliques no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_followers",
    description: "Seguidores no Threads. Só total_value.",
    periods: ["day"],
  },
  {
    name: "threads_follower_demographics",
    description: "Demografia dos seguidores no Threads. Exige timeframe e breakdown.",
    periods: ["lifetime"],
  },
];

export const IG_DEPRECATIONS: Record<string, string> = {
  impressions: "views",
  plays: "views",
  video_views: "views",
};

/**
 * Métricas do Instagram que aceitam metric_type=time_series.
 *
 * A lista é curta de propósito: na v26, verificado contra a API, apenas estas
 * duas retornam série diária. Todas as demais (views, profile_views, likes,
 * accounts_engaged, total_interactions, shares, saves…) só existem como
 * total_value e devolvem um único número por janela — por isso o servidor faz
 * uma chamada por período do relatório em vez de fatiar o intervalo inteiro.
 */
export const IG_TIME_SERIES_METRICS = new Set(["reach", "follower_count"]);

/* ------------------------- métricas por publicação ------------------------ */

/**
 * Insights de publicação do Instagram, separados por `media_product_type`.
 *
 * A separação é obrigatória, não organizacional: pedir uma métrica que o tipo
 * não aceita derruba o request inteiro com `(#100) The Media Insights API does
 * not support the metric`. Verificado na v26 — um reel aceita watch time mas
 * não profile_visits, e um post de feed é exatamente o oposto.
 */
const IG_MEDIA_COMMON = [
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "views",
];

export const IG_MEDIA_METRICS_BY_TYPE: Record<string, string[]> = {
  REELS: [...IG_MEDIA_COMMON, "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"],
  FEED: [...IG_MEDIA_COMMON, "profile_visits", "follows", "profile_activity"],
};

/**
 * Tipos não mapeados (STORY, AD…) recebem só o conjunto comum. É a escolha
 * conservadora: métricas específicas de story não foram verificadas contra a
 * API, e chutar uma quebraria a consulta inteira daquele tipo.
 */
export function igMediaMetricsFor(productType: string | undefined): string[] {
  return IG_MEDIA_METRICS_BY_TYPE[productType ?? ""] ?? IG_MEDIA_COMMON;
}

/**
 * Insights de post do Facebook. Diferente do Instagram, aqui um único conjunto
 * serve para todos os tipos: métricas de vídeo pedidas num post de foto voltam
 * vazias em vez de dar erro (verificado na v26).
 *
 * `post_impressions`, `post_impressions_unique` e `post_engaged_users` foram
 * desligadas — respondem `(#100) The value must be a valid insights metric`.
 */
export const FB_POST_METRICS = [
  "post_media_view",
  "post_reactions_by_type_total",
  "post_clicks",
  "post_activity_by_action_type",
  "post_video_views",
  "post_video_avg_time_watched",
  "post_video_view_time",
];

/** Métricas cujo valor vem em milissegundos e precisa virar segundos ao exibir. */
export const MS_METRICS = new Set([
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "post_video_avg_time_watched",
  "post_video_view_time",
]);

/** Métricas do Instagram que exigem o parâmetro `timeframe`. */
export const IG_REQUIRES_TIMEFRAME = new Set([
  "follower_demographics",
  "engaged_audience_demographics",
  "reached_audience_demographics",
  "threads_follower_demographics",
]);

export function checkDeprecated(
  metric: string,
  surface: "page" | "instagram",
): string | undefined {
  const map = surface === "page" ? PAGE_DEPRECATIONS : IG_DEPRECATIONS;
  const replacement = map[metric];
  return replacement
    ? `"${metric}" foi descontinuada pelo Meta; use "${replacement}".`
    : undefined;
}
