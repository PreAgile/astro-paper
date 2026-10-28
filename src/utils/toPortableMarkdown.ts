export type PortablePost = {
  title: string;
  description: string;
  canonicalUrl: string;
  siteUrl: string;
  locale: "ko" | "en";
  pubDatetime: Date;
  modDatetime?: Date | null;
  tags: string[];
  series?: string;
  seriesOrder?: number;
  body: string;
};

const FENCE = /^\s*(```|~~~)/;
const TABLE_OF_CONTENTS_HEADING = /^##\s+(Table of contents|목차)\s*$/i;
const HEADING_ANCHOR = /^(#{1,6}\s.*?)\s*\{#[^}]+\}\s*$/;
const DETAILS_TAG = /^\s*<\/?details>\s*$/;
const SUMMARY_LINE = /^\s*<summary>(.*)<\/summary>\s*$/;
const TOGGLE_MARKER = /\s*\((펼치기|expand)\)\s*$/i;
const ROOT_RELATIVE_LINK = /\]\((\/[^)\s]*)/g;

function toPlainSummary(summaryHtml: string): string {
  return summaryHtml
    .replace(/<[^>]+>/g, "")
    .replace(TOGGLE_MARKER, "")
    .trim();
}

function rewriteProseLine(line: string, siteOrigin: string): string | null {
  if (TABLE_OF_CONTENTS_HEADING.test(line) || DETAILS_TAG.test(line)) {
    return null;
  }
  const summary = line.match(SUMMARY_LINE);
  if (summary) {
    return `**${toPlainSummary(summary[1])}**`;
  }
  return line
    .replace(HEADING_ANCHOR, "$1")
    .replace(ROOT_RELATIVE_LINK, `](${siteOrigin}$1`);
}

function stripHtmlCommentsOutsideFences(body: string): string {
  const segments = body.split(/(^\s*(?:```|~~~)[\s\S]*?^\s*(?:```|~~~)\s*$)/m);
  return segments
    .map(segment =>
      FENCE.test(segment) ? segment : segment.replace(/<!--[\s\S]*?-->/g, "")
    )
    .join("");
}

export function toPortableBody(body: string, siteUrl: string): string {
  const siteOrigin = siteUrl.replace(/\/$/, "");
  let insideFence = false;
  const lines: string[] = [];

  for (const line of stripHtmlCommentsOutsideFences(body).split("\n")) {
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      lines.push(line);
      continue;
    }
    if (insideFence) {
      lines.push(line);
      continue;
    }
    const rewritten = rewriteProseLine(line, siteOrigin);
    if (rewritten !== null) lines.push(rewritten);
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

export function toPortableMarkdown(post: PortablePost): string {
  const frontmatter = [
    "---",
    `title: ${yamlString(post.title)}`,
    `description: ${yamlString(post.description)}`,
    `canonical_url: ${post.canonicalUrl}`,
    `lang: ${post.locale}`,
    `date: ${post.pubDatetime.toISOString()}`,
    ...(post.modDatetime ? [`updated: ${post.modDatetime.toISOString()}`] : []),
    `tags: [${post.tags.map(yamlString).join(", ")}]`,
    ...(post.series ? [`series: ${post.series}`] : []),
    ...(post.seriesOrder ? [`series_order: ${post.seriesOrder}`] : []),
    "---",
  ];
  const originalNotice =
    post.locale === "ko"
      ? `> 원문: ${post.canonicalUrl}`
      : `> Originally published at ${post.canonicalUrl}`;

  return (
    [
      frontmatter.join("\n"),
      `# ${post.title}`,
      originalNotice,
      toPortableBody(post.body, post.siteUrl),
    ].join("\n\n") + "\n"
  );
}
