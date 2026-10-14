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
import { pathToFileURL } from 'node:url';
import {
  ENGINES, DEVICE_PRESETS, slug, sleep, writeJson,
  extractMeta, extractLinks, extractImages, extractStyles, extractForms, preparePage,
} from './capture.mjs';
import { devices } from 'playwright';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);

const ID = process.env.SESSION_ID || '';
const REPO_DIR = path.resolve(process.env.REPO_DIR || '..');
const OUT_WT = path.resolve(process.env.OUT_WT || '/tmp/bridge-session-out');
const POLL_MS = Number(process.env.POLL_MS || 1000);
const CMD_BRANCH = `bs-${ID}-cmd`;
const OUT_BRANCH = `bs-${ID}-out`;

const cfg = { device: 'desktop', browser: 'chromium', detail: 2, idleMinutes: 10, maxMinutes: 30, hide: [], blockWrites: true, prescroll: true, ...JSON.parse(process.env.SESSION_CONFIG || '{}') };
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
  // cfg.cdp === false makes Chromium behave like WebKit/Firefox (no protocol access); used to test those paths.
  cdp = (cfg.browser === 'chromium' || cfg.browser === 'chrome') && cfg.cdp !== false ? await context.newCDPSession(page) : null;
  cfg.device = deviceName;
  if (url) {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await preparePage(page, { hide: cfg.hide, revealLazyContent: cfg.prescroll !== false, waitMs: 600 });
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
  box.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647';
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
  // Menus and dialogs opened as modals/popovers live in the browser's top layer, above any z-index.
  // Promoting the overlay to the top layer (shown last) puts the numbers above them too.
  if (typeof box.showPopover === 'function') {
    box.setAttribute('popover', 'manual');
    try { box.showPopover(); } catch {}
  }
};
const clearMarks = () => { const b = document.getElementById('__bridge_marks'); if (!b) return; try { b.hidePopover?.(); } catch {} b.remove(); };


