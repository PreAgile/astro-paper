import { describe, it, expect } from "vitest";
import { toPortableBody, toPortableMarkdown } from "../toPortableMarkdown";

const SITE_URL = "https://blog.example.com/";

describe("toPortableBody", () => {
  it("removes the table-of-contents placeholder heading in both languages", () => {
    const body = "## Table of contents\n\ntext\n\n## 목차\n\nmore";

    expect(toPortableBody(body, SITE_URL)).toBe("text\n\nmore");
  });

  it("drops explicit heading anchors that other platforms would show literally", () => {
    const body = "## 1. 왜 원장인가 {#why-ledger}";

    expect(toPortableBody(body, SITE_URL)).toBe("## 1. 왜 원장인가");
  });

  it("turns root-relative links into absolute links so they survive a move", () => {
    const body = "[관련 글](/posts/outbox/) and ![diagram](/images/a.png)";

    expect(toPortableBody(body, SITE_URL)).toBe(
      "[관련 글](https://blog.example.com/posts/outbox/) and ![diagram](https://blog.example.com/images/a.png)"
    );
  });

  it("flattens a details toggle into a bold label followed by its body", () => {
    const body = [
      "<details>",
      "<summary><b>(심도) Quartz가 무거운 이유</b> (펼치기)</summary>",
      "",
      "본문입니다.",
      "",
      "</details>",
    ].join("\n");

    expect(toPortableBody(body, SITE_URL)).toBe(
      "**(심도) Quartz가 무거운 이유**\n\n본문입니다."
    );
  });

  it("removes editor-only HTML comments", () => {
    const body = "<!--\n- [ ] 회사 승인\n-->\n\n본문";

    expect(toPortableBody(body, SITE_URL)).toBe("본문");
  });

  it("leaves code blocks untouched, including mermaid and lookalike syntax", () => {
    const body = [
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "```markdown",
      "## Table of contents",
      "[x](/posts/a/)",
      "<!-- keep -->",
      "## Title {#keep-anchor}",
      "```",
    ].join("\n");

    expect(toPortableBody(body, SITE_URL)).toBe(body);
  });
});

describe("toPortableMarkdown", () => {
  it("adds frontmatter with the canonical URL and an original-source notice", () => {
    const markdown = toPortableMarkdown({
      title: "Timers That Keep Moving",
      description: "A ledger\n  design.",
      canonicalUrl: "https://blog.example.com/en/posts/timers/",
      siteUrl: SITE_URL,
      locale: "en",
      pubDatetime: new Date("2026-10-28T09:00:00.000Z"),
      tags: ["MySQL", "Scheduling"],
      series: "delayed-job-platform",
      seriesOrder: 1,
      body: "Body.",
    });

    expect(markdown).toBe(
      [
        "---",
        'title: "Timers That Keep Moving"',
        'description: "A ledger design."',
        "canonical_url: https://blog.example.com/en/posts/timers/",
        "lang: en",
        "date: 2026-10-28T09:00:00.000Z",
        'tags: ["MySQL", "Scheduling"]',
        "series: delayed-job-platform",
        "series_order: 1",
        "---",
        "",
        "# Timers That Keep Moving",
        "",
        "> Originally published at https://blog.example.com/en/posts/timers/",
        "",
        "Body.",
        "",
      ].join("\n")
    );
  });
});
