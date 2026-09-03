/**
 * Split a migration into chunks small enough to paste into the Supabase SQL
 * editor, which silently truncates large pastes.
 *
 * The important part is that it is dollar-quote aware. A naive split on ';'
 * would cut straight through a plpgsql function body — every `;` inside
 * `as $$ ... $$` is part of the body, not a statement terminator. That is
 * exactly the failure being worked around, so reproducing it here would be
 * embarrassing.
 *
 * Usage: node scripts/split-migration.mjs supabase/migrations/0006_naira.sql [maxBytes]
 */

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const MAX = Number(process.argv[3] || 6000);
if (!file) {
  console.error('usage: node scripts/split-migration.mjs <file.sql> [maxBytes]');
  process.exit(1);
}

const sql = fs.readFileSync(file, 'utf8');

/**
 * Walk the text and cut only at top-level `;` — that is, semicolons which are
 * not inside a $$...$$ body, a '...' literal, or a -- comment.
 */
function splitStatements(text) {
  const out = [];
  let start = 0;
  let inDollar = false;
  let inSingle = false;
  let inLineComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next2 = text.slice(i, i + 2);

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;   // '' escapes handled by re-entry
      continue;
    }
    if (inDollar) {
      if (next2 === '$$') { inDollar = false; i++; }
      continue;
    }

    if (next2 === '--') { inLineComment = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (next2 === '$$') { inDollar = true; i++; continue; }

    if (c === ';') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.map((s) => s.replace(/^\n+/, '')).filter((s) => s.trim());
}

const statements = splitStatements(sql);

// Group statements into chunks under the size limit, never splitting one.
const chunks = [];
let current = [];
let size = 0;
for (const st of statements) {
  if (size + st.length > MAX && current.length) {
    chunks.push(current);
    current = [];
    size = 0;
  }
  current.push(st);
  size += st.length;
}
if (current.length) chunks.push(current);

const dir = path.join(path.dirname(file), 'parts');
fs.mkdirSync(dir, { recursive: true });

const base = path.basename(file, '.sql');
const written = [];
chunks.forEach((group, i) => {
  const n = String(i + 1).padStart(2, '0');
  const name = `${base}.part${n}.sql`;
  const header =
    `-- ${base} — part ${i + 1} of ${chunks.length}\n` +
    `-- Run the parts IN ORDER. Each is a whole number of statements, so no\n` +
    `-- function body is ever cut in half.\n\n`;
  const body = header + group.join('\n\n').trim() + '\n';
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
  written.push({ name, bytes: Buffer.byteLength(body), statements: group.length });
});

// Sanity: every part must have balanced $$ pairs, or we have recreated the bug.
let bad = 0;
for (const w of written) {
  const text = fs.readFileSync(path.join(dir, w.name), 'utf8');
  const count = (text.match(/\$\$/g) || []).length;
  const balanced = count % 2 === 0;
  if (!balanced) bad++;
  console.log(
    `  ${w.name.padEnd(30)} ${String(w.bytes).padStart(6)} bytes  ` +
    `${String(w.statements).padStart(2)} stmts  ${count} $$ ${balanced ? 'balanced' : 'UNBALANCED'}`,
  );
}

console.log(`\n${written.length} parts written to ${dir}`);
if (bad) {
  console.error(`${bad} part(s) have unbalanced dollar quotes — do not run these.`);
  process.exit(1);
}
