// Offline tests for the "see" Worker: a fake GitHub API in memory, real engine results as fixtures.
// Run: node worker/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { parseStart, buildPlan, describeAnimation } from './see.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name, seq) => ({ ...JSON.parse(fs.readFileSync(path.join(here, 'test-fixtures', name), 'utf8')), seq });

// ------------------------------------------------------------------------------------------------ fake GitHub
function fakeGitHub() {
  const gh = { branches: {}, commits: {}, trees: {}, dispatches: [], runs: [], deleted: [], n: 0 };
  const sha = () => (++gh.n).toString(16).padStart(40, '0');
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const files = (ref) => {
    const commit = gh.branches[ref] ? gh.commits[gh.branches[ref]] : gh.commits[ref];
    return commit ? gh.trees[commit.tree] : null;
  };
  gh.write = (branch, file, content) => {   // what the runner (or a contents PUT) does: one new commit
    const prev = gh.branches[branch] ? { ...files(branch) } : {};
    prev[file] = typeof content === 'string' ? content : JSON.stringify(content);
    const t = sha(); gh.trees[t] = prev;
    const c = sha(); gh.commits[c] = { tree: t };
    gh.branches[branch] = c;
  };
  gh.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const p = u.pathname.replace('/repos/o/r', '');
    let m;
    if (method === 'POST' && p === '/git/trees') { const t = sha(); gh.trees[t] = Object.fromEntries(body.tree.map((e) => [e.path, e.content])); return json({ sha: t }, 201); }
    if (method === 'POST' && p === '/git/commits') { const c = sha(); gh.commits[c] = { tree: body.tree }; return json({ sha: c }, 201); }
    if (method === 'POST' && p === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (gh.branches[name]) return json({ message: 'Reference already exists' }, 422);
      gh.branches[name] = body.sha; return json({ ref: body.ref }, 201);
    }
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) return gh.branches[m[1]] ? json({ object: { sha: gh.branches[m[1]] } }) : json({}, 404);
    if (method === 'GET' && (m = p.match(/^\/git\/matching-refs\/heads\/(.+)$/))) return json(Object.keys(gh.branches).filter((b) => b.startsWith(m[1])).map((b) => ({ ref: `refs/heads/${b}` })));
    if (method === 'DELETE' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) { delete gh.branches[m[1]]; gh.deleted.push(m[1]); return new Response(null, { status: 204 }); }
    if (method === 'POST' && p === '/actions/workflows/session.yml/dispatches') { gh.dispatches.push(body); return new Response(null, { status: 204 }); }
    if (method === 'GET' && p === '/actions/workflows/session.yml/runs') return json({ workflow_runs: gh.runs });
    if ((m = p.match(/^\/contents\/(.+)$/))) {
      const file = decodeURIComponent(m[1]);
      if (method === 'PUT') {
        if (files(body.branch)?.[file] !== undefined) return json({ message: 'exists' }, 422);
        gh.write(body.branch, file, Buffer.from(body.content, 'base64').toString());
        return json({}, 201);
      }
      const tree = files(u.searchParams.get('ref'));
      if (!tree) return json({}, 404);
      if (tree[file] !== undefined) return new Response(tree[file], { status: 200 });
      const listing = Object.keys(tree).filter((f) => f.startsWith(file + '/') && !f.slice(file.length + 1).includes('/')).map((f) => ({ name: f.slice(file.length + 1) }));
      return listing.length ? json(listing) : json({}, 404);
    }
    return json({ message: `fake GitHub: unhandled ${method} ${p}` }, 500);
  };
  return gh;
}

