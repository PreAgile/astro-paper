#!/usr/bin/env node
// AGENT.md 의 표기 룰과 Deep-Dive Post Anatomy 룰을 자동 점검한다.
// 사용: bun run check:posts  (또는 node scripts/check-post-anatomy.mjs)
//
// 검사 항목
//   1. 표기 룰: 본문에 § 기호 사용 금지 (외부 spec 인용 — JLS / JSR / RFC / ECMA — 만 예외).
//      코드 블록 / 인라인 코드 안의 § 는 룰 설명용 인용으로 보고 통과.
//   2. depth: deep-dive 라벨이 붙은 글에 한해 8 개 anatomy 장치 점검.
//
// 검사 대상
//   - src/data/blog/{ko,en}/*.md  (블로그 글)
//   - AGENT.md                    (가이드라인 자체도 자기 룰 준수 검증)
//
// 종료 코드: 표기 룰 위반이 있으면 1, 없으면 0 (anatomy 누락은 warning).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const BLOG_DIR = join(ROOT, 'src', 'data', 'blog');
const AGENT_MD = join(ROOT, 'AGENT.md');

const SPEC_PATTERNS = [
  /\bJLS §[0-9.]+/g,
  /\(JSR \d+\)[*\s]*§[0-9.]+/g,
  /\bRFC \d+[,\s]+§[0-9.]+/g,
  /\bECMA-\d+[,\s]+§[0-9.]+/g,
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

// 코드블록(```...```), 인라인코드(`...`), spec 인용을 모두 마스킹한 뒤
// 본문 서술의 § 만 잡는다.
function findIllegalSection(content) {
  const masked = maskCodeAndSpec(content);
  const lines = masked.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('§')) {
      violations.push({ line: i + 1, content: lines[i].trim().slice(0, 120) });
    }
  }
  return violations;
}