const inspectElement = (target) => {
  // Size/tap target come from the interactive element; typography and color from the descendant that
  // renders most of its visible text (links and buttons often wrap the label in a styled span).
  const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim().length;
  let el = target, best = ownText(target);
  for (const d of target.querySelectorAll('*')) {
    const r = d.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const n = ownText(d);
    if (n > best) { best = n; el = d; }
  }
  const describe = (n) => n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
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
  const r = target.getBoundingClientRect();
  return {
    tag: target.tagName.toLowerCase(), text: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    typographyMeasuredOn: el === target ? 'the element itself' : `inner ${describe(el)}`,
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


// ---------------------------------------------------------------------------- live scroll (motion)
// Scrolls continuously with real input while recording frames and motion metrics, so problems that only
// exist in motion (flicker, jank, elements jumping, scroll snapping back, reveal animations misfiring)
// become visible. Chromium records a true frame stream (screencast); WebKit/Firefox fall back to
// screenshots between scroll steps (fewer frames, no layout-shift API).
async function liveScroll(c, dir, res) {
  if (c.fresh) {
    // Reload without the tool's lazy-load pre-scroll, so one-time scroll effects (reveals, banners,
    // sticky activations) happen during the recording, as they would for a first-time visitor.
    await page.reload({ waitUntil: 'load', timeout: 45000 });
    await preparePage(page, { hide: cfg.hide, revealLazyContent: false, waitMs: 800 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    res.fresh = true;
  }
  const vp = page.viewportSize();
  const { y0, maxY } = await page.evaluate(() => ({ y0: Math.round(scrollY), maxY: document.documentElement.scrollHeight - innerHeight }));
  let target;
  if (c.to === 'bottom') target = maxY;
  else if (c.to === 'top') target = 0;
  else if (c.to !== undefined) target = Number(c.to);
  else target = y0 + (Number(c.distance) || vp.height * 3);
  target = Math.max(0, Math.min(maxY, target));
  const speed = Math.max(100, Math.min(Number(c.speed) || 900, 6000));           // px per second
  const durationMs = Math.min(Math.abs(target - y0) / speed * 1000, 20000);
  const mode = c.mode || (touchEnabled && cdp ? 'touch' : 'wheel');
  const maxFrames = Math.min(Number(c.maxFrames) || 80, 200);

  // One clock for everything: milliseconds since this moment, measured on the page's own clock. Frames carry the
  // compositor's swap time (epoch-based, like performance.timeOrigin), so they line up with the in-page events.
  const zeroAt = await page.evaluate(() => {
    const m = (window.__bridgeMotion = { trace: [], shifts: [], longTasks: [], t0: performance.now(), stop: false });
    let last = performance.now();
    const loop = (t) => { m.trace.push([Math.round(t - m.t0), Math.round(t - last), Math.round(scrollY)]); last = t; if (!m.stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const desc = (n) => (n && n.nodeName ? n.nodeName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : null);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (m.stop) return;
          m.shifts.push({ t: Math.round(e.startTime - m.t0), value: +e.value.toFixed(4), sources: (e.sources || []).slice(0, 4).map((x) => ({ element: desc(x.node), fromY: x.previousRect ? Math.round(x.previousRect.y) : null, toY: x.currentRect ? Math.round(x.currentRect.y) : null, fromH: x.previousRect ? Math.round(x.previousRect.height) : null, toH: x.currentRect ? Math.round(x.currentRect.height) : null })) });
        }
      }).observe({ type: 'layout-shift', buffered: false });
    } catch {}
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!m.stop) m.longTasks.push({ t: Math.round(e.startTime - m.t0), ms: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: false }); } catch {}
    return performance.timeOrigin + m.t0;
  });

  const frames = [];
  const tStart = Date.now();
  let onFrame = null;
  if (cdp) {
    onFrame = async ({ data, metadata, sessionId }) => {
      frames.push({ data, t: Math.round((metadata.timestamp ? metadata.timestamp * 1000 : Date.now()) - zeroAt), y: Math.round(metadata.scrollOffsetY || 0) });
      try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: vp.width * (cfg.detail || 1), maxHeight: vp.height * (cfg.detail || 1), everyNthFrame: 1 });
  }
  const grab = async () => {
    if (cdp) return;
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, scale: 'css', animations: 'allow' });
    frames.push({ data: buf.toString('base64'), t: Date.now() - zeroAt, y: await page.evaluate(() => Math.round(scrollY)) });
  };

  const dir1 = target >= y0 ? 1 : -1;
  if (mode === 'touch' && cdp) {
    // Repeated finger drags; each releases with momentum, like a person flicking through a page.
    const strokes = Math.max(1, Math.ceil(Math.abs(target - y0) / (vp.height * 0.55)));
    const strokeMs = Math.max(120, Math.min(600, (vp.height * 0.55) / speed * 1000));
    for (let k = 0; k < strokes; k++) {
      const x = vp.width / 2, ya = dir1 > 0 ? vp.height * 0.78 : vp.height * 0.22, yb = dir1 > 0 ? vp.height * 0.23 : vp.height * 0.77;
      const steps = 10;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: ya }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: ya + (yb - ya) * i / steps }] });
        await sleep(strokeMs / steps);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(Number(c.pauseMs) || 150);
      if (Date.now() - tStart > 25000) break;
    }
  } else {
    // Mouse-wheel ticks at a steady rate (also the WebKit/Firefox path).
    const tick = cdp ? 16 : 120;
    const steps = Math.max(1, Math.round(durationMs / tick));
    const per = (target - y0) / steps;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, per);
      if (!cdp) await grab(); else await sleep(tick);
    }
  }
  const settle = Number(c.settleMs) || 1200;
  const settleEnd = Date.now() + settle;
  while (Date.now() < settleEnd) { if (!cdp) await grab(); await sleep(cdp ? 50 : 250); }
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    cdp.off('Page.screencastFrame', onFrame);
  }
  const m = await page.evaluate(() => { const x = window.__bridgeMotion; x.stop = true; return { trace: x.trace, shifts: x.shifts, longTasks: x.longTasks }; });

  // Keep an even sample if the stream is long (first and last always kept).
  let kept = frames;
  if (frames.length > maxFrames) kept = Array.from({ length: maxFrames }, (_, i) => frames[Math.round(i * (frames.length - 1) / (maxFrames - 1))]);
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
  res.frameFiles = [];
  for (const [i, f] of kept.entries()) {
    const name = path.join('frames', `${String(i + 1).padStart(3, '0')}_${String(f.t).padStart(5, '0')}ms_y${f.y}.jpg`);
    await fs.writeFile(path.join(dir, name), Buffer.from(f.data, 'base64'));
    res.frameFiles.push(name);
  }

  // Motion metrics from the in-page trace.
  const gaps = m.trace.slice(1).map((r) => r[1]).sort((a, b) => a - b);
  const pct = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null);
  const reversals = [];
  for (let i = 1; i < m.trace.length; i++) {
    const d = m.trace[i][2] - m.trace[i - 1][2];
    if (d * dir1 < -30) reversals.push({ t: m.trace[i][0], fromY: m.trace[i - 1][2], toY: m.trace[i][2] });
  }
  const motion = {
    mode, from: y0, to: target, reachedY: m.trace.length ? m.trace[m.trace.length - 1][2] : null,
    durationMs: Date.now() - tStart,
    frames: { streamed: frames.length, saved: kept.length, pageFrames: m.trace.length, source: cdp ? 'screencast (frames as Chromium paints them; it can skip some under load, compare with pageFrames)' : 'screenshots between steps' },
    clock: 'all times in ms since recording start, on the page clock (frames use the compositor swap time)',
    frameTiming: gaps.length ? { count: gaps.length, medianMs: pct(0.5), p95Ms: pct(0.95), worstMs: gaps[gaps.length - 1], over50ms: gaps.filter((g) => g > 50).length, note: 'requestAnimationFrame intervals; ~16.7ms = 60fps. Headless timing is indicative, not a device benchmark.' } : null,
    layoutShifts: { count: m.shifts.length, total: +m.shifts.reduce((a, b) => a + b.value, 0).toFixed(4), entries: m.shifts.slice(0, 30), note: cdp ? 'elements that moved on their own during the scroll (not the scroll itself)' : 'not available in this browser' },
    scrollReversals: reversals.slice(0, 20),
    longTasks: m.longTasks.slice(0, 20),
  };
  motion.scale = cfg.detail || 1;
  motion.viewport = vp;
  motion.frameMeta = kept.map((f, i) => ({ file: res.frameFiles[i], t: f.t, y: f.y }));
  await writeJson(path.join(dir, 'motion.json'), motion);
  res.files.push('motion.json');
  res.motion = { frames: motion.frames, frameTiming: motion.frameTiming, layoutShifts: { count: motion.layoutShifts.count, total: motion.layoutShifts.total }, scrollReversals: reversals.length, longTasks: m.longTasks.length, from: y0, to: target, reachedY: motion.reachedY, mode };

  // Contact sheet: up to 24 evenly spaced frames on one image, rendered by the browser itself.
  const n = Math.min(24, kept.length);
  if (n) {
    const pick = Array.from({ length: n }, (_, i) => kept[Math.round(i * (kept.length - 1) / Math.max(1, n - 1))]);
    const cols = vp.width < 600 ? 6 : 4;
    const w = Math.floor(1400 / cols) - 8;
    const html = `<html><body style="margin:0;background:#111;font:12px sans-serif;color:#eee"><div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:8px;padding:8px">` +
      pick.map((f) => `<figure style="margin:0"><img style="width:${w}px;display:block" src="data:image/jpeg;base64,${f.data}"><figcaption>${f.t} ms · y ${f.y}</figcaption></figure>`).join('') + '</div></body></html>';
    const sheetPage = await toolPage();
    try {
      await sheetPage.setContent(html, { waitUntil: 'load' });
      await sheetPage.screenshot({ path: path.join(dir, 'sheet.jpg'), type: 'jpeg', quality: 82, fullPage: true });
    } finally { await sheetPage.close().catch(() => {}); }
    res.files.push('sheet.jpg');
  }
}

// ---------------------------------------------------------------------------- watch (motion without scrolling)
// Records what the page does on its own or in response to one action: entrance animations on load, carousels,
// loops, hover transitions, menus opening. Two kinds of evidence, on one clock:
//   - the animations the browser itself reports (document.getAnimations(): element, properties, duration,
//     delay, easing, repeats), so motion is read, not guessed from pictures;
//   - the frames, reduced to the few where the picture changed, cropped to what moved, on one filmstrip.
// Motion made by scripts (GSAP, Lottie, canvas, video) isn't in the animation list; frames are the evidence there,
// and the result says how much of the visible change the animation list explains.

