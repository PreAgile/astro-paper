import type { APIRoute, GetStaticPaths } from "astro";
import type { CollectionEntry } from "astro:content";
import { getPath } from "@/utils/getPath";
import {
  getPublishedPosts,
  MARKDOWN_HEADERS,
  renderPortableMarkdown,
} from "@/utils/getPortablePosts";

export const getStaticPaths = (async () => {
  const posts = await getPublishedPosts("en");
  return posts.map(post => ({
    params: { slug: getPath(post.id, post.filePath, false) },
    props: { post },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ post: CollectionEntry<"blog"> }> = ({ props }) =>
  new Response(renderPortableMarkdown(props.post), {
    headers: MARKDOWN_HEADERS,
  });