function maskCodeAndSpec(content) {
  let masked = content;
  masked = masked.replace(/```[\s\S]*?```/g, m => '_'.repeat(m.length));
  masked = masked.replace(/`[^`\n]*?`/g, m => '_'.repeat(m.length));
  for (const pattern of SPEC_PATTERNS) {
    masked = masked.replace(pattern, m => '_'.repeat(m.length));
  }
  return masked;
}

// 한국어 본문에서 italic (*텍스트*) 사용 횟수 — bold (**...**) 와 코드는 제외
function countItalic(content) {
  const masked = maskCodeAndSpec(content);
  // **bold** 도 마스킹 — italic 만 잡기 위함
  const noBold = masked.replace(/\*\*[^*\n]+?\*\*/g, m => '_'.repeat(m.length));
  const matches = noBold.match(/(?<!\*)\*[^*\s\n][^*\n]*?[^*\s\n]\*(?!\*)/g);
  return matches ? matches.length : 0;
}

const ITALIC_THRESHOLD = 50;

const DEEP_DIVE_CHECKS_KO = [
  { name: 'TL;DR',                   pattern: /TL;?DR/i },
  { name: '0 번 절 (Cold Open)',     pattern: /^##\s+0\.\s+/m },
  { name: '왜 챕터',                 pattern: /^(##|###)\s+[\d\.]+\s+.*왜/m },
  { name: '측정 표 (베이스라인)',    pattern: /(baseline|S1|S2|S3|S4|S5|S6|시나리오)/i },
  { name: '자가진단',                pattern: /자가\s*진단|Self[\s-]?Check/i },
  { name: '의사결정 매트릭스',       pattern: /의사결정\s*매트릭스|Decision\s*Matrix/i },
  { name: '한계 섹션',               pattern: /^##\s+.*한계/m },
  { name: 'FAQ',                     pattern: /\bFAQ\b/ },
  { name: '참고자료 주제별 분리',    pattern: /^###\s+.*(공식|canonical|Canonical|보조|한국어|외부|패턴|설계|spec)/m },
];

const DEEP_DIVE_CHECKS_EN = [
  { name: 'TL;DR',                   pattern: /TL;?DR/i },
  { name: 'Cold Open (Section 0)',   pattern: /^##\s+0\.\s+/m },
  { name: 'Why chapter',             pattern: /^(##|###)\s+[\d\.]+\s+.*Why/m },
  { name: 'Measurement table',       pattern: /(baseline|S1|S2|S3|S4|S5|S6|scenario)/i },
  { name: 'Self-check',              pattern: /Self[\s-]?Check|Diagnos/i },
  { name: 'Decision matrix',         pattern: /Decision\s*Matrix/i },
  { name: 'Limitations',             pattern: /^##\s+.*Limit/im },
  { name: 'FAQ',                     pattern: /\bFAQ\b/ },
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
const anatomyWarnings = [];
const italicWarnings = [];
let blogFiles = 0;
let deepDiveCount = 0;

// 1) 블로그 글 검사 — 표기 룰 + (라벨 있으면) anatomy
for (const filepath of walk(BLOG_DIR)) {
  blogFiles++;
  const content = readFileSync(filepath, 'utf8');
  const fm = parseFrontmatter(content);
  const relPath = filepath.replace(ROOT + '/', '');
  const locale = filepath.includes('/en/') ? 'en' : 'ko';

  for (const v of findIllegalSection(content)) {
    errors.push(`${relPath}:${v.line}: § 사용 — ${v.content}`);
  }

  if (locale === 'ko') {
    const italicCount = countItalic(content);
    if (italicCount > ITALIC_THRESHOLD) {
      italicWarnings.push(`${relPath}: italic ${italicCount} 개`);
    }
  }

  if (fm.depth === 'deep-dive') {
    deepDiveCount++;
    const failed = checkAnatomy(content, locale);
    if (failed.length > 0) {
      anatomyWarnings.push(`${relPath} [deep-dive]: 누락 — ${failed.join(', ')}`);
    }
  }
}

// 2) AGENT.md 자체도 표기 룰 준수 검증
const agentContent = readFileSync(AGENT_MD, 'utf8');
for (const v of findIllegalSection(agentContent)) {
  errors.push(`AGENT.md:${v.line}: § 사용 — ${v.content}`);
}

console.log(`\n📚 검사: 블로그 ${blogFiles} 글 (deep-dive 라벨: ${deepDiveCount}) + AGENT.md`);

if (errors.length > 0) {
  console.error(`\n❌ 표기 룰 위반 (§ 기호) — ${errors.length} 건`);
  for (const e of errors) console.error(`  ${e}`);
  console.error(`\n   → 외부 spec (JLS / JSR / RFC / ECMA) 외에는 § 금지.`);
  console.error(`   → 변환 규칙: AGENT.md "표기 규칙 — 본문 안의 절 참조" 섹션.`);
}

if (anatomyWarnings.length > 0) {
  console.warn(`\n⚠️  Deep-Dive Anatomy 미흡 — ${anatomyWarnings.length} 글`);
  for (const w of anatomyWarnings) console.warn(`  ${w}`);
  console.warn(`   → AGENT.md "Deep-Dive Post Anatomy" 의 8 개 장치 참고.`);
}

if (italicWarnings.length > 0) {
  console.warn(`\n⚠️  한국어 본문 italic 과다 (>${ITALIC_THRESHOLD}) — ${italicWarnings.length} 글`);
  for (const w of italicWarnings) console.warn(`  ${w}`);
  console.warn(`   → 강조는 굵게/따옴표/백틱. AGENT.md "표기 규칙 — 한국어 본문 강조" 참고.`);
}

if (errors.length === 0 && anatomyWarnings.length === 0 && italicWarnings.length === 0) {
  console.log(`\n✅ 모든 검사 통과.`);
}

process.exit(errors.length > 0 ? 1 : 0);