// In-page collector. Self-contained (it is also serialized into an init script for page-load recordings).
const watchCollector = (opts) => {
  if (window.top !== window) return false;   // page loads install this in every frame; only the top one records
  if (window.__bridgeWatch && !window.__bridgeWatch.stopped) return false;
  const W = (window.__bridgeWatch = { origin: performance.timeOrigin, t0: performance.now(), anims: [], shifts: [], longTasks: [], paints: {}, lcp: null, ticks: 0, stopped: false });
  // Animation start times are on the document timeline. Chromium's slow motion slows that timeline itself, so
  // convert from timeline time to real time using where the timeline stood when recording began.
  const tl0 = typeof document.timeline?.currentTime === 'number' ? document.timeline.currentTime : W.t0;
  const tlRate = opts.rateByProtocol ? Number(opts.rate) || 1 : 1;
  const started = (a) => (typeof a.startTime === 'number' ? Math.round((a.startTime - tl0) / tlRate + (tl0 - W.t0)) : null);
  const seen = new Map();
  W.seen = seen;
  const rate = Number(opts.rate) || 1;
  const desc = (n) => {
    if (!n || !n.nodeName) return null;
    let s = n.nodeName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return cls.length ? `${s}.${cls.join('.')}` : s;
  };
  const num = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 10) / 10 : String(v)) : v == null ? null : String(v));
  const box = (el) => { try { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; } catch { return null; } };
  const rel = () => Math.round(performance.now() - W.t0);
  // The element's first words, from its text nodes (not innerText, which forces a layout on every big animated
  // wrapper; not textContent, which includes script/noscript source).
  const textOf = (el) => {
    let out = '';
    try {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentNode?.nodeName || '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let n = walk.nextNode(); n && out.length < 60; n = walk.nextNode()) out += ' ' + n.nodeValue;
    } catch {}
    return out.trim().replace(/\s+/g, ' ').slice(0, 40) || null;
  };
  // Whether an element was on screen; off-screen animations run but nobody sees them.
  const onScreen = (b) => !!b && b[2] > 0 && b[3] > 0 && b[0] < innerWidth && b[1] < innerHeight && b[0] + b[2] > 0 && b[1] + b[3] > 0;
  W.desc = desc; W.box = box; W.rate = rate; W.onScreen = onScreen;
  const record = (a) => {
    let rec = seen.get(a);
    if (!rec) {
      if (W.anims.length >= 300) return;
      const e = a.effect || null;
      const tgt = e && e.target;
      let kf = [], timing = {};
      try { kf = e ? e.getKeyframes() : []; } catch {}
      try { timing = e ? e.getTiming() : {}; } catch {}
      const props = {};
      for (const k of kf) for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) (props[p] ||= []).push(k[p]);
      // CSS animations keep their timing function on the keyframes; transitions and Web Animations on the effect.
      const kfEasing = [...new Set(kf.slice(0, -1).map((k) => k.easing).filter((x) => x && x !== 'linear'))];
      const effEasing = timing.easing || 'linear';
      rec = {
        id: W.anims.length + 1,
        type: (a.constructor && a.constructor.name) || 'Animation',
        name: a.animationName || a.transitionProperty || a.id || null,
        target: (desc(tgt) || '?') + (e && e.pseudoElement ? e.pseudoElement : ''),
        text: tgt ? textOf(tgt) : null,
        startedAt: started(a),
        firstSeen: rel(), activeUntil: rel(),
        duration: num(timing.duration), delay: num(timing.delay), endDelay: num(timing.endDelay) || 0,
        iterations: timing.iterations === Infinity ? 'infinite' : num(timing.iterations),
        direction: timing.direction || null, fill: timing.fill || null,
        easing: effEasing !== 'linear' || !kfEasing.length ? effEasing : kfEasing.join(' | '),
        timeline: a.timeline && a.timeline.constructor ? a.timeline.constructor.name : null,
        // CSS property names (background-color, not backgroundColor); every keyframe value when there are a few
        // (a pulse is scale(1) -> scale(1.4) -> scale(1), not "scale(1) -> scale(1)").
        changes: Object.entries(props).slice(0, 8).map(([p, vs]) => ({
          property: p === 'cssFloat' ? 'float' : p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()),
          from: String(vs[0]).slice(0, 80), to: String(vs[vs.length - 1]).slice(0, 80), keyframes: vs.length,
          ...(vs.length > 2 ? { values: vs.slice(0, 6).map((v) => String(v).slice(0, 60)) } : {}),
        })),
        boxStart: tgt ? box(tgt) : null, boxEnd: null, playState: a.playState,
      };
      rec.visible = onScreen(rec.boxStart);
      seen.set(a, rec);
      W.anims.push(rec);
      if (rate !== 1 && !opts.rateByProtocol) {
        try { a.updatePlaybackRate(a.playbackRate * rate); rec.slowed = true; } catch { try { a.playbackRate *= rate; rec.slowed = true; } catch {} }
      }
    }
    // An animation may still be pending when first seen; its start time arrives on a later frame.
    if (rec.startedAt === null) rec.startedAt = started(a);
    if (a.playState === 'running') { rec.ran = true; rec.activeUntil = rel(); }
    rec.playState = a.playState;
  };
  const tick = () => {
    if (W.stopped) return;
    if (performance.now() - W.t0 > (Number(opts.maxMs) || 30000)) { W.stopped = true; return; }   // safety: never outlive the recording
    W.ticks++;
    try { for (const a of document.getAnimations()) record(a); } catch {}
    if (W.ticks % 6 === 0) for (const [a, r] of seen) if (a.playState === 'running' && a.effect && a.effect.target) { r.boxEnd = box(a.effect.target); if (onScreen(r.boxEnd)) r.visible = true; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const observe = (type, fn) => {
    try { new PerformanceObserver((list) => { if (!W.stopped) for (const e of list.getEntries()) fn(e); }).observe({ type, buffered: true }); } catch {}
  };
  observe('layout-shift', (e) => {
    if (e.startTime < W.t0 || W.shifts.length >= 40) return;
    W.shifts.push({ t: Math.round(e.startTime - W.t0), value: +e.value.toFixed(4), afterInput: e.hadRecentInput, sources: (e.sources || []).slice(0, 4).map((x) => ({ element: desc(x.node), fromY: x.previousRect ? Math.round(x.previousRect.y) : null, toY: x.currentRect ? Math.round(x.currentRect.y) : null, fromH: x.previousRect ? Math.round(x.previousRect.height) : null, toH: x.currentRect ? Math.round(x.currentRect.height) : null })) });
  });
  observe('longtask', (e) => { if (e.startTime >= W.t0 && W.longTasks.length < 40) W.longTasks.push({ t: Math.round(e.startTime - W.t0), ms: Math.round(e.duration) }); });
  W.fonts = [];
  try {
    document.fonts.addEventListener('loadingdone', (e) => {
      if (!W.stopped && W.fonts.length < 20) W.fonts.push({ t: rel(), families: [...new Set((e.fontfaces || []).map((f) => f.family.replace(/["']/g, '')))].slice(0, 6) });
    });
  } catch {}
  if (opts.load) {
    observe('paint', (e) => { W.paints[e.name] = Math.round(e.startTime); });
    observe('largest-contentful-paint', (e) => { W.lcp = { t: Math.round(e.startTime), element: desc(e.element), size: e.size }; });
  }
  return true;
};

// Stops the collector, puts slowed animations back to normal speed, and adds what the animation list can't see.
const watchCollect = () => {
  const W = window.__bridgeWatch;
  if (!W) return null;
  W.stopped = true;
  for (const [a, r] of W.seen) {
    if (a.effect && a.effect.target && a.playState === 'running') { r.boxEnd = W.box(a.effect.target); if (W.onScreen(r.boxEnd)) r.visible = true; }
    if (r.slowed) { try { a.updatePlaybackRate(a.playbackRate / W.rate); } catch { try { a.playbackRate /= W.rate; } catch {} } }
  }
  const vw = innerWidth, vh = innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null; };
  const libraries = [];
  const has = (name, test) => { try { if (test()) libraries.push(name); } catch {} };
  has('GSAP', () => window.gsap || window.TweenMax || window.TweenLite);
  has('GSAP ScrollTrigger', () => window.ScrollTrigger);
  has('Lottie', () => window.lottie || window.bodymovin || document.querySelector('lottie-player,dotlottie-player,dotlottie-wc'));
  has('Framer / Framer Motion', () => document.querySelector('[data-framer-appear-id],[data-framer-component-type],[data-projection-id]'));
  has('Webflow Interactions', () => document.querySelector('[data-w-id]'));
  has('Three.js', () => window.THREE || window.__THREE__);
  has('anime.js', () => window.anime);
  has('Rive', () => window.rive || document.querySelector('rive-canvas,canvas[data-rive]'));
  has('Lenis smooth scroll', () => window.Lenis || document.documentElement.classList.contains('lenis'));
  has('Locomotive Scroll', () => window.LocomotiveScroll || document.querySelector('[data-scroll-container]'));
  has('AOS', () => window.AOS || document.querySelector('[data-aos]'));
  has('Swiper', () => window.Swiper || document.querySelector('.swiper'));
  has('Splide', () => window.Splide || document.querySelector('.splide'));
  has('Slick', () => document.querySelector('.slick-slider'));
  const videos = [...document.querySelectorAll('video')].map((v) => ({
    element: W.desc(v), box: vis(v), paused: v.paused, muted: v.muted, loop: v.loop, autoplay: v.autoplay, controls: v.controls,
    currentTime: +v.currentTime.toFixed(2), duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
    readyState: v.readyState, poster: !!v.poster, resolution: [v.videoWidth, v.videoHeight], textTracks: v.textTracks ? v.textTracks.length : 0,
    src: (v.currentSrc || v.querySelector('source')?.src || '').replace(/^https?:\/\//, '').slice(0, 120) || null,
    type: v.querySelector('source')?.type || null,
  })).filter((v) => v.box).slice(0, 10);
  const canvases = [...document.querySelectorAll('canvas')].map((cv) => ({ element: W.desc(cv), box: vis(cv) })).filter((x) => x.box).slice(0, 10);
  const iframes = [...document.querySelectorAll('iframe')].map((f) => { let host = null; try { host = new URL(f.src, location.href).host; } catch {} return { host, box: vis(f) }; }).filter((x) => x.box).slice(0, 10);
  const gifs = [...document.querySelectorAll('img')].filter((i) => /\.gif(\?|#|$)/i.test(i.currentSrc || i.src || '') && vis(i)).map((i) => ({ element: W.desc(i), box: vis(i) })).slice(0, 10);
  // Animations that had already finished (and only hold their end state) or never ran aren't motion in this recording.
  const ran = W.anims.filter((r) => r.ran).sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));
  return {
    origin: W.origin, t0: W.t0, ticks: W.ticks,
    fonts: W.fonts,
    canPlayH264: (() => { try { return document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== ''; } catch { return null; } })(),
    animations: ran.map(({ ran: _r, slowed: _s, ...r }) => r), notRunning: W.anims.length - ran.length, shifts: W.shifts, longTasks: W.longTasks, paints: W.paints, lcp: W.lcp,
    load: performance.getEntriesByType('navigation').map((n) => ({ domContentLoaded: Math.round(n.domContentLoadedEventEnd), loadEvent: Math.round(n.loadEventEnd) }))[0] || null,
    media: { libraries, videos, canvases, iframes, gifs },
    scrollY: Math.round(scrollY), viewport: [vw, vh],
  };
};

// Runs in the tool page: decodes frames at thumbnail size and finds where the picture changed. Each cell of a
// coarse grid keeps its own reference image and reports a change only once it differs noticeably from it (then
// the reference moves on), like an event camera. Slow changes add up until they count, so the result doesn't
// depend on frame rate or speed; JPEG noise doesn't count (unchanged areas decode identically).
// State is kept on window so frames can arrive in chunks.
const diffChunk = async ({ frames, tw, cell, thr, reset }) => {
  if (reset || !window.__diff) window.__diff = { ref: null, dims: null, energy: null };
  const S = window.__diff;
  const out = [];
  for (const b64 of frames) {
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('frame could not be decoded')); img.src = 'data:image/jpeg;base64,' + b64; });
    if (!S.dims) {
      const th = Math.max(cell, Math.round(tw * img.naturalHeight / img.naturalWidth));
      S.dims = { w: tw, h: th, cols: Math.floor(tw / cell), rows: Math.floor(th / cell), cell, image: [img.naturalWidth, img.naturalHeight] };
      S.canvas = Object.assign(document.createElement('canvas'), { width: tw, height: th });
      S.ctx = S.canvas.getContext('2d', { willReadFrequently: true });
      S.energy = new Float64Array(S.dims.cols * S.dims.rows);
    }
    const { w, h, cols, rows } = S.dims;
    S.ctx.drawImage(img, 0, 0, w, h);
    const px = S.ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    if (!S.ref) { S.ref = g; out.push({ e: 0, cells: 0, box: null }); continue; }
    let e = 0, n = 0, c0 = cols, r0 = rows, c1 = -1, r1 = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let y = r * cell; y < (r + 1) * cell; y++) for (let x = c * cell; x < (c + 1) * cell; x++) sum += Math.abs(g[y * w + x] - S.ref[y * w + x]);
        const d = sum / (cell * cell);
        if (d <= thr) continue;
        e += d; n++; S.energy[r * cols + c] += d;
        for (let y = r * cell; y < (r + 1) * cell; y++) for (let x = c * cell; x < (c + 1) * cell; x++) S.ref[y * w + x] = g[y * w + x];
        if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
    }
    out.push({ e: +(e / (cols * rows)).toFixed(4), cells: n, box: n ? [c0, r0, c1 + 1, r1 + 1] : null });
  }
  return out;
};

// A clean page for rendering and analysis: no device emulation, no request blocking, CSS-pixel output.
let toolCtx = null;
async function toolPage() {
  if (!toolCtx) toolCtx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  return toolCtx.newPage();
}

// Frame recorder. Chromium streams frames as it paints them (screencast), each stamped with the compositor's swap
// time; WebKit and Firefox take screenshots in a loop (fewer frames). Long recordings are thinned evenly in memory.
async function startFrames({ quality = 70, maxKeep = 400 } = {}) {
  const vp = page.viewportSize();
  let frames = [], stride = 1, received = 0;
  const keep = (f) => {
    if (received++ % stride) return;
    frames.push(f);
    if (frames.length >= maxKeep) { frames = frames.filter((_, i) => i % 2 === 0); stride *= 2; }
  };
  if (cdp) {
    const onFrame = ({ data, metadata, sessionId }) => {
      keep({ data, at: metadata.timestamp ? metadata.timestamp * 1000 : Date.now(), y: Math.round(metadata.scrollOffsetY || 0) });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: Math.round(vp.width * (cfg.detail || 1)), maxHeight: Math.round(vp.height * (cfg.detail || 1)), everyNthFrame: 1 });
    return {
      source: 'screencast (frames as Chromium paints them)',
      stop: async () => { await cdp.send('Page.stopScreencast').catch(() => {}); cdp.off('Page.screencastFrame', onFrame); return { frames, stride, received }; },
    };
  }
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        // A screenshot can wait (for fonts, during navigation); stamp it when it's taken, not when it was asked for.
        const buf = await page.screenshot({ type: 'jpeg', quality, scale: 'css', animations: 'allow', timeout: 5000 });
        const at = Date.now();
        keep({ data: buf.toString('base64'), at, y: await page.evaluate(() => Math.round(scrollY)).catch(() => 0) });
      } catch { await sleep(50); }
    }
  })();
  return { source: 'screenshots in a loop; this browser has no frame stream', stop: async () => { running = false; await loop; return { frames, stride, received }; } };
}