// ------------------------------------------------------------------------------------------------ harness
const gh = fakeGitHub();
globalThis.fetch = gh.fetch;
const env = { ACCESS_KEY: 'k3y', GH_TOKEN: 't', REPO: 'o/r', REF: 'main', GH_API: 'https://gh.test', HOLD_MS: '1200' };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const get = async (p) => {
  const t0 = Date.now();
  const res = await worker.fetch(new Request(`https://see.test${p}`), env, ctx);
  return { status: res.status, text: await res.text(), ms: Date.now() - t0, type: res.headers.get('content-type') };
};
const plain = (html) => html.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const links = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const pathOf = (u) => u.replace('https://see.test', '');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS  ${name}`); };

// ------------------------------------------------------------------------------------------------ tests
await test('wrong or missing key: plain 404, no hints', async () => {
  assert.equal((await get('/nope/https://example.org/')).status, 404);
  assert.equal((await get('/')).status, 404);
});

await test('help page at /<key>/', async () => {
  const r = await get('/k3y/');
  assert.equal(r.status, 200);
  assert.match(r.text, /https:\/\/see\.test\/k3y\/https:\/\/example\.org\//);
});

await test('parseStart: addresses, options, query strings, collapsed slashes', () => {
  assert.equal(parseStart('https://www.apple.com/airpods-pro/').target, 'https://www.apple.com/airpods-pro/');
  assert.equal(parseStart('https:/www.apple.com/airpods-pro/').target, 'https://www.apple.com/airpods-pro/');
  assert.equal(parseStart('apple.com/airpods-pro').target, 'https://apple.com/airpods-pro');
  assert.equal(parseStart('https://site.com/p?id=5&x=y').target, 'https://site.com/p?id=5&x=y');
  const o = parseStart('mobile,4g,reduced,safari/https://site.com/').opts;
  assert.deepEqual([o.device, o.network, o.reduced, o.browser], ['mobile', '4g', true, 'webkit']);
  assert.equal(parseStart('mobile/site.com').target, 'https://site.com/');
  const h = parseStart('hover=Get%20started/https://site.com/').opts.triggers[0];
  assert.deepEqual(h, { action: 'hover', text: 'Get started' });
  assert.match(parseStart('bogus/https://site.com/').error, /Unknown option/);
  assert.ok(parseStart('localhost').error);
  assert.ok(parseStart('javascript:alert(1)').error);
});

await test('plan: default report and options', () => {
  const plan = buildPlan(parseStart('https://site.com/').opts);
  assert.deepEqual(plan.map((p) => p.cmd.action), ['watch', 'observe', 'watch', 'livescroll']);
  assert.equal(plan[0].cmd.fresh, 1);
  const p2 = buildPlan(parseStart('4g,reduced,hover=Menu,still/https://site.com/').opts);
  assert.deepEqual(p2.map((p) => p.label), ['Page load with reduced motion', 'What is on screen (numbered)', 'Holding still for 4 seconds', 'hover "Menu"']);
  const p3 = buildPlan(parseStart('4g,reduced/https://site.com/').opts);
  assert.equal(p3[0].cmd.network, '4g');
  assert.equal(p3[1].cmd.reduced, 1);
});

let jobId, startPage;
await test('start: answers fast, creates the job branch, dispatches the session once', async () => {
  const r = await get('/k3y/https://www.apple.com/airpods-pro/');
  startPage = r;
  assert.equal(r.status, 200);
  assert.ok(r.ms < 1000, `took ${r.ms}ms`);
  assert.equal(gh.dispatches.length, 1);
  const d = gh.dispatches[0];
  jobId = d.inputs.id;
  assert.match(jobId, /^see-[a-z0-9]+-[a-f0-9]{8}$/);
  const cfg = JSON.parse(d.inputs.config);
  assert.deepEqual([cfg.url, cfg.browser, cfg.device, cfg.prescroll], ['https://www.apple.com/airpods-pro/', 'chrome', 'desktop', false]);
  const tree = gh.trees[gh.commits[gh.branches[`bs-${jobId}-cmd`]].tree];
  assert.deepEqual(Object.keys(tree).sort(), ['cmd/0001.json', 'cmd/0002.json', 'cmd/0003.json', 'cmd/0004.json', 'job.json']);
  assert.ok(links(r.text).includes(`https://see.test/k3y/j/${jobId}/1`));
});

