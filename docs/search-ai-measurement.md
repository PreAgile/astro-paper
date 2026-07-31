# Search and AI discovery measurement

This site keeps one canonical origin:

`https://astro-paper-23v.pages.dev/`

## Google Search Console

1. Create a URL-prefix property for the canonical origin.
2. Put the provided HTML-tag token in `PUBLIC_GOOGLE_SITE_VERIFICATION`.
3. Deploy and verify that the token appears in the home page `<head>`.
4. Submit `https://astro-paper-23v.pages.dev/sitemap-index.xml`.
5. Review indexing, query impressions, and the Generative AI performance report when available.

## GA4 and ChatGPT referrals

1. Create a GA4 web data stream for the canonical origin.
2. Set `PUBLIC_GA_MEASUREMENT_ID` to the `G-...` measurement ID.
3. Deploy and verify a `page_view` in GA4 Realtime.
4. In Traffic acquisition, filter by:
   - session source `chatgpt.com`, or
   - campaign parameter `utm_source=chatgpt.com`.

OpenAI adds `utm_source=chatgpt.com` to referral links from ChatGPT search.

## Monthly evidence report

Record these values once per month instead of evaluating individual daily changes:

| Metric | Source |
| --- | --- |
| Valid indexed pages | Search Console Pages |
| Non-branded query impressions | Search Console Performance |
| Generative AI impressions/clicks | Search Console Generative AI report |
| ChatGPT sessions | GA4 Traffic acquisition |
| GitHub referral sessions | GA4 Traffic acquisition |
| RSS subscribers | RSS service or server analytics |
| Backlinks to evidence-led posts | Search Console Links |

Do not infer ranking success from crawl logs alone. A crawler request proves access, not citation or ranking.
