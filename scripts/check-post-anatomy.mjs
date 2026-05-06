#!/usr/bin/env node
// AGENT.md 의 표기 룰과 Deep-Dive Post Anatomy 룰을 자동 점검한다.
// 사용: bun run check:posts  (또는 node scripts/check-post-anatomy.mjs)
//
// 검사 항목
//   1. 표기 룰: 본문에 § 기호 사용 금지 (외부 spec 인용 — JLS / JSR / RFC / ECMA — 만 예외)
//   2. depth: deep-dive 라벨이 붙은 글에 한해 8 개 anatomy 장치 점검
//
// 종료 코드: 표기 룰 위반이 있으면 1, 없으면 0 (anatomy 누락은 warning)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BLOG_DIR = join(__dirname, '..', 'src', 'data', 'blog');

// 외부 spec 인용 화이트리스트 — 공식 표기법이라 § 유지
const SPEC_PATTERNS = [
  /\bJLS §[0-9.]+/g,                       // Java Language Specification (Oracle)
  /\(JSR \d+\)[*\s]*§[0-9.]+/g,            // JPA / JSR spec
  /\bRFC \d+[,\s]+§[0-9.]+/g,              // IETF RFC
  /\bECMA-\d+[,\s]+§[0-9.]+/g,             // ECMA spec
];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_]*):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function findIllegalSection(content) {
  let masked = content;
  for (const pattern of SPEC_PATTERNS) {
    masked = masked.replace(pattern, m => '_'.repeat(m.length));
  }
  const lines = masked.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('§')) {
      violations.push({ line: i + 1, content: lines[i].trim().slice(0, 120) });
    }
  }
  return violations;
}

const DEEP_DIVE_CHECKS_KO = [
  { name: 'TL;DR',                  pattern: /TL;?DR/i },
  { name: '0 번 절 (Cold Open)',    pattern: /^##\s+0\.\s+/m },
  { name: '왜 챕터',                pattern: /^(##|###)\s+[\d\.]+\s+.*왜/m },
  { name: '측정 표 (베이스라인)',   pattern: /(baseline|S1|S2|S3|S4|S5|S6|시나리오)/i },
  { name: '자가진단',               pattern: /자가\s*진단|Self[\s-]?Check/i },
  { name: '의사결정 매트릭스',      pattern: /의사결정\s*매트릭스|Decision\s*Matrix/i },
  { name: '한계 섹션',              pattern: /^##\s+.*한계/m },
  { name: 'FAQ',                    pattern: /\bFAQ\b/ },
  { name: '참고자료 주제별 분리',   pattern: /^###\s+.*(공식|canonical|Canonical|보조|한국어|외부|패턴|설계|spec)/m },
];

const DEEP_DIVE_CHECKS_EN = [
  { name: 'TL;DR',                  pattern: /TL;?DR/i },
  { name: 'Cold Open (Section 0)',  pattern: /^##\s+0\.\s+/m },
  { name: 'Why chapter',            pattern: /^(##|###)\s+[\d\.]+\s+.*Why/m },
  { name: 'Measurement table',      pattern: /(baseline|S1|S2|S3|S4|S5|S6|scenario)/i },
  { name: 'Self-check',             pattern: /Self[\s-]?Check|Diagnos/i },
  { name: 'Decision matrix',        pattern: /Decision\s*Matrix/i },
  { name: 'Limitations',            pattern: /^##\s+.*Limit/im },
  { name: 'FAQ',                    pattern: /\bFAQ\b/ },
  { name: 'References sub-sections', pattern: /^###\s+(Official|Canonical|Books|External|Reference|Spec|Design|Pattern)/m },
];

function checkAnatomy(content, locale) {
  const checks = locale === 'en' ? DEEP_DIVE_CHECKS_EN : DEEP_DIVE_CHECKS_KO;
  return checks.filter(c => !c.pattern.test(content)).map(c => c.name);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.md')) yield path;
  }
}

const errors = [];
const warnings = [];
let totalFiles = 0;
let deepDiveCount = 0;

for (const filepath of walk(BLOG_DIR)) {
  totalFiles++;
  const content = readFileSync(filepath, 'utf8');
  const fm = parseFrontmatter(content);
  const relPath = filepath.replace(BLOG_DIR + '/', '');
  const locale = relPath.startsWith('en/') ? 'en' : 'ko';

  const sectionViolations = findIllegalSection(content);
  for (const v of sectionViolations) {
    errors.push(`${relPath}:${v.line}: § 사용 — ${v.content}`);
  }

  if (fm.depth === 'deep-dive') {
    deepDiveCount++;
    const failed = checkAnatomy(content, locale);
    if (failed.length > 0) {
      warnings.push(`${relPath} [deep-dive]: 누락 — ${failed.join(', ')}`);
    }
  }
}

console.log(`\n📚 검사 대상: ${totalFiles} 글 (deep-dive 라벨: ${deepDiveCount})`);

if (errors.length > 0) {
  console.error(`\n❌ 표기 룰 위반 (§ 기호) — ${errors.length} 건`);
  for (const e of errors) console.error(`  ${e}`);
  console.error(`\n   → 외부 spec (JLS / JSR / RFC / ECMA) 외에는 § 금지.`);
  console.error(`   → 변환 규칙: AGENT.md "표기 규칙 — 본문 안의 절 참조" 섹션.`);
}

if (warnings.length > 0) {
  console.warn(`\n⚠️  Deep-Dive Anatomy 미흡 — ${warnings.length} 글`);
  for (const w of warnings) console.warn(`  ${w}`);
  console.warn(`\n   → AGENT.md "Deep-Dive Post Anatomy" 의 8 개 장치 참고.`);
}

if (errors.length === 0 && warnings.length === 0) {
  console.log(`\n✅ 모든 검사 통과.`);
}

process.exit(errors.length > 0 ? 1 : 0);