await test('start: the same link again reuses the job (no second run)', async () => {
  const r = await get('/k3y/https://www.apple.com/airpods-pro/');
  assert.equal(gh.dispatches.length, 1);
  assert.match(r.text, /already/);
});

await test('start: "new," forces a fresh job', async () => {
  await get('/k3y/new/https://www.apple.com/airpods-pro/');
  assert.equal(gh.dispatches.length, 2);
  assert.notEqual(gh.dispatches[1].inputs.id, jobId);
});

await test('job page while the runner boots: says so, links to the next check, answers within the hold', async () => {
  const r = await get(`/k3y/j/${jobId}/1`);
  assert.equal(r.status, 200);
  assert.match(r.text, /still starting/);
  assert.ok(links(r.text).includes(`https://see.test/k3y/j/${jobId}/2`));
  assert.ok(r.ms < 2500, `took ${r.ms}ms`);
});

await test('job page shows results step by step, with image links, then action links', async () => {
  const out = `bs-${jobId}-out`;
  gh.write(out, 'status.json', { state: 'ready', lastSeq: 0 });
  gh.write(out, 'out/0000/result.json', fixture('observe.json', 0));
  gh.write(out, 'status.json', { state: 'ready', lastSeq: 1 });
  gh.write(out, 'out/0001/result.json', fixture('watch-load.json', 1));
  let r = await get(`/k3y/j/${jobId}/3`);
  assert.match(r.text, /Step 1: Page load, first visit/);
  assert.match(plain(r.text), /animation rise on h1#title "Motion fixture": 600ms ease-out, delay 200ms, starts \+0\.02s \| opacity 0 -> 1/);
  assert.ok(!links(r.text).some((l) => /\/hover\/\d+$/.test(l)), 'no element actions from before the reload in step 1');
  assert.ok(links(r.text).some((l) => /\/observe$/.test(l)), 'offers observe instead');
  assert.match(r.text, /First contentful paint|first contentful paint/);
  assert.ok(links(r.text).includes(`https://see.test/k3y/f/${jobId}/out/0001/filmstrip.jpg`));
  assert.match(r.text, /Step 2: What is on screen/);   // pending
  assert.ok(links(r.text).includes(`https://see.test/k3y/j/${jobId}/4`));
  // the rest of the plan
  gh.write(out, 'out/0002/result.json', fixture('observe.json', 2));
  const still = fixture('watch-load.json', 3);
  Object.assign(still.watch, { what: 'holding still', zero: 'recording start', load: null });
  gh.write(out, 'out/0003/result.json', still);
  gh.write(out, 'out/0004/result.json', fixture('livescroll.json', 4));
  gh.write(out, 'status.json', { state: 'ready', lastSeq: 4 });
  r = await get(`/k3y/j/${jobId}/4`);
  assert.doesNotMatch(r.text, /Still working/);
  assert.match(r.text, /Frame timing \(measured\)/);
  assert.ok(links(r.text).includes(`https://see.test/k3y/f/${jobId}/out/0004/sheet.jpg`));
  assert.ok(links(r.text).some((l) => l === `https://see.test/k3y/a/${jobId}/5/hover/1`), 'hover link for element 1');
  assert.ok(r.ms < 600, `a finished job should answer at once (took ${r.ms}ms)`);
});

await test('actions: queue once, same link twice is not run twice, a different link gets the next step', async () => {
  let r = await get(`/k3y/a/${jobId}/5/hover/1`);
  assert.match(r.text, /Queued as step 5: hover 1/);
  const tree = () => gh.trees[gh.commits[gh.branches[`bs-${jobId}-cmd`]].tree];
  assert.deepEqual(JSON.parse(tree()['cmd/0005.json']), { action: 'watch', ms: 2000, after: { action: 'hover', ref: 1 } });
  r = await get(`/k3y/a/${jobId}/5/hover/1`);
  assert.match(r.text, /already queued/);
  assert.equal(tree()['cmd/0006.json'], undefined);
  r = await get(`/k3y/a/${jobId}/5/inspect/1`);   // made from the same page as the hover link
  assert.match(r.text, /Queued as step 6: inspect 1/);
  assert.match(r.text, /2 follow-up action/);
  assert.equal((await get(`/k3y/a/${jobId}/7/hover/x`)).status, 400);
  assert.equal((await get(`/k3y/a/${jobId}/7/rm/1`)).status, 400);
});

await test('images are proxied with the right type; other paths are refused', async () => {
  gh.write(`bs-${jobId}-out`, 'out/0001/filmstrip.jpg', 'JPEGDATA');
  const r = await get(`/k3y/f/${jobId}/out/0001/filmstrip.jpg`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/jpeg');
  assert.equal(r.text, 'JPEGDATA');
  assert.equal((await get(`/k3y/f/${jobId}/out/../job.json`)).status, 404);
  assert.equal((await get(`/k3y/f/${jobId}/status.json`)).status, 404);
});

await test('ended session: results stay, a link to start again, actions explain', async () => {
  gh.write(`bs-${jobId}-out`, 'status.json', { state: 'ended', lastSeq: 4, reason: 'idle timeout' });
  let r = await get(`/k3y/j/${jobId}/9`);
  assert.match(r.text, /Session closed/);
  assert.ok(links(r.text).includes('https://see.test/k3y/new/https://www.apple.com/airpods-pro/'));
  r = await get(`/k3y/a/${jobId}/7/still/8`);
  assert.match(r.text, /has closed/);
});

await test('a run that failed to boot is reported', async () => {
  const id = gh.dispatches[1].inputs.id;   // the "new," job, never booted
  const jobFile = `bs-${id}-cmd`;
  const job = JSON.parse(gh.trees[gh.commits[gh.branches[jobFile]].tree]['job.json']);
  job.createdAt = new Date(Date.now() - 5 * 60000).toISOString();
  gh.write(jobFile, 'job.json', job);
  gh.runs.push({ display_title: id, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/1' });
  const r = await get(`/k3y/j/${id}/1`);
  assert.match(r.text, /ended \(failure\) before it was ready/);
});

await test('cleanup deletes only this tool\'s old job branches', async () => {
  const old = (Math.floor(Date.now() / 600000) - 100).toString(36);
  gh.branches[`bs-see-${old}-aaaaaaaa-cmd`] = gh.branches[`bs-${jobId}-cmd`];
  gh.branches['bs-wm-1-cmd'] = gh.branches[`bs-${jobId}-cmd`];
  await get('/k3y/new,mobile/https://example.org/');
  await Promise.all(waits);
  assert.ok(gh.deleted.includes(`bs-see-${old}-aaaaaaaa-cmd`));
  assert.ok(gh.branches['bs-wm-1-cmd'] && gh.branches[`bs-${jobId}-cmd`]);
});

await test('a bad GitHub token is explained', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('Bad credentials', { status: 401 });
  const r = await get('/k3y/new/https://example.org/');
  globalThis.fetch = saved;
  assert.equal(r.status, 500);
  assert.match(r.text, /token is missing, wrong or expired/);
});

await test('describeAnimation matches the client', () => {
  assert.equal(describeAnimation({ type: 'CSSAnimation', name: 'pulse', target: 'div.dot', duration: 1200, easing: 'ease-in-out', iterations: 'infinite',
    changes: [{ property: 'transform', from: 'scale(1)', to: 'scale(1)', values: ['scale(1)', 'scale(1.4)', 'scale(1)'] }] }),
  'animation pulse on div.dot: 1200ms ease-in-out, loops | transform scale(1) -> scale(1.4) -> scale(1)');
});

console.log(`\nall ${passed} worker tests passed`);
