import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "@/config";
import { getPath } from "@/utils/getPath";
import getSortedPosts from "@/utils/getSortedPosts";

export const GET: APIRoute = async () => {
  const posts = getSortedPosts(
    await getCollection("blog", ({ data }) => !data.draft)
  );
  const lines = [
    `# ${SITE.title}`,
    "",
    "> Evidence-backed backend engineering by 김면수 (Myeonsoo Kim): production problems, architecture decisions, reproducible experiments, and explicit limitations.",
    "",
    `Canonical site: ${SITE.website}`,
    `Author: ${new URL("/about/", SITE.website).href}`,
    `GitHub: ${SITE.profile}`,
    `Korean RSS: ${new URL("/rss.xml", SITE.website).href}`,
    `English RSS: ${new URL("/en/rss.xml", SITE.website).href}`,
    "",
    "## Primary series",
    "",
    `- [Building reputation-pool](${new URL("/en/series/reputation-pool/", SITE.website).href}): JDK-only core, concurrency contracts, open-core boundaries, multi-tenancy, and horizontal scaling.`,
    `- [reputation-pool 설계 기록](${new URL("/series/reputation-pool/", SITE.website).href}): 실제 PR, 실패 trace와 운영 제약을 연결한 한국어 원문 시리즈.`,
    "",
    "## Published articles",
    "",
    ...posts.flatMap(post => [
      `- [${post.data.title}](${new URL(getPath(post.id, post.filePath), SITE.website).href})`,
      `  ${post.data.description.replace(/\s+/g, " ").trim()}`,
    ]),
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
