/**
 * Supabase Storage
 *
 * 마이그레이션 방법:
 * 1. supabase.com에서 프로젝트 생성
 * 2. 아래 SQL로 테이블 생성:
 *
 *    CREATE TABLE view_counts (
 *      slug TEXT PRIMARY KEY,
 *      count INTEGER DEFAULT 0,
 *      updated_at TIMESTAMPTZ DEFAULT NOW()
 *    );
 *
 *    CREATE OR REPLACE FUNCTION increment_view(p_slug TEXT)
 *    RETURNS INTEGER AS $$
 *    DECLARE
 *      new_count INTEGER;
 *    BEGIN
 *      INSERT INTO view_counts (slug, count)
 *      VALUES (p_slug, 1)
 *      ON CONFLICT (slug)
 *      DO UPDATE SET count = view_counts.count + 1, updated_at = NOW()
 *      RETURNING count INTO new_count;
 *      RETURN new_count;
 *    END;
 *    $$ LANGUAGE plpgsql;
 *
 * 환경변수:
 * - SUPABASE_URL
 * - SUPABASE_ANON_KEY
 */

export class SupabaseStorage {
  constructor(url, key) {
    this.url = url;
    this.key = key;
  }

  async #fetch(path, options = {}) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Prefer: options.prefer || "return=representation",
      },
      ...options,
    });
    return response.json();
  }

  async #rpc(fn, params) {
    const response = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
    return response.json();
  }

  async get(key) {
    const data = await this.#fetch(`view_counts?slug=eq.${encodeURIComponent(key)}&select=count`);
    return data[0]?.count || 0;
  }

  async set(key, value) {
    await this.#fetch("view_counts", {
      method: "POST",
      body: JSON.stringify({ slug: key, count: value }),
      prefer: "resolution=merge-duplicates",
    });
  }

  async increment(key) {
    const result = await this.#rpc("increment_view", { p_slug: key });
    return result;
  }

  async list() {
    const data = await this.#fetch("view_counts?select=slug,count");
    const result = {};
    for (const row of data) {
      result[row.slug] = row.count;
    }
    return result;
  }
}

// 사용 예시:
// const storage = new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
