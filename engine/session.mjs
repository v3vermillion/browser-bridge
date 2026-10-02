#!/usr/bin/env node
// browser-bridge live session runner.
// Keeps one browser open and executes commands as they arrive, so an AI can
// look -> decide -> act in seconds instead of starting a new run each time.
//
// Channel (all through git, because that's what AI sandboxes can reach):
//   commands: the client commits cmd/NNNN.json to branch  bs-<id>-cmd
//   results:  this runner commits out/NNNN/* + status.json to branch bs-<id>-out
//
// Env:
//   SESSION_ID      unique id (letters, numbers, . _ -)
//   SESSION_CONFIG  JSON: { url, device, browser, detail, idleMinutes, maxMinutes, hide, blockWrites }
//   REPO_DIR        path to a checkout of the repo with push access (default: cwd/..)
//   OUT_WT          worktree path for the results branch (default: /tmp/bridge-session-out)
//   POLL_MS         command poll interval (default 1000)
//   CHROMIUM_PATH   optional custom Chromium (local testing)

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  ENGINES, DEVICE_PRESETS, slug, sleep, writeJson,
  extractMeta, extractLinks, extractImages, extractStyles, extractForms, preparePage,
} from './capture.mjs';
import { devices } from 'playwright';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);

const ID = process.env.SESSION_ID || '';
if (!/^[A-Za-z0-9._-]{1,60}$/.test(ID)) { console.error('SESSION_ID invalid'); process.exit(1); }
const REPO_DIR = path.resolve(process.env.REPO_DIR || '..');
const OUT_WT = path.resolve(process.env.OUT_WT || '/tmp/bridge-session-out');
const POLL_MS = Number(process.env.POLL_MS || 1000);
const CMD_BRANCH = `bs-${ID}-cmd`;
const OUT_BRANCH = `bs-${ID}-out`;

const cfg = { device: 'desktop', browser: 'chromium', detail: 2, idleMinutes: 10, maxMinutes: 30, hide: [], blockWrites: true, ...JSON.parse(process.env.SESSION_CONFIG || '{}') };
cfg.maxMinutes = Math.min(Number(cfg.maxMinutes) || 30, 60);
cfg.idleMinutes = Math.min(Number(cfg.idleMinutes) || 10, cfg.maxMinutes);

const git = (args, cwd = REPO_DIR) => execFileP('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------- browser
let browser, context, page, cdp = null;
let touchEnabled = false;
const blocked = [];

function resolveDevice(name) {
  if (DEVICE_PRESETS[name]) return { name, ...DEVICE_PRESETS[name] };
  if (devices[name]) return { name: slug(name), ...devices[name] };
  throw new Error(`Unknown device "${name}". Use desktop | laptop | tablet | mobile | android or a Playwright device name.`);
}

async function openContext(deviceName, url) {
  if (context) await context.close().catch(() => {});
  const { name: _n, defaultBrowserType: _d, ...dev } = resolveDevice(deviceName);
  const opts = { ...dev, deviceScaleFactor: cfg.detail || 1, ignoreHTTPSErrors: true };
  if (cfg.browser === 'firefox') { delete opts.isMobile; delete opts.hasTouch; }
  touchEnabled = !!opts.hasTouch;
  context = await browser.newContext(opts);
  if (cfg.blockWrites) {
    await context.route('**/*', (route) => {
      const r = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return route.continue();
      if (blocked.length < 200) blocked.push({ method: r.method(), url: r.url().slice(0, 300) });
      return route.abort();
    });
  }
  page = await context.newPage();
  cdp = cfg.browser === 'chromium' ? await context.newCDPSession(page) : null;
  cfg.device = deviceName;
  if (url) {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await preparePage(page, { hide: cfg.hide, revealLazyContent: true, waitMs: 600 });
  }
}

// ---------------------------------------------------------------------------- in-page helpers
const mapElements = (maxCount) => {
  document.querySelectorAll('[data-bridge-ref]').forEach((e) => e.removeAttribute('data-bridge-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[onclick],[tabindex]:not([tabindex="-1"])';
  const vw = innerWidth, vh = innerHeight, out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    const covered = !!hit && !(el === hit || el.contains(hit) || hit.contains(el));
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.querySelector('img[alt]')?.alt || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 70);
    n += 1;
    el.setAttribute('data-bridge-ref', String(n));
    out.push({
      ref: n, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), name,
      href: el.getAttribute('href'), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], covered,
    });
    if (n >= maxCount) break;
  }
  return out;
};