async function analyzeFrames(frames) {
  if (!frames.length) return { series: [], dims: null, energy: [] };
  const tp = await toolPage();
  try {
    const series = [];
    for (let i = 0; i < frames.length; i += 12) {
      series.push(...await tp.evaluate(diffChunk, { frames: frames.slice(i, i + 12).map((f) => f.data), tw: 192, cell: 8, thr: 4, reset: i === 0 }));
    }
    const { dims, energy } = await tp.evaluate(() => ({ dims: window.__diff.dims, energy: Array.from(window.__diff.energy || []) }));
    return { series, dims, energy };
  } finally { await tp.close().catch(() => {}); }
}

// Keeps the frames worth looking at: the first and last, where motion starts and ends, the biggest single change
// (and the frame before it), then the rest spread over the moments when something changed: still stretches get
// no frames, busier moments get more, and one big change (an image arriving) can't starve a small one (a title
// fading in). Returns index -> label ('' for fill frames).
function pickFrames(series, budget, { stillMoving = false } = {}) {
  const n = series.length;
  const picks = new Map();
  const add = (i, why) => {
    if (i < 0 || i >= n) return false;
    if (picks.has(i)) { if (why && !picks.get(i).split(' · ').includes(why)) picks.set(i, picks.get(i) ? `${picks.get(i)} · ${why}` : why); return false; }
    picks.set(i, why);
    return true;
  };
  if (!n) return picks;
  add(0, 'first');
  const active = series.map((s, i) => (s.cells ? i : -1)).filter((i) => i >= 0);
  if (active.length) {
    const first = active[0], last = active[active.length - 1];
    add(first - 1, 'before motion');
    add(first, 'motion starts');
    let peak = first;
    for (const i of active) if (series[i].e > series[peak].e) peak = i;
    const sorted = active.map((i) => series[i].e).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    if (series[peak].e > 4 * median) add(peak - 1, 'just before biggest change');
    add(peak, 'biggest change');
    add(last, stillMoving ? 'still moving' : 'motion ends');
    // Fill: every changing frame weighs at least 1, busier ones up to 4.
    const weight = series.map((s) => (s.cells ? 1 + Math.min(3, s.e / median) : 0));
    const cum = [];
    let total = 0;
    for (const w of weight) { total += w; cum.push(total); }
    const free = budget - picks.size - 1;   // keep room for 'last'
    for (let k = 1; k <= free; k++) {
      const target = (total * k) / (free + 1);
      const i = cum.findIndex((c) => c >= target);
      if (i < 0 || add(i, '')) continue;
      // Taken: use the nearest changing frame that isn't.
      const alt = active.filter((j) => !picks.has(j)).sort((a, b) => Math.abs(a - i) - Math.abs(b - i))[0];
      if (alt !== undefined) add(alt, '');
    }
  }
  add(n - 1, 'last');
  return picks;
}

