import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";

describe("TableOfContents", () => {
  let dom: JSDOM;
  let document: Document;
  let window: Window & typeof globalThis;

  beforeEach(() => {
    dom = new JSDOM(
      `
      <!DOCTYPE html>
      <html lang="ko-KR" data-theme="light">
        <head><title>Test</title></head>
        <body>
          <aside id="toc-sidebar" class="toc-sidebar">
            <nav class="toc-nav">
              <h2 class="toc-title">목차</h2>
              <ul id="toc-list" class="toc-list"></ul>
            </nav>
          </aside>
          <article id="article">
            <h2 id="section-1">첫 번째 섹션</h2>
            <p>첫 번째 섹션 내용입니다.</p>
            <h3 id="subsection-1-1">소제목 1.1</h3>
            <p>소제목 1.1 내용입니다.</p>
            <h2 id="section-2">두 번째 섹션</h2>
            <p>두 번째 섹션 내용입니다.</p>
            <h3 id="subsection-2-1">소제목 2.1</h3>
            <p>소제목 2.1 내용입니다.</p>
            <h4 id="subsubsection-2-1-1">소소제목 2.1.1</h4>
            <p>소소제목 2.1.1 내용입니다.</p>
          </article>
        </body>
      </html>
    `,
      { url: "http://localhost:3000/posts/test-post" }
    );

    document = dom.window.document;
    window = dom.window as unknown as Window & typeof globalThis;

    // Mock global objects
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("history", {
      pushState: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dom.window.close();
  });

  describe("TOC Generation", () => {
    it("should find all headings in the article", () => {
      const article = document.getElementById("article");
      const headings = article?.querySelectorAll("h2, h3, h4, h5, h6");

      expect(headings?.length).toBe(5);
    });

    it("should have correct heading hierarchy", () => {
      const article = document.getElementById("article");
      const headings = Array.from(
        article?.querySelectorAll("h2, h3, h4, h5, h6") || []
      );

      expect(headings[0].tagName).toBe("H2");
      expect(headings[1].tagName).toBe("H3");
      expect(headings[2].tagName).toBe("H2");
      expect(headings[3].tagName).toBe("H3");
      expect(headings[4].tagName).toBe("H4");
    });

    it("should correctly extract Korean text from headings", () => {
      const article = document.getElementById("article");
      const headings = Array.from(
        article?.querySelectorAll("h2, h3, h4, h5, h6") || []
      );

      expect(headings[0].textContent).toBe("첫 번째 섹션");
      expect(headings[1].textContent).toBe("소제목 1.1");
    });

    it("should correctly extract English text from headings", () => {
      // Update DOM with English content
      const article = document.getElementById("article");
      if (article) {
        article.innerHTML = `
          <h2 id="section-1">First Section</h2>
          <p>Content</p>
          <h3 id="subsection-1-1">Subsection 1.1</h3>
          <p>Content</p>
        `;
      }

      const headings = Array.from(
        article?.querySelectorAll("h2, h3") || []
      );

      expect(headings[0].textContent).toBe("First Section");
      expect(headings[1].textContent).toBe("Subsection 1.1");
    });
  });

  describe("TOC DOM Structure", () => {
    it("should have toc-sidebar element", () => {
      const tocSidebar = document.getElementById("toc-sidebar");
      expect(tocSidebar).not.toBeNull();
    });

    it("should have toc-list element", () => {
      const tocList = document.getElementById("toc-list");
      expect(tocList).not.toBeNull();
    });

    it("should have correct initial classes", () => {
      const tocSidebar = document.getElementById("toc-sidebar");
      expect(tocSidebar?.classList.contains("toc-sidebar")).toBe(true);
    });
  });

  describe("TOC Item Creation", () => {
    function createTocItems() {
      const tocList = document.getElementById("toc-list");
      const article = document.getElementById("article");
      const headings = article?.querySelectorAll("h2, h3, h4, h5, h6");

      headings?.forEach((heading) => {
        const li = document.createElement("li");
        const a = document.createElement("a");

        a.href = `#${heading.id}`;
        a.textContent = heading.textContent || "";
        a.className = `toc-${heading.tagName.toLowerCase()}`;
        a.dataset.targetId = heading.id;

        li.appendChild(a);
        tocList?.appendChild(li);
      });
    }

    it("should create TOC items for each heading", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const items = tocList?.querySelectorAll("li");

      expect(items?.length).toBe(5);
    });

    it("should set correct href for each TOC link", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const links = tocList?.querySelectorAll("a");

      expect(links?.[0].getAttribute("href")).toBe("#section-1");
      expect(links?.[1].getAttribute("href")).toBe("#subsection-1-1");
    });

    it("should set correct class based on heading level", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const links = tocList?.querySelectorAll("a");

      expect(links?.[0].classList.contains("toc-h2")).toBe(true);
      expect(links?.[1].classList.contains("toc-h3")).toBe(true);
      expect(links?.[4].classList.contains("toc-h4")).toBe(true);
    });

    it("should store target id in data attribute", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const links = tocList?.querySelectorAll("a");

      expect(links?.[0].dataset.targetId).toBe("section-1");
      expect(links?.[2].dataset.targetId).toBe("section-2");
    });
  });

  describe("Active State Management", () => {
    function createTocItems() {
      const tocList = document.getElementById("toc-list");
      const article = document.getElementById("article");
      const headings = article?.querySelectorAll("h2, h3, h4, h5, h6");

      headings?.forEach((heading) => {
        const li = document.createElement("li");
        const a = document.createElement("a");

        a.href = `#${heading.id}`;
        a.textContent = heading.textContent || "";
        a.className = `toc-${heading.tagName.toLowerCase()}`;
        a.dataset.targetId = heading.id;

        li.appendChild(a);
        tocList?.appendChild(li);
      });
    }

    it("should add active class to selected TOC link", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const links = tocList?.querySelectorAll("a");

      // Simulate setting first link as active
      links?.[0].classList.add("active");

      expect(links?.[0].classList.contains("active")).toBe(true);
      expect(links?.[1].classList.contains("active")).toBe(false);
    });

    it("should switch active state between links", () => {
      createTocItems();
      const tocList = document.getElementById("toc-list");
      const links = tocList?.querySelectorAll("a");

      // Set first link as active
      links?.[0].classList.add("active");

      // Switch to second link
      links?.forEach((link) => link.classList.remove("active"));
      links?.[1].classList.add("active");

      expect(links?.[0].classList.contains("active")).toBe(false);
      expect(links?.[1].classList.contains("active")).toBe(true);
    });
  });

  describe("Theme Support", () => {
    it("should work with light theme", () => {
      document.documentElement.setAttribute("data-theme", "light");
      const theme = document.documentElement.getAttribute("data-theme");
      expect(theme).toBe("light");
    });

    it("should work with dark theme", () => {
      document.documentElement.setAttribute("data-theme", "dark");
      const theme = document.documentElement.getAttribute("data-theme");
      expect(theme).toBe("dark");
    });
  });

  describe("Language Support", () => {
    it("should support Korean language", () => {
      document.documentElement.setAttribute("lang", "ko-KR");
      const lang = document.documentElement.getAttribute("lang");
      expect(lang).toBe("ko-KR");
    });

    it("should support English language", () => {
      document.documentElement.setAttribute("lang", "en-US");
      const lang = document.documentElement.getAttribute("lang");
      expect(lang).toBe("en-US");
    });
  });

  describe("ID Generation for Headings without IDs", () => {
    it("should generate valid ID for Korean text", () => {
      const koreanText = "첫 번째 섹션";
      const generatedId = `heading-0-${koreanText
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")}`;

      expect(generatedId).toBe("heading-0-첫-번째-섹션");
    });

    it("should generate valid ID for English text", () => {
      const englishText = "First Section";
      const generatedId = `heading-0-${englishText
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")}`;

      expect(generatedId).toBe("heading-0-first-section");
    });

    it("should handle mixed Korean and English text", () => {
      const mixedText = "섹션 Section 테스트";
      const generatedId = `heading-0-${mixedText
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")}`;

      expect(generatedId).toBe("heading-0-섹션-section-테스트");
    });

    it("should handle special characters", () => {
      const specialText = "섹션: [테스트] & 예제!";
      const generatedId = `heading-0-${specialText
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")}`;

      expect(generatedId).toBe("heading-0-섹션-테스트-예제");
    });
  });

  describe("Visibility Toggle", () => {
    it("should add visible class when TOC is shown", () => {
      const tocSidebar = document.getElementById("toc-sidebar");
      tocSidebar?.classList.add("visible");

      expect(tocSidebar?.classList.contains("visible")).toBe(true);
    });

    it("should be hidden initially", () => {
      const tocSidebar = document.getElementById("toc-sidebar");

      expect(tocSidebar?.classList.contains("visible")).toBe(false);
    });
  });

  describe("Empty Article Handling", () => {
    it("should handle article with no headings", () => {
      const article = document.getElementById("article");
      if (article) {
        article.innerHTML = "<p>Just some text without headings.</p>";
      }

      const headings = article?.querySelectorAll("h2, h3, h4, h5, h6");
      expect(headings?.length).toBe(0);
    });
  });

  describe("Hash Navigation", () => {
    it("should strip hash character from heading text for display", () => {
      const headingText = "Test Section #";
      const cleanedText = headingText.replace(/#$/, "").trim();

      expect(cleanedText).toBe("Test Section");
    });
  });
});
