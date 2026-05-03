import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import GithubSlugger from "github-slugger";
import { slugify } from "transliteration";
import type { Root, Element, Text, ElementContent } from "hast";

/**
 * rehype plugin: clean ASCII heading IDs + matching TOC.
 *
 * Pass 1 — heading IDs:
 *   - `## title {#custom-id}` ⇒ id is `custom-id`, marker is stripped from rendered text
 *   - other headings ⇒ transliterate text (Korean → romanized) and slugify to ASCII
 *   - duplicates within a document get a numeric suffix
 *
 * Pass 2 — TOC regeneration:
 *   - finds the h2 whose id is `table-of-contents` (the marker heading)
 *   - removes everything until the next h2, then inserts a fresh nested `<ul>` of `<a href="#id">`
 *     entries collected from subsequent h2/h3 headings (with the now-correct ASCII IDs)
 *   - if the article has no `## Table of contents` heading, this pass is a no-op
 *
 * Replaces the prior remark-toc + remark-collapse + rehype-slug pipeline for headings.
 */
const CUSTOM_ID_RE = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

export function rehypeAsciiSlug() {
  return (tree: Root) => {
    // ── Pass 1: assign ASCII heading IDs ───────────────────────────────────
    const slugger = new GithubSlugger();
    visit(tree, "element", (node: Element) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      node.properties = node.properties || {};

      const fullText = toString(node);
      const explicit = fullText.match(CUSTOM_ID_RE);

      if (explicit) {
        stripCustomIdMarker(node);
        node.properties.id = slugger.slug(explicit[1]);
        return;
      }

      const ascii = slugify(fullText, { lowercase: true, separator: "-" });
      const base = ascii.length > 0 ? ascii : "section";
      node.properties.id = slugger.slug(base);
    });

    // ── Pass 2: rebuild Table of contents ──────────────────────────────────
    const tocIndex = tree.children.findIndex(
      child =>
        child.type === "element" &&
        child.tagName === "h2" &&
        (child.properties?.id === "table-of-contents" ||
          child.properties?.id === "toc"),
    );
    if (tocIndex === -1) return;

    // Collect subsequent h2/h3 headings (excluding the TOC heading itself).
    const entries: Array<{ level: number; text: string; id: string }> = [];
    for (let i = tocIndex + 1; i < tree.children.length; i++) {
      const child = tree.children[i];
      if (child.type !== "element") continue;
      const match = child.tagName.match(/^h([2-3])$/);
      if (!match) continue;
      const id = typeof child.properties?.id === "string" ? child.properties.id : "";
      if (!id) continue;
      entries.push({ level: Number(match[1]), text: toString(child), id });
    }

    // Find the boundary of the existing TOC block (until the next h2).
    let endIndex = tocIndex + 1;
    while (endIndex < tree.children.length) {
      const child = tree.children[endIndex];
      if (child.type === "element" && child.tagName === "h2") break;
      endIndex++;
    }

    // Build a nested <ul> from entries.
    const ul = buildTocList(entries);

    // Wrap in a <details> for collapse UX.
    const details: Element = {
      type: "element",
      tagName: "details",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "summary",
          properties: {},
          children: [{ type: "text", value: "Open Table of contents" }],
        },
        ul,
      ],
    };

    // Replace [tocIndex+1, endIndex) with the fresh TOC block.
    tree.children.splice(tocIndex + 1, endIndex - (tocIndex + 1), details);
  };
}

function buildTocList(
  entries: Array<{ level: number; text: string; id: string }>,
): Element {
  const root: Element = {
    type: "element",
    tagName: "ul",
    properties: {},
    children: [],
  };

  // Two-level: h2 entries become top-level <li>; h3 entries nest inside the last h2's child <ul>.
  let currentH2: Element | null = null;

  for (const entry of entries) {
    const li = makeLi(entry.text, entry.id);

    if (entry.level === 2) {
      root.children.push(li);
      currentH2 = li;
    } else {
      // h3: nest inside the most recent h2 li (or root if none exists yet).
      const parent = currentH2 ?? root;
      const lastChild = parent.children[parent.children.length - 1];

      let nestedUl: Element | undefined;
      if (
        lastChild &&
        lastChild.type === "element" &&
        lastChild.tagName === "ul"
      ) {
        nestedUl = lastChild;
      } else {
        nestedUl = {
          type: "element",
          tagName: "ul",
          properties: {},
          children: [],
        };
        parent.children.push(nestedUl as ElementContent);
      }
      nestedUl.children.push(li);
    }
  }

  return root;
}

function makeLi(text: string, id: string): Element {
  return {
    type: "element",
    tagName: "li",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: `#${id}` },
        children: [{ type: "text", value: text }],
      },
    ],
  };
}

/**
 * Walk the heading's children and strip the trailing `{#id}` marker from the last text node.
 */
function stripCustomIdMarker(node: Element): void {
  const textNodes: Text[] = [];
  const collect = (n: Element | Text | { type: string; children?: unknown[] }): void => {
    if ("type" in n && n.type === "text") {
      textNodes.push(n as Text);
    } else if ("children" in n && Array.isArray(n.children)) {
      for (const child of n.children) {
        collect(child as Element | Text);
      }
    }
  };
  collect(node);
  if (textNodes.length === 0) return;
  const last = textNodes[textNodes.length - 1];
  last.value = last.value.replace(CUSTOM_ID_RE, "");
}