// The part of the screen that moved, in CSS pixels, or null when motion covers most of the screen.
function motionRegion(dims, energy, vp) {
  if (!dims || !energy.length) return null;
  const max = Math.max(...energy);
  if (!(max > 0)) return null;
  let c0 = dims.cols, r0 = dims.rows, c1 = -1, r1 = -1;
  energy.forEach((v, k) => {
    if (v < max * 0.05) return;
    const r = Math.floor(k / dims.cols), c = k % dims.cols;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  });
  const sx = (dims.cell * vp.width) / dims.w, sy = (dims.cell * vp.height) / dims.h;   // CSS px per cell
  const mx = Math.max(24, vp.width * 0.06), my = Math.max(24, vp.height * 0.06);
  let x = Math.max(0, c0 * sx - mx), y = Math.max(0, r0 * sy - my);
  let x1 = Math.min(vp.width, (c1 + 1) * sx + mx), y1 = Math.min(vp.height, (r1 + 1) * sy + my);
  if ((x1 - x) * (y1 - y) > vp.width * vp.height * 0.5) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x1 - x), h: Math.round(y1 - y) };
}

// How much of the visible change happened on elements the animation list knows about, inside media
// (video/canvas/iframes/GIFs), or elsewhere (script-driven styles, loading content, layout).
function explainChange(dims, energy, vp, collected) {
  if (!dims || !collected) return null;
  const total = energy.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const cellsOf = (boxes) => {
    const set = new Set();
    for (const b of boxes) {
      if (!b) continue;
      const [x, y, w, h] = b;
      const sx = (dims.cell * vp.width) / dims.w, sy = (dims.cell * vp.height) / dims.h;
      const c0 = Math.max(0, Math.floor(x / sx)), c1 = Math.min(dims.cols - 1, Math.floor((x + w) / sx));
      const r0 = Math.max(0, Math.floor(y / sy)), r1 = Math.min(dims.rows - 1, Math.floor((y + h) / sy));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set.add(r * dims.cols + c);
    }
    return set;
  };
  const anim = cellsOf(collected.animations.flatMap((a) => [a.boxStart, a.boxEnd]));
  const m = collected.media;
  const media = cellsOf([...m.videos, ...m.canvases, ...m.iframes, ...m.gifs].map((x) => x.box));
  let a = 0, md = 0;
  energy.forEach((v, k) => { if (anim.has(k)) a += v; else if (media.has(k)) md += v; });
  const pct = (v) => Math.round((v / total) * 100);
  return { animatedElements: pct(a), media: pct(md), elsewhere: 100 - pct(a) - pct(md) };
}

