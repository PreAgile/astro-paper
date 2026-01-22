/**
 * Blog View Counter API
 *
 * 추상화된 스토리지 인터페이스로 백엔드 교체가 쉽습니다.
 *
 * 지원 백엔드:
 * - Cloudflare KV (현재)
 * - Upstash Redis (마이그레이션 가능)
 * - Supabase (마이그레이션 가능)
 * - Vercel KV (마이그레이션 가능)
 *
 * API 스펙 (어떤 백엔드든 동일):
 * - POST /view/:slug → { slug, count }
 * - GET /view/:slug → { slug, count }
 * - GET /views → { views: { slug: count }, total }
 * - GET /export → 전체 데이터 JSON (마이그레이션용)
 */

// ============================================
// Storage Interface - 백엔드별로 이 부분만 교체
// ============================================

class CloudflareKVStorage {
  constructor(kv) {
    this.kv = kv;
  }

  async get(key) {
    const value = await this.kv.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  async set(key, value) {
    await this.kv.put(key, value.toString());
  }

  async increment(key) {
    const current = await this.get(key);
    const newValue = current + 1;
    await this.set(key, newValue);
    return newValue;
  }

  async list() {
    const result = await this.kv.list();
    const data = {};
    for (const key of result.keys) {
      data[key.name] = await this.get(key.name);
    }
    return data;
  }
}

// Upstash Redis로 마이그레이션 시 이 클래스 사용
// class UpstashStorage {
//   constructor(url, token) {
//     this.url = url;
//     this.token = token;
//   }
//   async get(key) { /* Redis GET */ }
//   async set(key, value) { /* Redis SET */ }
//   async increment(key) { /* Redis INCR */ }
//   async list() { /* Redis KEYS + MGET */ }
// }

// ============================================
// API Handler
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Storage 인스턴스 생성 (백엔드 교체 시 여기만 변경)
    const storage = new CloudflareKVStorage(env.VIEW_COUNTS);

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /view/:slug - 조회수 증가
    if (request.method === "POST" && path.startsWith("/view/")) {
      const slug = decodeURIComponent(path.replace("/view/", ""));
      if (!slug) return jsonResponse({ error: "Slug required" }, 400);

      const count = await storage.increment(slug);
      return jsonResponse({ slug, count });
    }

    // GET /view/:slug - 조회수 조회
    if (request.method === "GET" && path.startsWith("/view/")) {
      const slug = decodeURIComponent(path.replace("/view/", ""));
      if (!slug) return jsonResponse({ error: "Slug required" }, 400);

      const count = await storage.get(slug);
      return jsonResponse({ slug, count });
    }

    // GET /views - 전체 목록
    if (request.method === "GET" && path === "/views") {
      const views = await storage.list();
      return jsonResponse({ views, total: Object.keys(views).length });
    }

    // GET /export - 마이그레이션용 전체 덤프
    if (request.method === "GET" && path === "/export") {
      const views = await storage.list();
      return jsonResponse({
        exportedAt: new Date().toISOString(),
        format: "v1",
        data: views,
      });
    }

    // POST /import - 마이그레이션용 데이터 가져오기
    if (request.method === "POST" && path === "/import") {
      try {
        const body = await request.json();
        if (!body.data) return jsonResponse({ error: "data required" }, 400);

        let imported = 0;
        for (const [slug, count] of Object.entries(body.data)) {
          await storage.set(slug, count);
          imported++;
        }
        return jsonResponse({ imported, success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 400);
      }
    }

    // GET /health
    if (path === "/health") {
      return jsonResponse({ status: "ok", backend: "cloudflare-kv" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
