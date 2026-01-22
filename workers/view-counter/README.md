# Blog View Counter

블로그 조회수 카운터 API. 백엔드 교체가 쉽도록 추상화되어 있습니다.

**블로그 호스팅과 API 호스팅은 완전히 분리되어 있어서, 블로그를 어디로 옮기든 API URL만 설정하면 됩니다.**

## 지원 플랫폼

### 블로그 호스팅 (어디든 가능)
- GitHub Pages
- Cloudflare Pages
- Vercel
- Netlify
- 기타 정적 호스팅

### API 호스팅

| 플랫폼 | 파일 | 스토리지 | 무료 티어 |
|--------|------|----------|----------|
| **Cloudflare Workers** | `index.js` | KV | 100K reads/day |
| **Vercel Functions** | `platforms/vercel.js` | Vercel KV | 30K req/month |
| **Netlify Functions** | `platforms/netlify.js` | Upstash | 10K cmd/day |

### 스토리지 백엔드

| 백엔드 | 무료 티어 | 특징 |
|--------|----------|------|
| **Cloudflare KV** | 100K reads/day | Pages와 통합 쉬움 |
| **Upstash Redis** | 10K commands/day | 서버리스 Redis |
| **Supabase** | 500MB DB | PostgreSQL 기반 |
| **Vercel KV** | 30K requests/month | Vercel 배포 시 편리 |

## 설정 방법

### 1. Cloudflare Workers + KV (권장)

```bash
# wrangler 설치
npm install -g wrangler

# 로그인
wrangler login

# KV 네임스페이스 생성
wrangler kv:namespace create "VIEW_COUNTS"
# 출력된 id를 wrangler.toml에 입력

# 배포
cd workers/view-counter
wrangler deploy
```

배포 후 Worker URL (예: `https://blog-view-counter.your-subdomain.workers.dev`)을
블로그 환경변수에 설정:

```bash
# .env
PUBLIC_VIEW_COUNT_API=https://blog-view-counter.your-subdomain.workers.dev
```

### 2. Upstash Redis로 마이그레이션

1. [upstash.com](https://upstash.com)에서 Redis 생성
2. `index.js` 수정:

```javascript
import { UpstashStorage } from './storages/upstash.js';

// 기존: const storage = new CloudflareKVStorage(env.VIEW_COUNTS);
const storage = new UpstashStorage(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
```

3. 환경변수 추가 (wrangler.toml):
```toml
[vars]
UPSTASH_REDIS_REST_URL = "https://xxx.upstash.io"
UPSTASH_REDIS_REST_TOKEN = "your-token"
```

### 3. Supabase로 마이그레이션

1. [supabase.com](https://supabase.com)에서 프로젝트 생성
2. SQL Editor에서 테이블 생성:

```sql
CREATE TABLE view_counts (
  slug TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION increment_view(p_slug TEXT)
RETURNS INTEGER AS $$
DECLARE new_count INTEGER;
BEGIN
  INSERT INTO view_counts (slug, count)
  VALUES (p_slug, 1)
  ON CONFLICT (slug)
  DO UPDATE SET count = view_counts.count + 1, updated_at = NOW()
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;
```

3. `index.js` 수정 후 배포

## API 스펙

모든 백엔드에서 동일한 API를 제공합니다:

| Method | Endpoint | 설명 |
|--------|----------|------|
| `POST` | `/view/:slug` | 조회수 증가 + 반환 |
| `GET` | `/view/:slug` | 조회수 조회만 |
| `GET` | `/views` | 전체 목록 |
| `GET` | `/export` | 마이그레이션용 전체 덤프 |
| `POST` | `/import` | 마이그레이션용 데이터 복원 |
| `GET` | `/health` | 헬스체크 |

### 응답 형식

```json
// POST/GET /view/:slug
{ "slug": "ko/my-post", "count": 123 }

// GET /views
{ "views": { "ko/post-1": 100, "ko/post-2": 50 }, "total": 2 }

// GET /export
{ "exportedAt": "2024-01-01T00:00:00Z", "format": "v1", "data": { ... } }
```

## 데이터 마이그레이션

기존 백엔드에서 새 백엔드로 이전:

```bash
# 1. 기존 데이터 내보내기
curl https://old-api.workers.dev/export > backup.json

# 2. 새 백엔드에 가져오기
curl -X POST https://new-api.workers.dev/import \
  -H "Content-Type: application/json" \
  -d @backup.json
```

## 로컬 개발

API 없이 로컬에서 테스트할 때는 localStorage를 사용합니다.
`PUBLIC_VIEW_COUNT_API` 환경변수가 없으면 자동으로 로컬 모드로 동작합니다.

## 구조

```
workers/view-counter/
├── index.js           # 메인 Worker (Cloudflare KV 기본)
├── wrangler.toml      # Cloudflare 설정
├── storages/
│   ├── upstash.js     # Upstash Redis 어댑터
│   └── supabase.js    # Supabase 어댑터
└── README.md
```