async function renderFilmstrip(file, { picks, region, vp, title, overview }) {
  const pad = 8;
  const r = region || { x: 0, y: 0, w: vp.width, h: vp.height };
  const aspect = r.w / r.h;
  let cols = aspect >= 2.5 ? 2 : aspect >= 1.2 ? 3 : aspect >= 0.7 ? 4 : 6;
  let cw = Math.floor((1400 - pad * (cols + 1)) / cols);
  const native = r.w * (cfg.detail || 1);   // don't enlarge a small region past the frame's own pixels
  if (cw > native) { cw = Math.max(160, Math.round(native)); cols = Math.min(8, Math.max(cols, Math.floor((1400 - pad) / (cw + pad)))); }
  const cellsTotal = picks.length + (region && overview ? 1 : 0);
  const fits = () => Math.ceil(cellsTotal / cols) * (Math.round(r.h * (cw / r.w)) + 30) + 40 <= 1500;
  while (!fits() && cols < 8) { cols++; cw = Math.min(cw, Math.floor((1400 - pad * (cols + 1)) / cols)); }
  while (!fits() && cw > 120) cw = Math.round(cw * 0.9);
  const s = cw / r.w, ch = Math.round(r.h * s);
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch_) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch_]));
  const cell = (data) => `<div class="c" style="width:${cw}px;height:${ch}px"><img src="data:image/jpeg;base64,${data}" style="width:${Math.round(vp.width * s)}px;left:${-Math.round(r.x * s)}px;top:${-Math.round(r.y * s)}px"></div>`;
  let ov = '';
  if (region && overview) {
    const os = cw / vp.width;
    ov = `<figure><div class="c" style="width:${cw}px;height:${Math.round(vp.height * os)}px"><img src="data:image/jpeg;base64,${overview}" style="width:${cw}px;left:0;top:0">` +
      `<div style="position:absolute;left:${Math.round(r.x * os)}px;top:${Math.round(r.y * os)}px;width:${Math.round(r.w * os)}px;height:${Math.round(r.h * os)}px;outline:2px solid #ff2d55"></div></div>` +
      `<figcaption>whole screen; the box is the area shown in each frame</figcaption></figure>`;
  }
  const width = cols * cw + (cols + 1) * pad;
  const html = '<!doctype html><html><head><style>body{margin:0;background:#111;color:#eee;font:13px/1.35 system-ui,sans-serif}' +
    `header{padding:8px ${pad}px;color:#ccc}.g{display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:${pad}px;padding:0 ${pad}px ${pad}px;align-items:start}` +
    'figure{margin:0}.c{position:relative;overflow:hidden;background:#000}.c img{position:absolute;max-width:none}' +
    'figcaption{padding:3px 2px 0;font-variant-numeric:tabular-nums}figcaption b{color:#ffcc00;font-weight:600}</style></head>' +
    `<body><header>${esc(title)}</header><div class="g">${ov}` +
    picks.map((p) => `<figure>${cell(p.data)}<figcaption>${esc(p.caption)}${p.why ? ` <b>${esc(p.why)}</b>` : ''}</figcaption></figure>`).join('') +
    '</div></body></html>';
  const tp = await toolPage();
  try {
    await tp.setViewportSize({ width: Math.max(480, width), height: 900 });
    await tp.setContent(html, { waitUntil: 'load' });
    await tp.screenshot({ path: file, type: 'jpeg', quality: 85, fullPage: true });
  } finally { await tp.close().catch(() => {}); }
}

// The one action a watch can record, performed at a point resolved beforehand (so the recording doesn't include
// scrolling the target into view, and doesn't wait for animations to finish the way locator.click does).
async function performTrigger(t, point) {
  switch (t.action) {
    case 'hover': await page.mouse.move(point.x, point.y, { steps: 2 }); break;
    case 'tap': if (touchEnabled) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y); break;
    case 'click': await page.mouse.click(point.x, point.y); break;
    case 'press': await page.keyboard.press(String(t.key || 'Enter')); break;
    case 'focus': await locatorFor(t).focus({ timeout: 5000 }); break;
    case 'swipe': await swipe(t); break;
    case 'scroll': {
      if (t.to !== undefined && t.to !== null) await page.evaluate((to) => scrollTo({ top: to === 'top' ? 0 : to === 'bottom' ? document.documentElement.scrollHeight : Number(to), behavior: 'instant' }), t.to);
      else { const vp = page.viewportSize(); await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, Number(t.dy) || Math.round(vp.height * 0.8)); }
      break;
    }
    default: throw new Error(`watch can record hover, tap, click, press, focus, swipe, or scroll; not "${t.action}"`);
  }
}

const NETWORK_PROFILES = {
  '4g': { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8 },   // Lighthouse's mobile throttling
  '3g': { latency: 300, downloadThroughput: 0.7e6 / 8, uploadThroughput: 0.35e6 / 8 },
};

