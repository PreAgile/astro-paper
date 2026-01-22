/**
 * Vercel Serverless Function 버전
 *
 * 사용법:
 * 1. 이 파일을 api/view/[slug].js 로 복사
 * 2. Vercel KV 또는 Upstash Redis 연결
 *
 * 파일 구조:
 * api/
 * ├── view/
 * │   └── [slug].js    # POST/GET /api/view/:slug
 * ├── views.js         # GET /api/views
 * └── export.js        # GET /api/export
 */

import { kv } from "@vercel/kv"; // 또는 import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  const { slug } = req.query;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const key = `views:${slug}`;

  if (req.method === "POST") {
    const count = await kv.incr(key);
    return res.json({ slug, count });
  }

  if (req.method === "GET") {
    const count = (await kv.get(key)) || 0;
    return res.json({ slug, count });
  }

  res.status(405).json({ error: "Method not allowed" });
}

// Vercel KV 설정:
// 1. Vercel 대시보드 → Storage → Create KV Database
// 2. 자동으로 환경변수 설정됨
