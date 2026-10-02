// Decides which Playwright browsers the workflow must install for this job.
// Writes `browsers=<space separated list>` to $GITHUB_OUTPUT (or stdout locally).
import fs from 'node:fs';
let browsers = ['chromium'];
try {
  const job = JSON.parse(process.env.JOB_JSON || '{}');
  if (Array.isArray(job.browsers) && job.browsers.length) {
    browsers = [...new Set(job.browsers.filter((b) => ['chromium', 'webkit', 'firefox'].includes(b)))];
    if (!browsers.length) browsers = ['chromium'];
  }
} catch { /* invalid JSON: capture.mjs will report it; install chromium so the run can finish cleanly */ }
const line = `browsers=${browsers.join(' ')}\n`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