async function watch(c, dir, res) {
  const vp = page.viewportSize();
  const on = (v) => v !== undefined && v !== null && v !== false && v !== 0 && v !== '0' && v !== 'false';
  const rate = on(c.slowmo) ? Math.min(1, Math.max(0.02, Number(c.slowmo) || 1)) : 1;
  const pageMs = Math.min(Math.max(Number(c.ms) || Number(c.seconds) * 1000 || 3000, 200), 20000);
  const realMs = Math.min(pageMs / rate, 20000);
  const fresh = on(c.fresh) || on(c.load);
  const trigger = c.after && typeof c.after === 'object' ? c.after : null;
  if (fresh && trigger) throw new Error('watch records either a page load (fresh=1 / load) or one action, not both');
  const budget = Math.min(Math.max(Number(c.max) || 12, 4), 24);
  const notes = [];
  const url = page.url();
  if (fresh && !/^(https?|file):/i.test(url)) throw new Error('watch load needs a page opened from a URL (this one was rendered or is blank)');

  // Get ready before recording, so the recording holds only what the action causes.
  let point = null;
  if (trigger) {
    await assertRef(trigger);
    if (['hover', 'tap', 'click'].includes(trigger.action)) {
      if (trigger.action === 'hover') await page.mouse.move(1, 1);   // start from "not hovering"
      point = await pointFor(trigger);
      if (!point) throw new Error(`watch ${trigger.action} needs a target: an element number from observe, text, or a selector`);
    }
    await sleep(350);
  }

  const restore = [];
  let rec = null, zero = null, collected = null, recording = null, init = null, source = null;
  try {
    // Conditions for this recording only.
    if (on(c.reduced)) { await page.emulateMedia({ reducedMotion: 'reduce' }); restore.push(() => page.emulateMedia({ reducedMotion: null })); }
    if (c.network || c.cpu) {
      if (!cdp) notes.push('network/cpu throttling needs Chromium; recorded without it');
      else {
        if (c.network) {
          const prof = NETWORK_PROFILES[String(c.network)];
          if (!prof) throw new Error(`network must be ${Object.keys(NETWORK_PROFILES).join(' or ')}`);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, ...prof });
          restore.push(async () => {
            await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await cdp.send('Network.disable').catch(() => {});
          });
        }
        if (c.cpu) {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: Math.min(Math.max(Number(c.cpu) || 1, 1), 20) });
          restore.push(() => cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }));
        }
      }
    }
    // Slow motion: Chromium slows every CSS/Web Animation on the page at once; other browsers (and page loads,
    // where the page's timeline is brand new) slow each animation as the collector first sees it.
    const byProtocol = rate !== 1 && !!cdp && !fresh;
    if (byProtocol) {
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
      restore.push(async () => { await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 }); await cdp.send('Animation.disable').catch(() => {}); });
    }
    const opts = { rate, rateByProtocol: byProtocol, maxMs: realMs + 5000, load: fresh };

    if (fresh) {
      // A first visit, as from a new tab: blank screen, then the page loading (HTTP cache cleared in Chromium;
      // cookies kept). The collector is installed before any of the page's own scripts run.
      if (cdp) { try { await cdp.send('Network.clearBrowserCache'); res.cacheCleared = true; } catch {} }
      await page.goto('about:blank');
      init = await page.addInitScript(watchCollector, opts);
      recording = await startFrames();
      source = recording.source;
      await sleep(150);
      await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
      await init.dispose().catch(() => {});
      init = null;
      zero = await page.evaluate(() => performance.timeOrigin);   // t = 0 at navigation start
    } else {
      recording = await startFrames();
      source = recording.source;
      await page.evaluate(watchCollector, opts);
      zero = Date.now();
      if (trigger) {
        await sleep(300);   // a little "before"
        zero = Date.now();   // t = 0 at the action
        await performTrigger(trigger, point);
      }
    }
    const end = zero + realMs;
    while (Date.now() < end) await sleep(Math.min(100, end - Date.now()));
    rec = await recording.stop();
    recording = null;
    try { collected = await page.evaluate(watchCollect); } catch {}
    if (!collected) notes.push('the page navigated during the recording, so the animation list was lost; frames still show what happened');
  } finally {
    if (recording) await recording.stop().catch(() => {});
    if (init) await init.dispose().catch(() => {});
    for (const f of restore.reverse()) await Promise.resolve().then(f).catch(() => {});
  }

  // Frames inside the window: from just before t = 0 (none before navigation start: that's the old page) to the end.
  const lead = fresh ? 0 : 400;
  let frames = rec.frames.map((f) => ({ ...f, t: Math.round(f.at - zero) })).filter((f) => f.t >= -lead && f.t <= realMs + 50);
  if (!frames.length && rec.frames.length) frames = [{ ...rec.frames[rec.frames.length - 1], t: 0 }];   // static page: the screen as it was
  const { series, dims, energy } = await analyzeFrames(frames);
  const scrolled = frames.some((f) => f.y !== frames[0].y);
  const region = on(c.crop ?? 1) && !scrolled ? motionRegion(dims, energy, vp) : null;

  // Times from the collector (its own start) and the page (navigation start) onto the recording clock.
  const fromCollector = (t) => (t === null || t === undefined || !collected ? null : Math.round(collected.origin + collected.t0 + t - zero));
  const fromOrigin = (t) => (t === null || t === undefined || !collected ? null : Math.round(collected.origin + t - zero));
  const animations = (collected?.animations || []).map((a) => ({ ...a, startedAt: fromCollector(a.startedAt), firstSeen: fromCollector(a.firstSeen), activeUntil: fromCollector(a.activeUntil) }));
  const shifts = (collected?.shifts || []).map((s) => ({ ...s, t: fromCollector(s.t) }));
  const longTasks = (collected?.longTasks || []).map((l) => ({ ...l, t: fromCollector(l.t) }));

  const sec = (t) => `${t < 0 ? '-' : '+'}${(Math.abs(t) / 1000).toFixed(2)}s`;
  const active = series.map((s, i) => (s.cells ? i : -1)).filter((i) => i >= 0);
  let peak = active[0];
  for (const i of active) if (series[i].e > series[peak].e) peak = i;
  const motion = active.length ? {
    startsAt: frames[active[0]].t, endsAt: frames[active[active.length - 1]].t,
    stillMovingAtEnd: frames[active[active.length - 1]].t > realMs - 300,
    biggestChangeAt: frames[peak].t,
  } : null;
  const picked = pickFrames(series, budget, { stillMoving: !!motion?.stillMovingAtEnd });
  if (motion?.stillMovingAtEnd) notes.push(animations.some((a) => a.iterations === 'infinite') ? 'still moving at the end: looping animation(s)' : 'still moving at the end: record longer to see where it settles');
  if (!cdp && frames.length) {   // screenshot loops can stall (while a page loads, for fonts); say where the pictures are missing
    let gap = { from: fresh ? 0 : frames[0].t, to: frames[0].t };
    for (let i = 1; i < frames.length; i++) if (frames[i].t - frames[i - 1].t > gap.to - gap.from) gap = { from: frames[i - 1].t, to: frames[i].t };
    if (gap.to - gap.from > 400) notes.push(`no frames between ${sec(gap.from)} and ${sec(gap.to)}: this browser's screenshots had to wait (e.g. while the page loaded), so that stretch isn't pictured; the animation list still covers it`);
  }
  if (rec.stride > 1) notes.push(`long recording: kept every ${rec.stride}th frame in memory`);
  if (scrolled) notes.push('the page scrolled during the recording, so frames are not cropped');
  if (rate !== 1) notes.push(`slow motion ${rate}x applies to CSS and Web Animations; script-driven motion (GSAP, canvas, video) ran at normal speed`);
  const explained = scrolled ? null : explainChange(dims, energy, vp, collected ? { ...collected, animations } : null);
  const offScreen = animations.filter((a) => !a.visible);
  if (offScreen.length) notes.push(`${offScreen.length} of ${animations.length} animation(s) ran off screen, where nobody sees them (${[...new Set(offScreen.map((a) => a.name).filter(Boolean))].slice(0, 5).join(', ')})`);
  const m = collected?.media;
  for (const v of m?.videos || []) {
    if (!v.paused || v.readyState > 1) continue;
    const codec = collected.canPlayH264 === false ? ` This browser can't play H.264 (MP4) video, which most sites use; a video that plays in Chrome or Safari may not play here. Start the session with --browser chrome (or webkit) to watch it.` : '';
    notes.push(`video ${v.element} isn't playing (paused, ${v.readyState === 0 ? 'no data loaded' : 'only metadata loaded'}${v.poster ? '; its poster image is what shows' : ''}).${codec}`);
  }
  if (m && (m.libraries.length || m.canvases.length || m.videos.length || m.gifs.length)) {
    const parts = [...m.libraries, m.videos.length && `${m.videos.length} video(s)`, m.canvases.length && `${m.canvases.length} canvas(es)`, m.gifs.length && `${m.gifs.length} GIF(s)`].filter(Boolean);
    notes.push(`motion the animation list can't describe may come from: ${parts.join(', ')}; frames are the evidence for those`);
  }

  // Captions: time relative to t = 0 (the action, navigation start, or recording start).
  const caption = (t) => (rate !== 1 ? `${sec(t)} (~${sec(t * rate).slice(1)} at normal speed)` : sec(t));
  const order = [...picked.keys()].sort((a, b) => a - b);
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
  res.frameFiles = [];
  const frameMeta = [];
  for (const i of order) {
    const f = frames[i];
    const name = path.join('frames', `${String(i + 1).padStart(3, '0')}_${f.t < 0 ? 'm' : ''}${String(Math.abs(f.t)).padStart(5, '0')}ms.jpg`);
    await fs.writeFile(path.join(dir, name), Buffer.from(f.data, 'base64'));
    res.frameFiles.push(name);
    frameMeta.push({ file: name, t: f.t, y: f.y, why: picked.get(i) || null });
  }
  const zeroIs = fresh ? 'navigation start' : trigger ? `the ${trigger.action}` : 'recording start';
  const what = fresh ? 'page load' : trigger ? `${trigger.action}${trigger.ref !== undefined ? ' ' + trigger.ref : trigger.text ? ` "${trigger.text}"` : trigger.key ? ' ' + trigger.key : ''}` : 'holding still';
  const conditions = [on(c.reduced) && 'reduced motion', c.network && `network ${c.network}`, c.cpu && `cpu ${c.cpu}x slower`, rate !== 1 && `slow motion ${rate}x`].filter(Boolean);
  if (order.length) {
    await renderFilmstrip(path.join(dir, 'filmstrip.jpg'), {
      picks: order.map((i) => ({ data: frames[i].data, caption: caption(frames[i].t), why: picked.get(i) })),
      region, vp, overview: frames[0].data,
      title: `watch: ${what} · ${(realMs / 1000).toFixed(1)}s real time · t=0 at ${zeroIs}${conditions.length ? ' · ' + conditions.join(', ') : ''} · ${order.length} of ${frames.length} frames${region ? ` · showing x${region.x} y${region.y} ${region.w}x${region.h}` : ''}`,
    });
    res.files.push('filmstrip.jpg');
  }

  const fonts = (collected?.fonts || []).map((f) => ({ ...f, t: fromCollector(f.t) }));
  const load = fresh && collected ? {
    firstPaint: collected.paints['first-paint'] ?? null, firstContentfulPaint: collected.paints['first-contentful-paint'] ?? null,
    largestContentfulPaint: collected.lcp ? { t: collected.lcp.t, element: collected.lcp.element } : null,
    domContentLoaded: collected.load?.domContentLoaded || null, loadEvent: collected.load?.loadEvent || null,
    webFontsLoaded: fonts,
    note: 'ms since navigation start; 0 / null = not reached within the recording',
  } : null;
  if (load) for (const k of ['firstPaint', 'firstContentfulPaint']) if (load[k] !== null) load[k] = fromOrigin(load[k]);
  if (load?.largestContentfulPaint) load.largestContentfulPaint.t = fromOrigin(load.largestContentfulPaint.t);

  const full = {
    what, zero: zeroIs, realMs, pageMs: Math.round(realMs * rate), slowmo: rate, conditions, url: page.url(), viewport: vp, scale: cfg.detail || 1,
    clock: 'ms relative to t = 0 on the page clock; frames use the compositor swap time',
    frames: { source, received: rec.received, inWindow: frames.length, picked: order.length, pageFrames: collected?.ticks ?? null, note: 'a screencast sends a frame only when something repaints, so a still page sends few' },
    motion, region, explained, animations, webFontsLoaded: fonts, animationsNotRunning: collected?.notRunning ?? null, layoutShifts: shifts, longTasks, load, media: m || null, notes,
    frameMeta, changeSeries: frames.map((f, i) => [f.t, series[i] ? series[i].e : 0]),
  };
  await writeJson(path.join(dir, 'watch.json'), full);
  res.files.push('watch.json');
  res.watch = {
    what, zero: zeroIs, realMs, slowmo: rate, conditions, frames: full.frames, motion, region, explained,
    animations: animations.slice(0, 15).map(({ boxStart, boxEnd, ...a }) => a), animationCount: animations.length, onScreen: animations.filter((a) => a.visible).length,
    webFontsLoaded: fonts,
    layoutShifts: shifts.length, layoutShiftTotal: +shifts.reduce((a, s) => a + s.value, 0).toFixed(4), longTasks: longTasks.length,
    load, media: m ? { libraries: m.libraries, videos: m.videos.length, canvases: m.canvases.length, iframes: m.iframes.map((f) => f.host), gifs: m.gifs.length } : null, notes,
  };
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
      case 'reset': {
        // prescroll=false reloads exactly as a first-time visitor sees it (one-time scroll effects not yet fired).
        await page.reload({ waitUntil: 'load', timeout: 45000 });
        await preparePage(page, { hide: cfg.hide, revealLazyContent: c.prescroll !== false && c.prescroll !== 0, waitMs: 600 });
        break;
      }
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
        // Absolute positions ("top", "bottom", or a pixel offset) jump instantly, ignoring CSS smooth scrolling.
        if (c.to !== undefined && c.to !== null) await page.evaluate((to) => scrollTo({ top: to === 'top' ? 0 : to === 'bottom' ? document.documentElement.scrollHeight : Number(to), behavior: 'instant' }), c.to);
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
      case 'livescroll': await liveScroll(c, dir, res); autoShot = true; break;
      case 'watch': await watch(c, dir, res); autoShot = false; break;
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
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(ID)) { console.error('SESSION_ID invalid'); process.exit(1); }
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

  try {
    browser = await launchBrowser();
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

// 'chrome' is Google Chrome (preinstalled on GitHub's Ubuntu runners): the same engine as Chromium, plus the
// proprietary codecs (H.264/AAC) most site videos use, which Playwright's own Chromium build doesn't have.
async function launchBrowser() {
  if (cfg.browser === 'chrome') return ENGINES.chromium.launch({ channel: 'chrome' });
  if (!ENGINES[cfg.browser]) throw new Error(`Unknown browser "${cfg.browser}" (chromium | chrome | webkit | firefox)`);
  return ENGINES[cfg.browser].launch(cfg.browser === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
}

// Local driver for tests and development: the same engine without the git channel.
// Results go to <outDir>/<seq>/ exactly as they would on the session's results branch.
export async function startLocal({ url, outDir, ...overrides }) {
  Object.assign(cfg, overrides);
  outDirFor = (seq) => path.join(outDir, String(seq).padStart(4, '0'));
  browser = await launchBrowser();
  await openContext(cfg.device, url);
  return { execute: (c) => (Array.isArray(c.actions) ? executeBatch(c) : execute(c)), page: () => page, close: () => browser.close() };
}

// Run the git-channel session only when executed directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(async (e) => {
    console.error(e);
    try { await publish('session crashed', { id: ID, state: 'failed', error: String(e.message || e).split('\n')[0], updatedAt: nowIso() }); } catch {}
    process.exit(1);
  });
}
