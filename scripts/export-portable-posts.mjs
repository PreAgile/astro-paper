#!/usr/bin/env node
// Copies the Markdown versions of every post from dist/ into export/ for migration or cross-posting.
// Run after `bun run build`: bun run export:posts

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const EXPORT_DIR = join(ROOT, 'export');
const SOURCES = { ko: join(DIST, 'posts'), en: join(DIST, 'en', 'posts') };

if (!existsSync(DIST)) {
  process.stderr.write('dist/ 가 없습니다. 먼저 bun run build 를 실행하세요.\n');
  process.exit(1);
}

rmSync(EXPORT_DIR, { recursive: true, force: true });

for (const [locale, source] of Object.entries(SOURCES)) {
  const target = join(EXPORT_DIR, locale);
  mkdirSync(target, { recursive: true });
  const files = readdirSync(source).filter(file => file.endsWith('.md'));
  for (const file of files) cpSync(join(source, file), join(target, file));
  process.stdout.write(`${locale}: ${files.length} posts → ${target}\n`);
}
