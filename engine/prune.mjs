// Removes result folders older than KEEP_DAYS (default 30) so the results branch stays small.
// Usage: node prune.mjs <resultsDir>
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] || 'results';
const keepDays = Number(process.env.KEEP_DAYS || 30);
if (!fs.existsSync(dir) || !(keepDays > 0)) process.exit(0);
const cutoff = Date.now() - keepDays * 86400000;
for (const name of fs.readdirSync(dir)) {
  const manifest = path.join(dir, name, 'manifest.json');
  try {
    const created = Date.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')).createdAt);
    if (created && created < cutoff) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      console.log(`pruned ${name}`);
    }
  } catch { /* folder without a readable manifest: leave it alone */ }
}
