import { getCollection, type CollectionEntry } from "astro:content";
import { SITE } from "@/config";
import { getCanonicalPostUrl, getPath } from "./getPath";
import getSortedPosts from "./getSortedPosts";
import { toPortableMarkdown } from "./toPortableMarkdown";

export type Locale = "ko" | "en";

export async function getPublishedPosts(locale?: Locale) {
  const posts = await getCollection("blog", ({ id }) =>
    locale ? id.startsWith(`${locale}/`) : /^(ko|en)\//.test(id)
  );
  return getSortedPosts(posts);
}

export function getPostLocale(post: CollectionEntry<"blog">): Locale {
  return post.id.startsWith("en/") ? "en" : "ko";
}

export function getMarkdownUrl(post: CollectionEntry<"blog">) {
  return new URL(`${getPath(post.id, post.filePath)}.md`, SITE.website).href;
}

export function renderPortableMarkdown(post: CollectionEntry<"blog">) {
  const { data } = post;
  return toPortableMarkdown({
    title: data.title,
    description: data.description,
    canonicalUrl: getCanonicalPostUrl(post.id, post.filePath),
    siteUrl: SITE.website,
    locale: getPostLocale(post),
    pubDatetime: data.pubDatetime,
    modDatetime: data.modDatetime,
    tags: data.tags,
    series: data.series,
    seriesOrder: data.seriesOrder,
    body: post.body ?? "",
  });
}

export const MARKDOWN_HEADERS = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
};
