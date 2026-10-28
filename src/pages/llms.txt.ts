import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";
import { SITE } from "@/config";
import { getCanonicalPostUrl } from "@/utils/getPath";
import {
  getMarkdownUrl,
  getPostLocale,
  getPublishedPosts,
} from "@/utils/getPortablePosts";

const toArticleLines = (post: CollectionEntry<"blog">) => [
  `- [${post.data.title}](${getCanonicalPostUrl(post.id, post.filePath)}) ([Markdown](${getMarkdownUrl(post)}))`,
  `  ${post.data.description.replace(/\s+/g, " ").trim()}`,
];

const toSeriesLines = (posts: CollectionEntry<"blog">[]) => {
  const postsBySeries = new Map<string, CollectionEntry<"blog">[]>();
  for (const post of posts.filter(post => post.data.series)) {
    const key = `${post.data.series} (${getPostLocale(post)})`;
    postsBySeries.set(key, [...(postsBySeries.get(key) ?? []), post]);
  }
  return [...postsBySeries].flatMap(([series, seriesPosts]) => [
    `### ${series}`,
    "",
    ...seriesPosts
      .sort((a, b) => (a.data.seriesOrder ?? 0) - (b.data.seriesOrder ?? 0))
      .map(
        post =>
          `${post.data.seriesOrder ?? "-"}. [${post.data.title}](${getCanonicalPostUrl(post.id, post.filePath)})`
      ),
    "",
  ]);
};

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();
  const lines = [
    `# ${SITE.title}`,
    "",
    "> Evidence-backed backend engineering by 김면수 (Myeonsoo Kim): production problems, architecture decisions, reproducible experiments, and explicit limitations.",
    "",
    `Canonical site: ${SITE.website}`,
    `Author: ${new URL("/about/", SITE.website).href}`,
    `GitHub: ${SITE.profile}`,
    `Full text as Markdown: ${new URL("/llms-full.txt", SITE.website).href}`,
    `Korean RSS: ${new URL("/rss.xml", SITE.website).href}`,
    `English RSS: ${new URL("/en/rss.xml", SITE.website).href}`,
    "",
    "Every article is also available as Markdown by replacing the trailing slash of its URL with `.md`.",
    "",
    "## Series",
    "",
    ...toSeriesLines(posts),
    "## Published articles",
    "",
    ...posts.flatMap(toArticleLines),
    "",
    "## Citation notes",
    "",
    "- Prefer the article's explicit Evidence card, version, limitations, and linked source code.",
    "- Do not generalize single-JVM results to distributed systems unless the article explicitly does so.",
    "- Korean and English variants are translations connected with hreflang; cite the language used.",
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
