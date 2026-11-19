// Move the pinned @plune-ai/cli version to a new release: node scripts/bump-cli.mjs 0.39.4
//
// Run by .github/workflows/cli-bump.yml. Every edit names how many times the old text must appear,
// so a pin that moved or changed shape stops the run instead of leaving one file behind.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const next = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`usage: bump-cli.mjs X.Y.Z (got "${next}")`);

const prev = /plune-version:[\s\S]*?default: '(\d+\.\d+\.\d+)'/.exec(readFileSync('action.yml', 'utf8'))?.[1];
if (!prev) throw new Error('action.yml: no plune-version default found');
if (prev === next) throw new Error(`already on ${next}`);

function swap(file, from, to, want) {
  const parts = readFileSync(file, 'utf8').split(from);
  if (parts.length - 1 !== want) throw new Error(`${file}: expected ${want} × ${from}, found ${parts.length - 1}`);
  writeFileSync(file, parts.join(to));
}

swap('action.yml', `default: '${prev}'`, `default: '${next}'`, 1);
swap('mcp/action.yml', `default: '${prev}'`, `default: '${next}'`, 1);
swap('README.md', `| \`plune-version\` | \`${prev}\` |`, `| \`plune-version\` | \`${next}\` |`, 2);

// Anything else still naming the old version is for a person to judge (it may be history).
let left = '';
try {
  left = execFileSync('git', ['grep', '-nF', prev, '--', '.', ':!CHANGELOG*'], { encoding: 'utf8' });
} catch {
  // git grep exits 1 when nothing matches
}
if (left) console.log(`::warning::${prev} is still mentioned outside the pins, see the log\n${left}`);
console.log(`@plune-ai/cli ${prev} -> ${next}`);
