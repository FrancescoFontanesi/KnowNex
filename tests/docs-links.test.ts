import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// Repository documents: their links and the source paths they name must survive moves.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
const documents = [
  'README.md',
  'AGENTS.md',
  ...walk('docs'),
  ...walk('skills'),
];

// GitHub-style heading anchor.
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
const anchors = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^#{1,6} +(.+)$/gm)].map((m) =>
    slug(m[1]!),
  );
// Fenced and inline code hold samples of workspace memory, not links of this repository.
const prose = (file: string) =>
  readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');

test('relative links in docs, README, AGENTS and skills reach existing files and headings', () => {
  const broken: string[] = [];
  for (const file of documents)
    for (const [, target] of prose(file)
      .replace(/`[^`\n]*`/g, '')
      .matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target!)) continue;
      const [path, anchor] = target!.split('#');
      const resolved = path ? resolve(dirname(file), decodeURI(path)) : file;
      if (!existsSync(resolved)) broken.push(`${file}: ${target}`);
      else if (anchor && resolved.endsWith('.md'))
        if (!anchors(resolved).includes(anchor))
          broken.push(`${file}: ${target} (anchor)`);
    }
  assert.deepEqual(broken, []);
});

test('source paths named in docs, README and AGENTS exist', () => {
  const missing: string[] = [];
  const folders = 'cli|hooks|feed|checkpoint|curation|memory|shared';
  for (const file of documents.filter((f) => !f.startsWith('skills')))
    for (const [, path] of prose(file).matchAll(
      new RegExp(
        '`((?:src/|tests/|\\.codex/hooks/)[\\w./-]+\\.(?:ts|cjs)|(?:' +
          folders +
          ')/[\\w-]+\\.ts)`',
        'g',
      ),
    )) {
      const full = /^(src|tests|\.codex)\//.test(path!) ? path! : 'src/' + path;
      if (!existsSync(full)) missing.push(`${file}: ${path}`);
    }
  assert.deepEqual(missing, []);
});
