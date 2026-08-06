/**
 * Leitura de comentários das publicações, para diagnóstico de reclamações.
 *
 * Depende de permissões que os insights não exigem: `pages_read_user_content`
 * no Facebook e `instagram_manage_comments` no Instagram. Conteúdo publicado
 * pela própria marca é uma coisa; conteúdo escrito por terceiros é outra, e o
 * Meta separa as duas em permissões distintas.
 *
 * Sobre identidade: o Facebook devolve o autor sem nome na maioria dos casos —
 * só perfis que consentiram ou Páginas aparecem identificados. O Instagram
 * devolve o `username`. Por isso o campo `author` é opcional aqui.
 */

import type { GraphClient } from "./graph/client.js";
import type { PageAsset } from "./graph/assets.js";
import { addDays, unix } from "./dates.js";
import type { Surface } from "./content.js";

export interface CommentRow {
  surface: Surface;
  assetName: string;
  postId: string;
  /** Trecho da publicação comentada, para dar contexto ao comentário. */
  postCaption: string;
  postPermalink?: string;
  commentId: string;
  date: string;
  author?: string;
  text: string;
  likeCount?: number;
  /** Respostas ao comentário, quando a rede informa. */
  replyCount?: number;
}

export interface CommentIssue {
  asset: string;
  detail: string;
}

/** Teto de publicações inspecionadas por ativo, para não estourar rate limit. */
const MAX_POSTS = 50;
const COMMENTS_PER_POST = 25;

export async function fetchComments(
  client: GraphClient,
  pages: PageAsset[],
  range: { since: string; until: string },
  surfaces: Surface[],
): Promise<{ rows: CommentRow[]; issues: CommentIssue[] }> {
  const rows: CommentRow[] = [];
  const issues: CommentIssue[] = [];

  for (const page of pages) {
    if (surfaces.includes("facebook")) {
      await collect(
        client,
        page.accessToken,
        page.name,
        "facebook",
        `/${page.id}/feed`,
        "id,created_time,message,story,permalink_url",
        (p) => p.created_time,
        (p) => p.message ?? p.story ?? "",
        (p) => p.permalink_url,
        "id,message,created_time,from,like_count,comment_count",
        range,
        rows,
        issues,
      );
    }

    const ig = page.instagram;
    if (surfaces.includes("instagram") && ig) {
      const label = ig.username ? `@${ig.username}` : (ig.name ?? ig.id);
      await collect(
        client,
        page.accessToken,
        label,
        "instagram",
        `/${ig.id}/media`,
        "id,timestamp,caption,permalink",
        (m) => m.timestamp,
        (m) => m.caption ?? "",
        (m) => m.permalink,
        "id,text,timestamp,username,like_count",
        range,
        rows,
        issues,
      );
    }
  }

  // Mais recentes primeiro: reclamação nova importa mais que reclamação velha.
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return { rows, issues };
}

interface RawItem {
  id: string;
  created_time?: string;
  timestamp?: string;
  message?: string;
  story?: string;
  caption?: string;
  permalink?: string;
  permalink_url?: string;
}

interface RawComment {
  id: string;
  message?: string;
  text?: string;
  created_time?: string;
  timestamp?: string;
  from?: { name?: string };
  username?: string;
  like_count?: number;
  comment_count?: number;
}

async function collect(
  client: GraphClient,
  token: string | undefined,
  assetName: string,
  surface: Surface,
  edge: string,
  fields: string,
  dateOf: (item: RawItem) => string | undefined,
  captionOf: (item: RawItem) => string,
  linkOf: (item: RawItem) => string | undefined,
  commentFields: string,
  range: { since: string; until: string },
  rows: CommentRow[],
  issues: CommentIssue[],
): Promise<void> {
  let posts: RawItem[];
  try {
    const response = await client.get<{ data?: RawItem[] }>(
      edge,
      {
        fields,
        limit: String(MAX_POSTS),
        since: String(unix(range.since)),
        until: String(unix(addDays(range.until, 1)) - 1),
      },
      { token },
    );
    posts = (response.data ?? []).filter((p) => {
      const d = (dateOf(p) ?? "").slice(0, 10);
      return d >= range.since && d <= range.until;
    });
  } catch (err) {
    issues.push({ asset: assetName, detail: describe(err) });
    return;
  }

  if (posts.length === 0) return;

  const results = await client.batchGet<{ data?: RawComment[] }>(
    posts.map((post) => ({
      path: `/${post.id}/comments`,
      params: { fields: commentFields, limit: String(COMMENTS_PER_POST) },
      token,
    })),
  );

  results.forEach((result, i) => {
    const post = posts[i]!;
    if (!result.ok) {
      issues.push({ asset: assetName, detail: `${post.id}: ${result.error.message}` });
      return;
    }
    for (const comment of result.data.data ?? []) {
      rows.push({
        surface,
        assetName,
        postId: post.id,
        postCaption: snippet(captionOf(post)),
        postPermalink: linkOf(post),
        commentId: comment.id,
        date: (comment.created_time ?? comment.timestamp ?? "").slice(0, 10),
        author: comment.username ?? comment.from?.name,
        text: (comment.text ?? comment.message ?? "").replace(/\s+/g, " ").trim(),
        likeCount: comment.like_count,
        replyCount: comment.comment_count,
      });
    }
  });
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
