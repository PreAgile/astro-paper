import type { APIRoute } from "astro";
import { SITE } from "@/config";
import {
  getPublishedPosts,
  MARKDOWN_HEADERS,
  renderPortableMarkdown,
} from "@/utils/getPortablePosts";

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();
  const header = [
    `# ${SITE.title} — full text`,
    "",
    `> Every published article on ${SITE.website} as Markdown, Korean and English. Index: ${new URL("/llms.txt", SITE.website).href}`,
    "",
  ].join("\n");

  return new Response(
    [header, ...posts.map(renderPortableMarkdown)].join("\n\n"),
    { headers: MARKDOWN_HEADERS }
  );
};
