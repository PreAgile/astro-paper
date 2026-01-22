/**
 * Netlify Functions 버전
 *
 * 사용법:
 * 1. 이 파일을 netlify/functions/view.js 로 복사
 * 2. Upstash Redis 연결 (Netlify Blobs는 카운터에 부적합)
 *
 * 파일 구조:
 * netlify/
 * └── functions/
 *     ├── view.js      # /api/view/:slug
 *     └── views.js     # /api/views
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function handler(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers };
  }

  // URL에서 slug 추출: /.netlify/functions/view/my-post
  const slug = event.path.replace("/.netlify/functions/view/", "");
  const key = `views:${slug}`;

  if (event.httpMethod === "POST") {
    const count = await redis.incr(key);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ slug, count }),
    };
  }

  if (event.httpMethod === "GET") {
    const count = (await redis.get(key)) || 0;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ slug, count }),
    };
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
}