const drawMarks = (els) => {
  const box = document.createElement('div');
  box.id = '__bridge_marks';
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const e of els) {
    const [x, y, w, h] = e.box;
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;outline:2px solid #ff2d55;outline-offset:-1px`;
    const t = document.createElement('div');
    t.textContent = e.ref;
    t.style.cssText = `position:absolute;left:${Math.max(0, x)}px;top:${Math.max(0, y - 14)}px;background:#ff2d55;color:#fff;font:bold 11px/14px sans-serif;padding:0 3px;border-radius:3px`;
    box.append(b, t);
  }
  document.documentElement.appendChild(box);
};
const clearMarks = () => document.getElementById('__bridge_marks')?.remove();


const inspectElement = (el) => {
  const cs = getComputedStyle(el);
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map((v) => parseFloat(v)); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let bg = null, overImage = false;
  for (let n = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.backgroundImage && s.backgroundImage !== 'none') { overImage = true; break; }
    const c = parse(s.backgroundColor);
    if (c && c.a > 0.5) { bg = c; break; }
  }
  if (!bg && !overImage) bg = { r: 255, g: 255, b: 255, a: 1 };
  const fg = parse(cs.color);
  const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  let contrast = null;
  if (fg && bg) { const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); contrast = +((a + 0.05) / (b + 0.05)).toFixed(2); }
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    box: { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    font: { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, transform: cs.textTransform },
    color: cs.color,
    background: overImage ? 'over an image or gradient (check visually; contrast not computed)' : `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
    contrast: contrast === null ? null : { ratio: contrast, wcagAA: contrast >= (large ? 3 : 4.5), wcagAAA: contrast >= (large ? 4.5 : 7), largeText: large, note: 'solid backgrounds only; ignores opacity/blend layers' },
    tapTarget: { w: Math.round(r.width), h: Math.round(r.height), meetsWcag22Min24px: r.width >= 24 && r.height >= 24 },
    spacing: { padding: cs.padding, margin: cs.margin, gap: cs.gap },
    shape: { borderRadius: cs.borderRadius, border: cs.border, boxShadow: cs.boxShadow },
  };
};

const pageState = () => ({ url: location.href, title: document.title, scrollY: Math.round(scrollY), scrollX: Math.round(scrollX), pageHeight: document.documentElement.scrollHeight, pageWidth: document.documentElement.scrollWidth, layoutViewport: [innerWidth, innerHeight] });

// ---------------------------------------------------------------------------- targeting + gestures
async function assertRef(c) {
  if (c.ref === undefined) return;
  const n = await page.locator(`[data-bridge-ref="${Number(c.ref)}"]`).count();
  if (!n) throw new Error(`Element ${c.ref} is not in the current map (page changed or never mapped). Run observe and use the new numbers.`);
}
function locatorFor(c) {
  if (c.ref !== undefined) return page.locator(`[data-bridge-ref="${Number(c.ref)}"]`).first();
  if (c.selector) return page.locator(c.selector).first();
  if (c.text) return page.getByText(c.text, { exact: false }).first();
  return null;
}
async function pointFor(c) {
  if (c.x !== undefined && c.y !== undefined) return { x: Number(c.x), y: Number(c.y) };
  const loc = locatorFor(c);
  if (!loc) return null;
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const b = await loc.boundingBox({ timeout: 5000 });
  if (!b) throw new Error('Target not visible (map may be stale: run observe again).');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function swipe(c) {
  const vp = page.viewportSize();
  const dir = String(c.direction || 'up').toLowerCase();
  const start = (await pointFor(c)) || { x: vp.width / 2, y: vp.height / 2 };
  const dist = Number(c.distance) || Math.round((dir === 'up' || dir === 'down' ? vp.height : vp.width) * 0.6);
  // Finger direction: "up" moves the finger up, which scrolls content down (as on a phone).
  const d = { up: [0, -dist], down: [0, dist], left: [-dist, 0], right: [dist, 0] }[dir];
  if (!d) throw new Error('direction must be up | down | left | right');
  const end = { x: Math.min(Math.max(start.x + d[0], 1), vp.width - 1), y: Math.min(Math.max(start.y + d[1], 1), vp.height - 1) };
  if (cdp) {
    const steps = 12;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / steps, y: start.y + (end.y - start.y) * i / steps }] });
      await sleep(Math.round((Number(c.durationMs) || 300) / steps));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return 'touch';
  }
  // WebKit / Firefox: no raw touch injection in Playwright; approximate with wheel scrolling at the start point.
  await page.mouse.move(start.x, start.y);
  await page.mouse.wheel(-(end.x - start.x), -(end.y - start.y));
  return 'wheel-fallback';
}

// ---------------------------------------------------------------------------- results
let outDirFor;
const shot = async (dir, name, opts = {}) => {
  const p = path.join(dir, name);
  await page.screenshot({ path: p, type: 'jpeg', quality: 80, scale: 'css', animations: 'disabled', ...opts });
  return name;
};

async function execute(c, dir = outDirFor(c.seq)) {
  await fs.mkdir(dir, { recursive: true });
  const res = { seq: c.seq, action: c.action, ok: true, files: [] };
  const t0 = Date.now();
  let autoShot = c.shot !== false;
  try {
    await assertRef(c);
    switch (c.action) {
      case 'observe': {
        const els = await page.evaluate(mapElements, Number(c.maxElements) || 60);
        res.elements = els;
        res.files.push(await shot(dir, 'shot.jpg'));
        if (c.marks !== false && els.length) {
          await page.evaluate(drawMarks, els);
          res.files.push(await shot(dir, 'marks.jpg'));
          await page.evaluate(clearMarks);
        }
        autoShot = false;
        break;
      }
      case 'goto': await page.goto(c.url, { waitUntil: 'load', timeout: 45000 }); await preparePage(page, { hide: cfg.hide, revealLazyContent: true, waitMs: 600 }); break;
      case 'back': await page.goBack({ waitUntil: 'load', timeout: 30000 }); break;
      case 'reset': await page.reload({ waitUntil: 'load', timeout: 45000 }); await preparePage(page, { hide: cfg.hide, revealLazyContent: true, waitMs: 600 }); break;
      case 'click': {
        const loc = locatorFor(c);
        if (loc) await loc.click({ timeout: Number(c.timeoutMs) || 8000 });
        else { const p = await pointFor(c); await page.mouse.click(p.x, p.y); }
        await sleep(Number(c.waitMs) || 700); break;
      }
      case 'tap': {
        const p = await pointFor(c);
        if (!p) throw new Error('tap needs ref, selector, text, or x/y');
        if (touchEnabled) await page.touchscreen.tap(p.x, p.y);
        else await page.mouse.click(p.x, p.y);
        await sleep(Number(c.waitMs) || 700); break;
      }
      case 'hover': { const p = await pointFor(c); await page.mouse.move(p.x, p.y); await sleep(Number(c.waitMs) || 500); break; }
      case 'type': case 'fill': {
        const loc = locatorFor(c);
        if (!loc) throw new Error('type needs ref, selector, or text');
        await loc.fill(String(c.value ?? c.textValue ?? ''), { timeout: 8000 });
        if (c.submit) await loc.press('Enter');
        await sleep(400); break;
      }
      case 'press': await page.keyboard.press(String(c.key || 'Enter')); await sleep(Number(c.waitMs) || 300); break;
      case 'scroll': {
        if (c.to === 'top' || c.to === 'bottom') await page.evaluate((to) => scrollTo(0, to === 'top' ? 0 : document.documentElement.scrollHeight), c.to);
        else if (c.ref !== undefined || c.selector || c.text) await locatorFor(c).scrollIntoViewIfNeeded({ timeout: 5000 });
        else { const vp = page.viewportSize(); await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, Number(c.dy) || Math.round(vp.height * 0.8)); }
        await sleep(Number(c.waitMs) || 600); break;
      }
      case 'swipe': res.method = await swipe(c); await sleep(Number(c.waitMs) || 700); break;
      case 'zoom': {
        const name = 'zoom.jpg';
        const loc = locatorFor(c);
        const opts = { path: path.join(dir, name), type: 'jpeg', quality: 90, scale: 'device', animations: 'disabled' };
        if (loc) await loc.screenshot(opts);
        else if (c.clip) await page.screenshot({ ...opts, clip: c.clip });
        else throw new Error('zoom needs ref, selector, text, or clip {x,y,width,height}');
        res.files.push(name); autoShot = false; break;
      }
      case 'inspect': {
        const loc = locatorFor(c);
        if (!loc) throw new Error('inspect needs ref, selector, or text');
        res.inspect = await loc.evaluate(inspectElement);
        // Picture from the same instant: styles can change with scroll position, hover, or "current" states.
        try { await loc.screenshot({ path: path.join(dir, 'element.jpg'), type: 'jpeg', quality: 90, scale: 'device', animations: 'disabled' }); res.files.push('element.jpg'); } catch {}
        autoShot = false; break;
      }
      case 'fullpage': res.files.push(await shot(dir, 'full.jpg', { fullPage: true })); autoShot = false; break;
      case 'frames': {
        const count = Math.min(Number(c.count) || 6, 20);
        const vp = page.viewportSize();
        await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
        for (let i = 0; i < count; i++) {
          res.files.push(path.join('frames', await shot(path.join(dir, 'frames'), `${String(i + 1).padStart(2, '0')}.jpg`, { animations: 'allow' })));
          if (c.dy !== 0) { await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, Number(c.dy) || Math.round(vp.height * 0.5)); }
          await sleep(Number(c.intervalMs) || 350);
        }
        autoShot = false; break;
      }
      case 'inject': {
        const applied = await page.evaluate((spec) => {
          let n = 0;
          if (spec.css) { const s = document.createElement('style'); s.setAttribute('data-bridge-inject', ''); s.textContent = spec.css; document.head.appendChild(s); n++; }
          for (const h of spec.hide || []) document.querySelectorAll(h).forEach((el) => { el.style.setProperty('display', 'none', 'important'); n++; });
          for (const r of spec.remove || []) document.querySelectorAll(r).forEach((el) => { el.remove(); n++; });
          for (const t of spec.text || []) document.querySelectorAll(t.selector).forEach((el) => { el.textContent = t.text; n++; });
          for (const h of spec.html || []) document.querySelectorAll(h.selector).forEach((el) => {
            const pos = h.position || 'inner';
            if (pos === 'inner') el.innerHTML = h.html;
            else if (pos === 'replace') el.outerHTML = h.html;
            else el.insertAdjacentHTML(pos === 'before' ? 'beforebegin' : 'afterend', h.html);
            n++;
          });
          return n;
        }, { css: c.css, hide: c.hide, remove: c.remove, text: c.text, html: c.html });
        res.applied = applied;
        await sleep(Number(c.waitMs) || 500); break;
      }
      case 'render': {
        if (!c.html) throw new Error('render needs html');
        await page.setContent(String(c.html), { waitUntil: 'load', timeout: 30000 });
        await preparePage(page, { revealLazyContent: true, waitMs: 500 }); break;
      }
      case 'analyze': {
        const what = c.what || ['meta', 'styles', 'images'];
        const data = {};
        if (what.includes('meta')) data.meta = await page.evaluate(extractMeta);
        if (what.includes('styles')) data.styles = await page.evaluate(extractStyles);
        if (what.includes('images')) data.images = await page.evaluate(extractImages);
        if (what.includes('links')) data.links = await page.evaluate(extractLinks);
        if (what.includes('forms')) data.forms = await page.evaluate(extractForms);
        if (what.includes('a11y')) {
          await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
          const r = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
          data.a11y = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, examples: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
        }
        await writeJson(path.join(dir, 'data.json'), data);
        res.files.push('data.json'); autoShot = false; break;
      }
      case 'device': {
        const url = page.url();
        await openContext(String(c.name || 'desktop'), url);
        res.device = cfg.device; break;
      }
      case 'wait': if (c.selector) await page.waitForSelector(c.selector, { timeout: Number(c.ms) || 10000 }); else await sleep(Number(c.ms) || 1000); break;
      case 'evaluate': res.value = await page.evaluate(c.script); break;
      case 'end': autoShot = false; break;
      default: throw new Error(`Unknown action "${c.action}"`);
    }
  } catch (e) {
    res.ok = false;
    res.error = String(e.message || e).split('\n')[0];
  }
  try {
    if (autoShot) res.files.push(await shot(dir, 'shot.jpg'));
    Object.assign(res, await page.evaluate(pageState));
    const vp = page.viewportSize();
    res.viewport = [vp.width, vp.height];
    if (res.pageWidth > vp.width + 2) res.horizontalOverflow = res.pageWidth - vp.width;
  } catch (e) { res.stateError = String(e.message || e).split('\n')[0]; }
  if (blocked.length) res.blockedWrites = blocked.length;
  res.device = cfg.device;
  res.ms = Date.now() - t0;
  await writeJson(path.join(dir, 'result.json'), res);
  return res;
}

// A batch is several actions sent in one command: one round trip instead of several.
// Stops at the first failure unless {"continueOnError": true}, since later steps usually depend on earlier ones.
async function executeBatch(c) {
  const dir = outDirFor(c.seq);
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const [k, sub] of c.actions.entries()) {
    const r = await execute({ ...sub, seq: `${c.seq}.${k + 1}` }, path.join(dir, String(k + 1)));
    results.push(r);
    if (!r.ok && !c.continueOnError) break;
  }
  const res = { seq: c.seq, action: 'batch', ok: results.every((r) => r.ok), steps: results.length, of: c.actions.length, results };
  await writeJson(path.join(dir, 'result.json'), res);
  return res;
}

// ---------------------------------------------------------------------------- git channel
async function remoteSha(branch) {
  try {
    const { stdout } = await git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    return stdout.split('\t')[0].trim() || null;
  } catch { return null; }
}
async function publish(message, status) {
  await writeJson(path.join(OUT_WT, 'status.json'), status);
  await git(['add', '-A', '.'], OUT_WT);
  await git(['commit', '-q', '-m', message], OUT_WT).catch(() => {});
  for (let i = 0; i < 3; i++) {
    try { await git(['push', '-q', 'origin', `HEAD:refs/heads/${OUT_BRANCH}`], OUT_WT); return; }
    catch (e) { if (i === 2) throw e; await sleep(1000); }
  }
}

async function main() {
  const started = Date.now();
  const endsAt = new Date(started + cfg.maxMinutes * 60000).toISOString();
  await fs.rm(OUT_WT, { recursive: true, force: true });
  await git(['worktree', 'add', '--detach', OUT_WT]);
  await git(['checkout', '-q', '--orphan', OUT_BRANCH], OUT_WT);
  await git(['rm', '-rfq', '.'], OUT_WT).catch(() => {});
  await git(['clean', '-fdxq'], OUT_WT);
  outDirFor = (seq) => path.join(OUT_WT, 'out', String(seq).padStart(4, '0'));
  try {
    await git(['fetch', '-q', 'origin', `+refs/heads/${CMD_BRANCH}:refs/bridge/${CMD_BRANCH}`]);
    const { stdout } = await git(['show', `refs/bridge/${CMD_BRANCH}:brief.md`]);
    await fs.writeFile(path.join(OUT_WT, 'brief.md'), stdout);
  } catch { /* no brief supplied (client used --no-brief) */ }
  const status = { id: ID, state: 'starting', config: cfg, startedAt: new Date(started).toISOString(), endsAt, lastSeq: -1, updatedAt: nowIso() };
  await publish('session starting', status);

  const launchOpts = cfg.browser === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {};
  try {
    if (!ENGINES[cfg.browser]) throw new Error(`Unknown browser "${cfg.browser}"`);
    browser = await ENGINES[cfg.browser].launch(launchOpts);
    await openContext(cfg.device, cfg.url);
  } catch (e) {
    await publish('session failed', { ...status, state: 'failed', error: String(e.message || e).split('\n')[0], updatedAt: nowIso() });
    process.exit(1);
  }

  // Initial observation (seq 0) so the first look arrives with "ready".
  const first = await execute({ seq: 0, action: 'observe' });
  Object.assign(status, { state: 'ready', lastSeq: 0, url: first.url, updatedAt: nowIso() });
  await publish('ready', status);
  console.log(`session ${ID} ready (${cfg.browser}/${cfg.device}) - ${first.url}`);

  const done = new Set([0]);
  let lastSha = null, lastActivity = Date.now(), reason = null;
  while (!reason) {
    if (Date.now() - lastActivity > cfg.idleMinutes * 60000) reason = 'idle timeout';
    else if (Date.now() - started > cfg.maxMinutes * 60000) reason = 'max duration reached';
    if (reason) break;
    const sha = await remoteSha(CMD_BRANCH);
    if (sha && sha !== lastSha) {
      lastSha = sha;
      await git(['fetch', '-q', 'origin', `+refs/heads/${CMD_BRANCH}:refs/bridge/${CMD_BRANCH}`]);
      const { stdout } = await git(['ls-tree', '--name-only', `refs/bridge/${CMD_BRANCH}`, 'cmd/']).catch(() => ({ stdout: '' }));
      const seqs = stdout.split('\n').map((f) => f.match(/cmd\/(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1])).filter((n) => !done.has(n)).sort((a, b) => a - b);
      for (const seq of seqs) {
        let cmd;
        try { cmd = JSON.parse((await git(['show', `refs/bridge/${CMD_BRANCH}:cmd/${String(seq).padStart(4, '0')}.json`])).stdout); }
        catch (e) { cmd = { action: 'invalid', parseError: String(e.message) }; }
        cmd.seq = seq;
        done.add(seq);
        lastActivity = Date.now();
        const res = Array.isArray(cmd.actions) ? await executeBatch(cmd) : await execute(cmd);
        const last = res.results ? res.results[res.results.length - 1] || {} : res;
        Object.assign(status, { lastSeq: seq, url: last.url, updatedAt: nowIso() });
        if (cmd.action === 'end' || (cmd.actions || []).some((a) => a.action === 'end')) reason = 'ended by client';
        await publish(`seq ${seq}: ${res.action}`, status);
        console.log(`seq ${seq} ${res.action} ${res.ok ? 'ok' : 'error: ' + (res.error || 'a step failed')}`);
        if (reason) break;
      }
    }
    await sleep(Date.now() - lastActivity > 120000 ? POLL_MS * 2 : POLL_MS);
  }
  Object.assign(status, { state: 'ended', reason, updatedAt: nowIso() });
  await publish(`ended: ${reason}`, status);
  await browser.close().catch(() => {});
  console.log(`session ${ID} ended: ${reason}`);
}

main().catch(async (e) => {
  console.error(e);
  try { await publish('session crashed', { id: ID, state: 'failed', error: String(e.message || e).split('\n')[0], updatedAt: nowIso() }); } catch {}
  process.exit(1);
});
