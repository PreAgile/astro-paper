import { BLOG_PATH } from "@/content.config";
import { slugifyStr } from "./slugify";

/**
 * Get full path of a blog post
 * @param id - id of the blog post (aka slug)
 * @param filePath - the blog post full file location
 * @param includeBase - whether to include base path (default: true), or custom base path string
 * @returns blog post path
 */
export function getPath(
  id: string,
  filePath: string | undefined,
  includeBase: boolean | string = true
) {
  const pathSegments = filePath
    ?.replace(BLOG_PATH, "")
    .split("/")
    .filter(path => path !== "") // remove empty string in the segments ["", "other-path"] <- empty string will be removed
    .filter(path => !path.startsWith("_")) // exclude directories start with underscore "_"
    .filter(path => path !== "ko" && path !== "en") // exclude locale directories
    .slice(0, -1) // remove the last segment_ file name_ since it's unnecessary
    .map(segment => slugifyStr(segment)); // slugify each segment path

  // Determine base path
  let basePath: string;
  if (typeof includeBase === "string") {
    // Custom base path provided
    basePath = includeBase;
  } else if (includeBase === false) {
    // No base path (for slug generation)
    basePath = "";
  } else {
    // Auto-detect from id
    if (id.startsWith("en/")) {
      basePath = "/en/posts";
    } else if (id.startsWith("ko/")) {
      basePath = "/posts";
    } else {
      basePath = "/posts";
    }
  }

  // Making sure `id` does not contain the directory (including locale prefix)
  const blogId = id.split("/").filter(part => part !== "ko" && part !== "en");
  const slug = blogId.length > 0 ? blogId.slice(-1) : blogId;

  // If not inside the sub-dir, simply return the file path
  if (!pathSegments || pathSegments.length < 1) {
    if (basePath === "") {
      return slug.join("/");
    }
    return [basePath, slug].join("/");
  }

  if (basePath === "") {
    return [...pathSegments, slug].join("/");
  }
  return [basePath, ...pathSegments, slug].join("/");
}
