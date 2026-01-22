/**
 * Upstash Redis Storage
 *
 * 마이그레이션 방법:
 * 1. upstash.com에서 Redis 데이터베이스 생성
 * 2. REST URL과 Token 복사
 * 3. index.js에서 CloudflareKVStorage 대신 이 클래스 사용
 *
 * 환경변수:
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 */

export class UpstashStorage {
  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  async #fetch(command) {
    const response = await fetch(`${this.url}/${command.join("/")}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const data = await response.json();
    return data.result;
  }

  async get(key) {
    const value = await this.#fetch(["GET", `views:${key}`]);
    return value ? parseInt(value, 10) : 0;
  }

  async set(key, value) {
    await this.#fetch(["SET", `views:${key}`, value.toString()]);
  }

  async increment(key) {
    const result = await this.#fetch(["INCR", `views:${key}`]);
    return parseInt(result, 10);
  }

  async list() {
    const keys = await this.#fetch(["KEYS", "views:*"]);
    const data = {};

    for (const key of keys || []) {
      const slug = key.replace("views:", "");
      data[slug] = await this.get(slug);
    }

    return data;
  }
}

// 사용 예시:
// const storage = new UpstashStorage(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
