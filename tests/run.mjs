// End-to-end checks in a real Chrome, with the extension loaded unpacked into a throwaway profile.
//   ./configure.sh   (once: writes manifest.json)
//   CHROME_BIN="/path/to/Chrome for Testing" node tests/run.mjs
// Needs Chrome for Testing (or Chromium): branded Chrome ignores --load-extension.
// Exits non-zero when any check fails.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.CHROME_BIN
  || join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
if (!existsSync(join(EXT, 'manifest.json'))) { console.error('No manifest.json: run ./configure.sh first.'); process.exit(2); }
if (!existsSync(BIN)) { console.error(`Chrome not found at ${BIN}. Set CHROME_BIN.`); process.exit(2); }
// An unpacked extension's ID comes from its folder path: SHA-256, first 32 hex digits mapped 0-f → a-p.
const ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const BASE = `chrome-extension://${ID}/`;
const PORT = 9333, SITE = 9401;
let followed = 0; // requests that reached /followed: a followed redirect

// A tiny site for the link check, CORS-open so it needs no website permission.
const site = http.createServer((q, r) => {
  const h = { 'Access-Control-Allow-Origin': '*' };
  if (q.url === '/gone') { r.writeHead(404, h); return r.end(); }
  if (q.url === '/redirect') { r.writeHead(302, { ...h, Location: `http://127.0.0.1:${SITE}/followed` }); return r.end(); }
  if (q.url === '/followed') followed++;
  if (q.url === '/nohead' && q.method === 'HEAD') { r.writeHead(405, h); return r.end(); }
  r.writeHead(200, h); r.end('ok');
}).listen(SITE, '127.0.0.1');

const profile = mkdtempSync(join(tmpdir(), 'awesome-bookmarks-test-'));
const chrome = spawn(BIN, [`--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
let failed = 0;
function check(name, actual, expected) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(actual)}`}`);
}

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(250); } }
  await wait(1500);
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${BASE}newtab.html`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let n = 0; const pending = new Map();
  let expectErrors = false;
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error' && !expectErrors) errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 });
  const centre = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const click = async sel => { const xy = await centre(sel); await mouse('mouseMoved', ...xy); await mouse('mousePressed', ...xy, 1); await mouse('mouseReleased', ...xy, 0); await wait(300); };
  const key = async (key, code, modifiers = 0, extra = {}) => { for (const type of [extra.text ? 'keyDown' : 'rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, modifiers, ...extra }); await wait(300); };
  const goto = async page => { await send('Page.navigate', { url: BASE + page }); await wait(2000); };
  const restore = async json => ev(`(async () => { window.confirm = () => true;
    const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(json)}], 'backup.json'));
    const i = document.getElementById('restore'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    const all = await chrome.storage.sync.get(null);
    return { status: document.getElementById('backup-status').textContent, tasks: (await getTasks()).map(t => t.text + (t.done ? ' [x]' : '')), cols: all.cols, wallpaper: all.wallpaper, polluted: ({}).x ?? null }; })()`);
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await wait(2500);

  // ---- Tasks ----
  await ev(`chrome.storage.local.set({ tasks: [{ id: 'a1', text: 'Old task one', done: true }, { id: 'a2', text: 'Old task two' }] })`);
  await send('Page.reload'); await wait(2500);
  check('1.3 tasks move into sync', await ev(`(async () => ({ local: (await chrome.storage.local.get('tasks')).tasks ?? null,
    sync: Object.keys(await chrome.storage.sync.get(null)).filter(isTaskKey).sort(), shown: tasks.map(t => t.text) }))()`),
    { local: null, sync: ['task:a1', 'task:a2'], shown: ['Old task one', 'Old task two'] });
  await ev(`search.focus()`);
  await key('†', 'KeyT', 1);
  check('Option+T opens Tasks from the search field', await ev(`({ open: !tasksPanel.hidden, search: search.value })`), { open: true, search: '' });
  await ev(`window.loads = 0; { const real = load; load = (...a) => { loads++; return real(...a); }; }`);
  await click('#tasks-new');
  await send('Input.insertText', { text: 'Synced task' });
  await key('Enter', 'Enter', 0, { windowsVirtualKeyCode: 13, text: '\r' });
  check('Adding a task writes one sync key and leaves the grid alone', await ev(`(async () => ({ shown: tasks.map(t => t.text),
    keys: Object.keys(await chrome.storage.sync.get(null)).filter(isTaskKey).length, gridReloads: loads }))()`),
    { shown: ['Old task one', 'Old task two', 'Synced task'], keys: 3, gridReloads: 0 });
  await click('#tasks-list .task:nth-child(2) input[type=checkbox]');
  check('Ticking a task syncs it', await ev(`(async () => (await getTasks()).map(t => t.done))()`), [true, true, false]);
  await key('†', 'KeyT', 1);
  check('Option+T closes Tasks', await ev(`tasksPanel.hidden`), true);

  // ---- Dock ----
  check('Empty grid: the message clears the Dock, which stays at the bottom', await ev(`(async () => { const d = await dockFolder();
    const b = await chrome.bookmarks.create({ parentId: d.id, title: 'Lonely', url: 'https://lonely.example/' }); await new Promise(r => setTimeout(r, 600));
    const e = document.getElementById('empty').getBoundingClientRect(), k = dockEl.getBoundingClientRect();
    const result = { empty: document.body.classList.contains('no-bookmarks'), clear: e.bottom <= k.top, atBottom: innerHeight - k.bottom < 40 };
    await chrome.bookmarks.remove(b.id); await new Promise(r => setTimeout(r, 400)); return result; })()`), { empty: true, clear: true, atBottom: true });
  await ev(`(async () => { const [r] = await chrome.bookmarks.getTree();
    for (let i = 0; i < 4; i++) await chrome.bookmarks.create({ parentId: r.children[0].id, title: 'Site ' + i, url: 'https://s' + i + '.example/' });
    const d = await dockFolder();
    for (let i = 0; i < 3; i++) await chrome.bookmarks.create({ parentId: d.id, title: 'Dock ' + i, url: 'https://d' + i + '.example/' });
    await new Promise(r => setTimeout(r, 600)); })()`);
  check('Dock bookmarks stay off the grid', await ev(`[...document.querySelectorAll('#pager a.app')].map(a => nodes.get(a.dataset.id).title)`), ['Site 0', 'Site 1', 'Site 2', 'Site 3']);
  await ev(`search.focus()`);
  await key('∂', 'KeyD', 1);
  await key('ArrowRight', 'ArrowRight', 0, { windowsVirtualKeyCode: 39 });
  check('Option+D then → walks the Dock', await ev(`({ text: nodes.get(document.activeElement.dataset.id)?.title, inDock: dockEl.contains(document.activeElement) })`), { text: 'Dock 1', inDock: true });

  // ---- Folder preview ----
  await ev(`(async () => { const [r] = await chrome.bookmarks.getTree(); const f = await chrome.bookmarks.create({ parentId: r.children[0].id, title: 'Nine' });
    for (let i = 0; i < 9; i++) await chrome.bookmarks.create({ parentId: f.id, title: 'N' + i, url: 'https://n' + i + '.example/' });
    await new Promise(r => setTimeout(r, 600)); })()`);
  check('Folder previews fill the tile', await ev(`(() => { const f = document.querySelector('#pager .icon.folder'); return f.firstElementChild.offsetWidth / f.clientWidth > 0.2; })()`), true);

  await click('#pager button.app');
  await wait(400);
  check('Folder background fades in and out with the zoom', await ev(`(async () => {
    const fades = () => document.getAnimations().filter(a => a.effect.pseudoElement === '::backdrop').map(a => a.animationName);
    const opened = drawer.open; closeFolder(); await new Promise(r => setTimeout(r, 60));
    const closing = fades(); await new Promise(r => setTimeout(r, 400));
    return { opened, closing, closed: !drawer.open, leftover: drawer.classList.contains('closing') }; })()`),
    { opened: true, closing: ['fade-out'], closed: true, leftover: false });

  // ---- Custom icons ----
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 0' }))[0]; editBookmark(nodes.get(n.id)); })()`);
  await ev(`(async () => { const c = new OffscreenCanvas(300, 150); const x = c.getContext('2d'); x.fillStyle = '#e33'; x.fillRect(0, 0, 300, 150);
    const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], 'logo.png', { type: 'image/png' }));
    const i = document.getElementById('editor-icon-file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400)); })()`);
  check('Choosing an image previews it in the dialog', await ev(`({ preview: !!editorIcon.querySelector('img.custom'), reset: !editorIconReset.hidden })`), { preview: true, reset: true });
  check('The chosen image is shown, selected, in the chooser', await ev(`(() => { const s = iconChoices.querySelector('[aria-selected="true"]'); return [s?.title, !!s?.querySelector('img.custom')]; })()`), ['Your image', true]);
  await ev(`(async () => { editorIconChoice = null; showEditorIcon(); const c = new OffscreenCanvas(40, 40); c.getContext('2d').fillRect(0, 0, 40, 40);
    const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], 'p.png', { type: 'image/png' }));
    editorName.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 400)); })()`);
  check('Pasting an image into the dialog uses it as the icon', await ev(`!!editorIcon.querySelector('img.custom')`), true);
  await click('#editor-form button[type=submit]');
  await wait(600);
  const tileIcon = `(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 0' }))[0]; const t = document.querySelector('#pager a.app[data-id="' + n?.id + '"] img.custom');
    return t ? { size: [t.naturalWidth, t.naturalHeight], webp: t.src.startsWith('data:image/webp') } : null; })()`;
  check('The bookmark shows the picture, fitted into a 128px square', await ev(tileIcon), { size: [128, 128], webp: true });
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 0' }))[0]; await removeNode(nodes.get(n.id)); await new Promise(r => setTimeout(r, 400)); await undo(); await new Promise(r => setTimeout(r, 600)); })()`);
  check('Undo after delete brings the picture back', await ev(tileIcon), { size: [128, 128], webp: true });
  check('Pictures of deleted bookmarks are cleaned up', await ev(`(async () => Object.keys((await chrome.storage.local.get('icons')).icons).length)()`), 1);
  await ev(`(async () => { const all = (await chrome.storage.local.get('icons')).icons;
    await chrome.storage.local.set({ icons: { ...all, '__proto__': 'x', '1': 'javascript:alert(1)', '2': 'data:image/svg+xml;base64,PHN2Zz4=' } }); await new Promise(r => setTimeout(r, 400)); })()`);
  check('Anything but a WebP the page made is ignored', await ev(`[...icons.keys()].length`), 1);
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 0' }))[0]; editBookmark(nodes.get(n.id)); })()`);
  await click('#editor-icon-reset');
  await click('#editor-form button[type=submit]');
  await wait(600);
  check('"Use site icon" goes back to the site icon', await ev(tileIcon), null);

  // ---- Emoji icons ----
  check('Emoji picked from the site', await ev(`[['https://mail.google.com/', 'Inbox'], ['https://github.com/x', 'Code'], ['https://www.youtube.com/', ''], ['https://www.amazon.in/', 'Amazon'],
    ['https://docs.google.com/document/d/1', 'Plan'], ['chrome://settings', 'Settings'], ['https://some-unknown.example/', 'Thing']].map(([url, title]) => emojiFor({ url, title }))`),
    ['📧', '🐙', '🎬', '🛒', '📝', '⚙️', await ev(`emojiFor({ url: 'https://some-unknown.example/', title: 'Thing' })`)]);
  // ---- Brand logos (and the Icons setting) ----
  check('Brand logo found by host, domain or site name', await ev(`['https://github.com/org/repo', 'https://www.youtube.com/', 'https://mail.google.com/mail/u/0',
    'https://shop.github.co.uk/', 'https://unknown.example/', 'chrome://settings'].map(u => brandFor(u)?.slug ?? null)`),
    ['github', 'youtube', 'gmail', 'github', null, null]);
  check('Every logo in the index exists', await ev(`(async () => { const slugs = [...new Set([...brands.values()].map(b => b.slug))];
    const missing = []; for (const s of slugs) if (!(await fetch('brand/' + s + '.svg')).ok) missing.push(s); return [slugs.length > 3000, missing]; })()`), [true, []]);
  check('Icons: brand logos by default; others keep their site icon', await ev(`(async () => {
    const b = (await chrome.bookmarks.getTree())[0].children[0].id;
    window.gh = await chrome.bookmarks.create({ parentId: b, title: 'GitHub', url: 'https://github.com/', index: 0 }); await new Promise(r => setTimeout(r, 600));
    const tile = document.querySelector('#pager a.app[data-id="' + gh.id + '"] .icon .brand');
    const other = document.querySelector('#pager a.app:not([data-id="' + gh.id + '"]) .icon');
    return [settings.iconStyle, tile?.style.getPropertyValue('--brand'), tile?.querySelector('img').getAttribute('src'), !!other.querySelector('.brand, .emoji')]; })()`),
    ['brand', '#181717', 'brand/github.svg', false]);
  check('A brand logo in a folder preview is drawn on its colour, not a white square', await ev(`(async () => {
    const b = (await chrome.bookmarks.getTree())[0].children[0].id;
    const f = await chrome.bookmarks.create({ parentId: b, title: 'Preview folder', index: 0 });
    await chrome.bookmarks.create({ parentId: f.id, title: 'GitLab', url: 'https://gitlab.com/' }); await new Promise(r => setTimeout(r, 600));
    const logo = document.querySelector('#pager .app[data-id="' + f.id + '"] .icon.folder .brand img');
    const r = logo && getComputedStyle(logo).backgroundColor;
    await chrome.bookmarks.removeTree(f.id); await new Promise(r => setTimeout(r, 400));
    return r; })()`), 'rgba(0, 0, 0, 0)');
  await ev(`(async () => { await chrome.storage.sync.set({ iconStyle: 'emoji' }); await new Promise(r => setTimeout(r, 600)); })()`);
  check('Icons: emoji style', await ev(`!!document.querySelector('#pager a.app[data-id="' + gh.id + '"] .icon .emoji')`), true);
  await ev(`(async () => { await chrome.storage.sync.set({ iconStyle: 'site' }); await new Promise(r => setTimeout(r, 600)); })()`);
  check('Icons: site icons style', await ev(`!!document.querySelector('#pager a.app[data-id="' + gh.id + '"] .icon :is(.brand, .emoji)')`), false);
  await ev(`(async () => { await chrome.storage.sync.set({ iconStyle: 'brand' }); await chrome.bookmarks.remove(gh.id); await new Promise(r => setTimeout(r, 600)); })()`);
  check('The chooser offers "Brand logo", and "Letter" overrides it', await ev(`(async () => {
    const b = (await chrome.bookmarks.getTree())[0].children[0].id, wait = ms => new Promise(r => setTimeout(r, ms));
    const n = await chrome.bookmarks.create({ parentId: b, title: 'Lab', url: 'https://gitlab.com/', index: 0 }); await wait(600);
    editBookmark(nodes.get(n.id)); await wait(200);
    const offered = [...iconChoices.children].map(c => c.title).slice(1, 4);
    iconChoices.querySelector('[title="Letter"]').click(); document.getElementById('editor-form').requestSubmit(); await wait(600);
    const letter = !!document.querySelector('#pager a.app[data-id="' + n.id + '"] .icon .letter');
    await setIcon(n.id, null); await chrome.bookmarks.remove(n.id); await wait(400);
    return [offered, letter]; })()`), [["Site's own icon", 'Brand logo', 'Letter'], true]);
  // ---- Theme ----
  const theme = async (media, choice) => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: media }] });
    await ev(`chrome.storage.sync.set({ theme: '${choice}' }).then(() => new Promise(r => setTimeout(r, 500)))`);
    return ev(`document.documentElement.dataset.theme`);
  };
  check('Theme: System follows the computer; Light and Dark override it', [
    await theme('dark', 'system'), await theme('light', 'system'), await theme('light', 'dark'), await theme('dark', 'light'),
    await ev(`[sanitize({}).theme, sanitize({ theme: '<b>' }).theme]`)],
    ['dark', 'light', 'dark', 'light', ['system', 'system']]);
  await theme('', 'system');
  check('An older "emoji off" setting becomes site icons', await ev(`[sanitize({ emoji: false }).iconStyle, sanitize({ emoji: true }).iconStyle, sanitize({ iconStyle: 'nope' }).iconStyle]`), ['site', 'brand', 'brand']);
  await ev(`(async () => { await chrome.storage.sync.set({ iconStyle: 'emoji' }); await new Promise(r => setTimeout(r, 600)); })()`); // the emoji tests below
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 1' }))[0]; editBookmark(nodes.get(n.id)); })()`);
  await click('#editor-emoji');
  await send('Input.insertText', { text: '🦊 fox' });
  await wait(200);
  check('Typing an emoji previews it', await ev(`({ preview: editorIcon.querySelector('.emoji')?.textContent, box: editorEmoji.value })`), { preview: '🦊', box: '🦊' });
  await click('#editor-form button[type=submit]');
  await wait(600);
  check('The chosen emoji shows on the bookmark', await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 1' }))[0];
    return document.querySelector('#pager a.app[data-id="' + n.id + '"] .emoji')?.textContent; })()`), '🦊');
  check('Add bookmark: address errors show under the field; a known page names itself from history', await ev(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), err = document.getElementById('editor-url-error');
    document.getElementById('add').click(); await wait(200);
    const folded = !document.getElementById('icon-more').open;
    document.getElementById('editor-form').requestSubmit(); await wait(100);
    const empty = [err.hidden, err.textContent, editorUrl.getAttribute('aria-invalid'), document.activeElement === editorUrl];
    editorUrl.value = 'not an address'; editorUrl.dispatchEvent(new Event('change')); await wait(100);
    const bad = err.textContent.startsWith("That doesn't look like a web address");
    editorUrl.dispatchEvent(new Event('input')); const cleared = err.hidden && !editorUrl.hasAttribute('aria-invalid');
    const realContains = chrome.permissions.contains, realHistory = chrome.history;
    chrome.permissions.contains = async () => true;
    Object.defineProperty(chrome, 'history', { configurable: true, value: { search: async () => [{ url: 'https://named.example/page', title: 'Named from history' }] } });
    editorUrl.value = 'named.example/page'; editorUrl.dispatchEvent(new Event('change')); await wait(200);
    const named = editorName.value;
    chrome.permissions.contains = realContains; Object.defineProperty(chrome, 'history', { configurable: true, value: realHistory });
    editor.close(); await wait(200);
    return [folded, ...empty, bad, cleared, named]; })()`),
    [true, false, 'Enter an address, like example.com.', 'true', true, true, true, 'Named from history']);
  // The chooser: open with "Change icon…", pick the site's own icon, then a palette emoji.
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 2' }))[0]; const t = document.querySelector('#pager a.app[data-id="' + n.id + '"]');
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })); await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('#menu button')].find(b => b.textContent === 'Change icon…').click(); await new Promise(r => setTimeout(r, 300)); })()`);
  check('Change icon… opens a chooser with many options', await ev(`({ open: editor.open, count: iconChoices.children.length > 60, first: [...iconChoices.children].slice(0, 2).map(b => b.title),
    focusInChooser: iconChoices.contains(document.activeElement) })`), { open: true, count: true, first: ['Upload an image (or paste or drop one here)', "Site's own icon"], focusInChooser: true });
  await click('#icon-choices .choice[title="Site\'s own icon"]');
  check('Picking the site icon selects it', await ev(`({ selected: iconChoices.querySelector('[aria-selected="true"]').title, preview: !editorIcon.querySelector('.emoji') })`), { selected: "Site's own icon", preview: true });
  await click('#icon-choices .choice[title="🚀"]');
  await click('#editor-form button[type=submit]');
  await wait(600);
  check('The picked emoji is saved', await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 2' }))[0];
    return { tile: document.querySelector('#pager a.app[data-id="' + n.id + '"] .emoji')?.textContent, stored: icons.get(n.id) }; })()`), { tile: '🚀', stored: '🚀' });
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 2' }))[0]; await setIcon(n.id, 'letter'); await new Promise(r => setTimeout(r, 500)); })()`);
  check('"Letter" keeps the letter even with emoji icons on', await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 2' }))[0];
    return document.querySelector('#pager a.app[data-id="' + n.id + '"] .letter')?.textContent; })()`), 'S');
  check('Only a single emoji is accepted from storage', await ev(`[oneEmoji('👍🏽'), oneEmoji('🇮🇳'), oneEmoji('👨‍👩‍👧'), oneEmoji('<b>x</b>'), oneEmoji('abc'), oneEmoji('')]`),
    ['👍🏽', '🇮🇳', '👨‍👩‍👧', null, null, null]);

  // ---- Google Drive sync (Drive faked in the page: no network, no sign-in) ----
  await ev(`(async () => {
    const o = (await chrome.bookmarks.getTree())[0].children[1].id;
    window.dA = (await chrome.bookmarks.create({ parentId: o, title: 'Drive A', url: 'https://drive-a.example/' })).id;
    window.dB = (await chrome.bookmarks.create({ parentId: o, title: 'Drive B', url: 'https://drive-b.example/' })).id;
    await setIcon(dA, '🚀');
    window.remote = { modifiedTime: 't1', body: JSON.stringify({ icons: { 'https://drive-b.example/': '🎸', 'https://elsewhere.example/': '🌍', 'https://drive-a.example/': '<b>' } }) };
    window.realFetch = fetch; window.realToken = driveToken;
    driveToken = async () => 'test-token';
    window.fetch = async (url, init = {}) => {
      const p = new URL(url).pathname, m = init.method || 'GET';
      if (p === '/drive/v3/files' && m === 'GET') return Response.json({ files: [{ id: 'f1', modifiedTime: remote.modifiedTime }] });
      if (p === '/drive/v3/files/f1') return new Response(remote.body);
      if (p === '/upload/drive/v3/files/f1' && m === 'PATCH') { remote = { modifiedTime: 't2', body: init.body }; return Response.json({ modifiedTime: 't2' }); }
      throw new Error('unexpected ' + m + ' ' + p);
    };
    await setDrive({ on: true, dirty: true, syncedAt: '' });
    await syncDrive();
  })()`);
  check('Drive: first sync merges both ways, by URL', await ev(`(async () => ({ local: (r => [r[dA], r[dB]])(Object.fromEntries(await readIcons())), sent: (i => [i['https://elsewhere.example/'], i['https://drive-a.example/'], i['https://drive-b.example/']])(JSON.parse(remote.body).icons), state: (({ dirty, syncedAt, error }) => ({ dirty, syncedAt, error }))(await getDrive()) }))()`),
    { local: ['🚀', '🎸'], sent: ['🌍', '🚀', '🎸'], state: { dirty: false, syncedAt: 't2', error: '' } });
  check('Drive: a change on another computer replaces this one', await ev(`(async () => {
    remote = { modifiedTime: 't3', body: JSON.stringify({ icons: { 'https://drive-a.example/': '🍕' } }) };
    await setDrive({ checkedAt: 0 }); await syncDrive();
    const r = Object.fromEntries(await readIcons()); return [r[dA], r[dB] ?? null, (await getDrive()).syncedAt];
  })()`), ['🍕', null, 't3']);
  await ev(`(async () => { fetch = realFetch; driveToken = realToken; await chrome.storage.local.remove('drive');
    await chrome.bookmarks.remove(dA); await chrome.bookmarks.remove(dB); })()`);

  // ---- List view ----
  await ev(`(async () => { const b = (await chrome.bookmarks.getTree())[0].children[0].id;
    window.lf = await chrome.bookmarks.create({ parentId: b, title: 'List folder' });
    await chrome.bookmarks.create({ parentId: lf.id, title: 'Inside', url: 'https://inside.example/' });
    await chrome.bookmarks.create({ parentId: b, title: 'Repo one', url: 'https://www.gitlab.example/a' });
    await chrome.bookmarks.create({ parentId: b, title: 'Repo two', url: 'https://gitlab.example/b' });
    await chrome.bookmarks.create({ parentId: b, title: 'Lonely', url: 'https://lonely.example/' });
    await chrome.storage.sync.set({ view: 'list' }); await new Promise(r => setTimeout(r, 700)); })()`);
  check('List view: folders as cards, loose bookmarks grouped by website', await ev(`(() => {
    const cards = [...document.querySelectorAll('#list .list-card:not(.list-single)')].map(c => [c.querySelector('.list-title').textContent, [...c.querySelectorAll('.list-row .list-text > span')].map(s => s.textContent)]);
    return { pagerHidden: getComputedStyle(document.getElementById('pager')).display, folder: cards.find(c => c[0] === 'List folder'), site: cards.find(c => c[0] === 'gitlab.example'), single: [...document.querySelectorAll('#list .list-single .list-text > span')].map(s => s.textContent).includes('Lonely') && !cards.some(c => c[0] === 'lonely.example') };
  })()`), { pagerHidden: 'none', folder: ['List folder', ['Inside']], site: ['gitlab.example', ['Repo one', 'Repo two']], single: true });
  check('List view: a folded card stays folded after a reload', await ev(`(async () => { const d = [...document.querySelectorAll('#list details')].find(d => d.querySelector('.list-title').textContent === 'List folder');
    d.open = false; await new Promise(r => setTimeout(r, 200)); await load(); return [...document.querySelectorAll('#list details')].find(d => d.querySelector('.list-title').textContent === 'List folder').open; })()`), false);
  check('List view: a long folder scrolls inside its card, title and "Add link" stay put', await ev(`(async () => {
    for (let i = 0; i < 12; i++) await chrome.bookmarks.create({ parentId: lf.id, title: 'More ' + i, url: 'https://more' + i + '.example/' });
    await new Promise(r => setTimeout(r, 500));
    const d = [...document.querySelectorAll('#list details')].find(d => d.querySelector('.list-title').textContent === 'List folder'); d.open = true;
    await new Promise(r => setTimeout(r, 200)); const rows = d.querySelector('.list-rows');
    return [rows.children.length, rows.scrollHeight > rows.clientHeight, !rows.contains(d.querySelector('.list-add'))]; })()`), [13, true, true]);
  check('List view: searching shows tiles', await ev(`(async () => { search.value = 'repo'; search.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 200));
    const r = [document.getElementById('list').hidden, document.querySelectorAll('#pager .app').length]; search.value = ''; search.dispatchEvent(new Event('input')); return r; })()`), [true, 2]);
  await ev(`(async () => { await chrome.storage.sync.set({ view: 'grid' }); await new Promise(r => setTimeout(r, 600)); await chrome.bookmarks.removeTree(lf.id);
    for (const b of [...await chrome.bookmarks.search({ query: 'Repo' }), ...await chrome.bookmarks.search({ query: 'Lonely' })]) await chrome.bookmarks.remove(b.id); await new Promise(r => setTimeout(r, 300)); })()`);
  check('The Dock keeps its width across list and icon views', await ev(`(async () => {
    const other = (await chrome.bookmarks.getTree())[0].children[1].id;
    const d = (await chrome.bookmarks.search({ title: 'Dock' })).find(n => !n.url) || await chrome.bookmarks.create({ parentId: other, title: 'Dock' });
    window.dockTest = await chrome.bookmarks.create({ parentId: d.id, title: 'Docked', url: 'https://docked.example/' });
    await new Promise(r => setTimeout(r, 400));
    const width = () => document.getElementById('dock').getBoundingClientRect().width;
    const before = width();
    await chrome.storage.sync.set({ view: 'list' }); await new Promise(r => setTimeout(r, 600)); const inList = width();
    await chrome.storage.sync.set({ view: 'grid' }); await new Promise(r => setTimeout(r, 600)); const after = width();
    await chrome.bookmarks.remove(dockTest.id); await new Promise(r => setTimeout(r, 300));
    return [inList === before, after === before];
  })()`), [true, true]);
  check('Back to icons', await ev(`[document.getElementById('list').hidden, getComputedStyle(document.getElementById('pager')).display !== 'none']`), [true, true]);
  check('Greeting shows your name, as plain text only', await ev(`(async () => {
    await chrome.storage.sync.set({ name: '  Ada‮<b>x</b>  ' }); await new Promise(r => setTimeout(r, 300));
    const g = document.getElementById('greeting'), r = [/^Good (morning|afternoon|evening), Ada<b>x<\\/b>$/.test(g.textContent), !g.querySelector('b')];
    await chrome.storage.sync.remove('name'); await new Promise(r => setTimeout(r, 300));
    return [...r, /^Good (morning|afternoon|evening)$/.test(g.textContent)];
  })()`), [true, true, true]);
  check('"/" jumps to search without typing a slash', await ev(`(() => { document.activeElement?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    const r = [document.activeElement === search, search.value]; search.blur(); return r; })()`), [true, '']);
  check('History import: saved rows get a badge; adding says where, with Undo', await ev(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const savedRow = historyRow({ url: 'https://saved.example/', title: 'Saved one', visitCount: 3 }, true);
    const badge = [savedRow.querySelector('.history-count.saved')?.textContent, savedRow.querySelector('input').disabled];
    importerFolder.replaceChildren(new Option('Bookmarks bar', bar.id)); importerFolder.value = bar.id;
    picked.clear(); picked.set('https://imported.example/', 'Imported'); updateAddButton();
    const label = importerAdd.textContent;
    importerAdd.click(); await wait(500);
    const added = (await chrome.bookmarks.search({ url: 'https://imported.example/' })).length;
    const said = document.querySelector('#toast span').textContent;
    document.querySelector('#toast button').click(); await wait(500);
    picked.clear();
    return [...badge, label, added, said, (await chrome.bookmarks.search({ url: 'https://imported.example/' })).length]; })()`),
    ['✓ Already saved', true, 'Add 1 bookmark', 1, 'Added 1 bookmark to Bookmarks bar', 0]);
  check('"Move to…" in the menu lists folders and moves the bookmark', await ev(`(async () => {
    const b = (await chrome.bookmarks.getTree())[0].children[0].id, wait = ms => new Promise(r => setTimeout(r, ms));
    const f = await chrome.bookmarks.create({ parentId: b, title: 'Move here', index: 0 });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Keeps it', url: 'https://keeps.example/' });
    const m = await chrome.bookmarks.create({ parentId: b, title: 'Mover', url: 'https://mover.example/', index: 1 }); await wait(600);
    document.querySelector('#pager .app[data-id="' + m.id + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    const item = label => [...document.querySelectorAll('#menu button')].find(x => x.textContent.trim() === label);
    item('Move to…').click(); await wait(100);
    const offered = !!item('Move here') && !item('Dock');
    item('Move here').click(); await wait(500);
    const moved = (await chrome.bookmarks.get(m.id))[0].parentId === f.id;
    await chrome.bookmarks.removeTree(f.id); await wait(400);
    return [offered, moved]; })()`), [true, true]);
  check('Keyboard: Escape closes Tasks back to its button; a folder opens on its first bookmark', await ev(`(async () => {
    const t = document.getElementById('tasks-toggle'); t.click(); await new Promise(r => setTimeout(r, 200));
    document.getElementById('tasks-new').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const tasks = [document.getElementById('tasks').hidden, document.activeElement === t];
    const b = (await chrome.bookmarks.getTree())[0].children[0].id;
    const f = await chrome.bookmarks.create({ parentId: b, title: 'Keyboard folder', index: 0 });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Keyboard inside', url: 'https://kbd.example/' }); await new Promise(r => setTimeout(r, 600));
    document.querySelector('#pager .app[data-id="' + f.id + '"]').click(); await new Promise(r => setTimeout(r, 500));
    const first = document.activeElement?.closest('#folder-pager .app')?.textContent.includes('Keyboard inside') === true;
    document.getElementById('drawer').close(); await chrome.bookmarks.removeTree(f.id); await new Promise(r => setTimeout(r, 500));
    return [...tasks, first]; })()`), [true, true, true]);
  // ---- Medium: weather, focus timer, list drag, photo of the day (the network is faked) ----
  check('Weather shows on the clock, and a bad reply shows nothing', await ev(`(async () => {
    const real = window.fetch; let asked = '';
    window.fetch = async (url, o) => { if (!String(url).includes('open-meteo')) return real(url, o); asked = String(url); return new Response(JSON.stringify({ current: window.fakeCurrent }), { headers: { 'content-type': 'application/json' } }); };
    window.fakeCurrent = { temperature_2m: 21.4, weather_code: 0, is_day: 1 };
    await chrome.storage.local.remove('weather');
    await chrome.storage.sync.set({ place: { name: 'Pune, India', lat: 18.52, lon: 73.86 } }); await new Promise(r => setTimeout(r, 500));
    const w = document.getElementById('weather'), shown = [w.hidden, [...w.children].map(c => c.textContent).join(' | '), getComputedStyle(w.firstChild).fontSize === getComputedStyle(document.getElementById('clock-toggle')).fontSize, new URL(asked).hostname];
    window.fakeCurrent = { temperature_2m: '<img src=x>', weather_code: 0 };
    await chrome.storage.local.remove('weather'); await chrome.storage.sync.set({ place: { name: 'Elsewhere', lat: 1, lon: 2 } }); await new Promise(r => setTimeout(r, 500));
    const bad = w.hidden;
    await chrome.storage.sync.remove('place'); await new Promise(r => setTimeout(r, 300));
    window.fetch = real;
    return [...shown, bad, w.hidden];
  })()`), [false, '☀️ 21° | Pune', true, 'api.open-meteo.com', true, true]);
  check('Focus timer runs across tabs, then rings and resets', await ev(`(async () => {
    document.getElementById('focus-start').click(); await new Promise(r => setTimeout(r, 200));
    const run = (await chrome.storage.local.get('focus')).focus;
    const running = [run?.kind, document.getElementById('focus-label').textContent, document.getElementById('focus-stop').hidden, /^2[45]:\\d\\d · Focus$/.test(document.title)];
    await chrome.storage.local.set({ focus: { kind: 'focus', endsAt: Date.now() + 1200 } }); await new Promise(r => setTimeout(r, 2600));
    const done = [document.getElementById('focus-label').textContent, (await chrome.storage.local.get('focus')).focus, document.title, document.getElementById('focus-start').hidden];
    document.getElementById('focus-break').click(); await new Promise(r => setTimeout(r, 200));
    document.getElementById('focus-stop').click(); await new Promise(r => setTimeout(r, 200));
    return [...running, ...done, document.getElementById('focus-label').textContent, (await chrome.storage.local.get('focus')).focus];
  })()`), ['focus', 'Focus', false, true, 'Done: time for a break', null, 'New Tab', false, 'Ready', null]);
  check('List view: drag rows into a folder, reorder, and out again', await ev(`(async () => {
    const b = (await chrome.bookmarks.getTree())[0].children[0].id, wait = () => new Promise(r => setTimeout(r, 400));
    const f = await chrome.bookmarks.create({ parentId: b, title: 'Drag folder' });
    const one = await chrome.bookmarks.create({ parentId: f.id, title: 'Drag one', url: 'https://one.drag.example/' });
    const two = await chrome.bookmarks.create({ parentId: f.id, title: 'Drag two', url: 'https://two.drag.example/' });
    const loose = await chrome.bookmarks.create({ parentId: b, title: 'Drag loose', url: 'https://loose.drag.example/' });
    await chrome.storage.sync.set({ view: 'list' }); await wait();
    const row = id => document.querySelector('#list .list-row[data-id="' + id + '"]');
    const card = () => [...document.querySelectorAll('#list .list-card')].find(c => c.querySelector('.list-title')?.textContent === 'Drag folder');
    const drag = async (from, to) => { const dt = new DataTransfer(); const o = { dataTransfer: dt, bubbles: true, cancelable: true };
      from.dispatchEvent(new DragEvent('dragstart', o)); to.dispatchEvent(new DragEvent('dragover', o)); to.dispatchEvent(new DragEvent('drop', o)); from.dispatchEvent(new DragEvent('dragend', o)); await wait(); };
    const kids = async () => (await chrome.bookmarks.getChildren(f.id)).map(n => n.title);
    await drag(row(loose.id), card().querySelector('summary')); const intoFolder = await kids();
    await drag(row(two.id), row(one.id)); const reordered = await kids();
    const other = document.querySelector('#list .list-card:not([data-folder])');
    await drag(row(one.id), other); const out = [(await chrome.bookmarks.get(one.id))[0].parentId === b, await kids()];
    await chrome.bookmarks.removeTree(f.id); await chrome.bookmarks.remove(one.id); await chrome.storage.sync.set({ view: 'grid' }); await wait();
    return [intoFolder, reordered, ...out];
  })()`), [['Drag one', 'Drag two', 'Drag loose'], ['Drag two', 'Drag one', 'Drag loose'], true, ['Drag two', 'Drag loose']]);
  check('Photo of the day: skips portrait and foreign hosts, credits the photo', await ev(`(async () => {
    const real = window.fetch, asked = [];
    const c = new OffscreenCanvas(64, 36); c.getContext('2d').fillRect(0, 0, 64, 36); const jpeg = await c.convertToBlob({ type: 'image/jpeg' });
    const pic = (w, h, host) => ({ image: { title: 'File:Test photo.jpg', image: { width: w, height: h }, thumbnail: { source: 'https://' + host + '/wikipedia/commons/thumb/a/ab/Test.jpg/960px-Test.jpg' }, artist: { text: 'Ann Lens' }, description: { text: 'A lake' } } });
    const feeds = [pic(1000, 3000, 'thumb.wikimedia.org'), pic(4000, 2000, 'evil.example'), pic(4000, 2000, 'thumb.wikimedia.org')];
    window.fetch = async (url, o) => { if (!/wikimedia|evil\.example/.test(String(url))) return real(url, o); url = String(url); asked.push(url);
      if (url.includes('/featured/')) return new Response(JSON.stringify(feeds.shift() || {}), { headers: { 'content-type': 'application/json' } });
      return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }); };
    await chrome.storage.local.remove(['daily', 'dailyTried']);
    await chrome.storage.sync.set({ wallpaper: 'daily' }); await new Promise(r => setTimeout(r, 1500));
    const d = (await chrome.storage.local.get('daily')).daily, credit = document.getElementById('photo-credit');
    const r = [d?.date === new Date().toLocaleDateString('en-CA'), document.documentElement.dataset.wallpaper, credit.hidden, credit.textContent, credit.href,
      asked.filter(u => !u.includes('/featured/')), asked.some(u => u.includes('evil.example'))];
    window.fetch = real;
    await chrome.storage.sync.set({ wallpaper: 'meadow' }); await chrome.storage.local.remove(['daily', 'dailyTried']); await new Promise(r => setTimeout(r, 300));
    return [...r, credit.hidden];
  })()`), [true, 'custom', false, '📷 A lake · Ann Lens', 'https://commons.wikimedia.org/wiki/File%3ATest%20photo.jpg',
    ['https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Test.jpg/1920px-Test.jpg'], false, true]);
  check('Notes save after a pause and follow other tabs', await ev(`(async () => {
    const n = document.getElementById('notes'); n.focus(); n.value = 'Call the bank'; n.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 1900)); const saved = (await chrome.storage.sync.get('notes')).notes; n.blur();
    await chrome.storage.sync.set({ notes: 'From another tab' }); await new Promise(r => setTimeout(r, 300)); const followed = n.value;
    await chrome.storage.sync.remove('notes'); await new Promise(r => setTimeout(r, 300));
    return [saved, followed, document.getElementById('notes-status').textContent];
  })()`), ['Call the bank', 'From another tab', 'Saved']);
  check('Clicking the clock switches 12/24-hour and back', await ev(`(async () => {
    const b = document.getElementById('clock-toggle'), is12 = () => /am|pm/i.test(document.getElementById('clock-time').textContent);
    const first = is12(); b.click(); await new Promise(r => setTimeout(r, 300)); const flipped = is12();
    const saved = (await chrome.storage.sync.get('hour12')).hour12;
    b.click(); await new Promise(r => setTimeout(r, 300)); const back = is12();
    await chrome.storage.sync.remove('hour12'); await new Promise(r => setTimeout(r, 200));
    return [flipped !== first, saved === flipped, back === first];
  })()`), [true, true, true]);

  // ---- Security: chrome:// action pages ----
  check('chrome:// quit/crash pages are refused, normal ones allowed', await ev(`['chrome://quit', 'chrome://restart/', 'CHROME://crash', 'chrome://memory-pressure-critical', 'javascript:alert(1)',
    'chrome://settings', 'https://example.com/chrome://quit'].map(isSafe)`), [false, false, false, false, false, true, true]);

  // ---- Bright wallpaper ----
  const wallpaper = colour => ev(`(async () => { const c = new OffscreenCanvas(64, 64); const x = c.getContext('2d'); x.fillStyle = '${colour}'; x.fillRect(0, 0, 64, 64);
    const b = await c.convertToBlob({ type: 'image/jpeg' }); const url = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
    await chrome.storage.local.set({ wallpaperImage: url }); await chrome.storage.sync.set({ wallpaper: 'custom' }); await new Promise(r => setTimeout(r, 800));
    return document.documentElement.classList.contains('bright-wallpaper'); })()`);
  check('A bright photo is dimmed', await wallpaper('#f4f1ea'), true);
  check('A dark photo is left alone', await wallpaper('#202830'), false);
  await ev(`(async () => { await chrome.storage.local.remove('wallpaperImage'); await chrome.storage.sync.set({ wallpaper: 'meadow' }); })()`);

  // ---- Settings: clean up ----
  await ev(`(async () => { const [r] = await chrome.bookmarks.getTree(); const o = r.children[1].id;
    await chrome.bookmarks.create({ parentId: o, title: 'Site 1 again', url: 'https://s1.example' });
    await chrome.bookmarks.create({ parentId: o, title: 'Site 2 #top', url: 'https://s2.example/#top' }); })()`);
  await goto('options.html');
  await click('#find-duplicates');
  check('Duplicates found (trailing slash and #part ignored)', await ev(`[...document.querySelectorAll('#cleanup-results .row[data-id] .row-text > span')].map(s => s.textContent)`), ['Site 1 again', 'Site 2 #top']);
  await ev(`window.confirm = () => true`);
  await click('#cleanup-results .row:first-child button');
  check('Delete all keeps the oldest copy', await ev(`(async () => (await chrome.bookmarks.search({ query: 'Site' })).map(b => b.title).sort())()`), ['Site 0', 'Site 1', 'Site 2', 'Site 3']);
  check('Link check verdicts', await ev(`(async () => [await linkProblem('http://127.0.0.1:${SITE}/gone'), await linkProblem('http://127.0.0.1:${SITE}/nohead'),
    await linkProblem('http://127.0.0.1:${SITE}/ok'), await linkProblem('http://127.0.0.1:9409/')])()`), ['Not found (404)', null, null, "Couldn't connect"]);
  check('Link check never touches this computer or the local network', await ev(`['http://192.168.1.1/reboot', 'http://10.0.0.5', 'http://172.20.1.1', 'http://127.0.0.1:8080', 'http://localhost:3000',
    'http://printer.local', 'http://router', 'http://[::1]/', 'http://[fd12::1]/', 'http://[fe80::1]/', 'http://169.254.169.254/', 'http://0x7f.1/', 'http://2130706433/',
    'https://example.com', 'https://8.8.8.8', 'https://10.example.com', 'http://172.32.1.1'].map(isPublicHost)`),
    [false, false, false, false, false, false, false, false, false, false, false, false, false, true, true, true, true]);
  check('Link check: disguised local addresses are refused, real public IPv6 allowed', await ev(`['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:192.168.1.1]/',
    'http://[::127.0.0.1]/', 'http://[64:ff9b::127.0.0.1]/', 'http://[2002:7f00:1::]/', 'http://[2001::1]/', 'http://localhost./', 'http://router.lan./', 'http://printer.local./',
    'http://100.64.0.1/', 'http://100.127.255.254/', 'http://[2606:4700::1111]/', 'https://example.com./', 'http://100.128.0.1/'].map(isPublicHost)`),
    [false, false, false, false, false, false, false, false, false, false, false, false, true, true, true]);
  check('Link check: a redirect counts as working and is never followed', [await ev(`linkProblem('http://127.0.0.1:${SITE}/redirect')`), followed], [null, 0]);

  check('Google connect errors say what to fix', await ev(`[
    "OAuth2 request failed: Service responded with error: 'bad client id: 123.apps.googleusercontent.com'",
    'The user is not signed in.', 'The user did not approve access.', 'permission declined', 'Something odd',
    "OAuth2 request failed: Service responded with error: 'Service has been disabled for this account.'"
  ].map(m => googleError(new Error(m)).split(/[.:]/)[0])`),
    ["Google doesn't recognise this extension's OAuth client", 'Sign in to Chrome (the profile icon, top right), then try again', 'Connecting was cancelled', 'Chrome needs the sign-in permission to connect', "Couldn't connect",
      "Your Google account's admin has turned this off (common with work accounts)"]);
  check('Calendar and Drive: expired and failed states offer Reconnect', await ev(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), real = chrome.runtime.getManifest;
    chrome.runtime.getManifest = () => ({ ...real(), oauth2: { client_id: 'test.apps.googleusercontent.com' } });
    const read = () => ['calendar', 'drive'].map(w => [document.getElementById(w + '-status').textContent, document.getElementById(w + '-button').textContent]);
    await chrome.storage.local.set({ calendarHealth: 'connect', drive: { on: true, error: 'expired', syncedAt: '' } });
    await chrome.storage.sync.set({ calendar: true }); await wait(400);
    const expired = read();
    await chrome.storage.local.set({ calendarHealth: 'error', drive: { on: true, error: 'failed', syncedAt: '' } }); await wait(400);
    const failed = read();
    await chrome.storage.local.set({ calendarHealth: 'ok', drive: { on: true, error: '', syncedAt: '2026-01-02T03:04:05Z' } }); await wait(400);
    const ok = read().map(([s, b]) => [s.split(' · ')[0], b]);
    await chrome.storage.sync.set({ calendar: false }); await chrome.storage.local.remove(['calendarHealth', 'drive']);
    chrome.runtime.getManifest = real; await refresh();
    return [expired, failed, ok]; })()`), [
    [['Sign-in expired. Reconnect to see your meetings.', 'Reconnect'], ['Sign-in expired. Reconnect to keep syncing.', 'Reconnect']],
    [["Couldn't reach Google Calendar. The new tab tries again every few minutes.", 'Disconnect'], ["Couldn't reach Google Drive. It tries again on its own, or reconnect.", 'Reconnect']],
    [['Connected', 'Disconnect'], ['Connected', 'Disconnect']]]);
  check('Settings: the Theme select saves and applies', await ev(`(async () => {
    const t = document.getElementById('theme'); t.value = 'dark'; t.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 400));
    const r = [(await chrome.storage.sync.get('theme')).theme, document.documentElement.dataset.theme];
    t.value = 'system'; t.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300)); return r; })()`), ['dark', 'dark']);
  check('Settings: the Icons select saves the style', await ev(`(async () => {
    const s = document.getElementById('icon-style'), before = s.value; s.value = 'site'; s.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300));
    const saved = (await chrome.storage.sync.get('iconStyle')).iconStyle; s.value = before; s.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300));
    return saved; })()`), 'site');
  check('Settings: "Show bookmarks as" switches between icons and list', await ev(`(async () => {
    const v = document.getElementById('view'); v.value = 'list'; v.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300));
    const saved = (await chrome.storage.sync.get('view')).view;
    v.value = 'grid'; v.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300));
    return [saved, (await chrome.storage.sync.get('view')).view]; })()`), ['list', 'grid']);
  check('Settings: six sections, and the side menu marks the one jumped to', await ev(`(async () => {
    const links = [...document.querySelectorAll('#toc a')];
    const sections = links.map(a => document.querySelector(a.hash)?.querySelector('h2')?.textContent);
    links.find(a => a.hash === '#maintenance').click(); await new Promise(r => setTimeout(r, 300));
    const marked = document.querySelector('#toc a[aria-current="true"]')?.hash; scrollTo(0, 0);
    return [sections, marked]; })()`),
    [['Appearance', 'Widgets', 'Bookmarks', 'Privacy & integrations', 'Maintenance', 'Backup & restore'], '#maintenance']);
  // ---- Settings: backup ----
  check('Keyboard: "Restore…" is a focusable button', await ev(`(() => { const l = document.getElementById('restore').parentElement;
    l.focus(); return [document.activeElement === l, l.role]; })()`), [true, 'button']);
  check('Backup file', await ev(`(async () => { let href; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { href = this.href; };
    document.getElementById('backup').click(); await new Promise(r => setTimeout(r, 400)); HTMLAnchorElement.prototype.click = orig;
    const d = JSON.parse(await (await fetch(href)).text()); return { app: d.app, tasks: d.tasks.length, wallpaper: d.settings.wallpaper }; })()`),
    { app: 'awesome-bookmarks', tasks: 3, wallpaper: 'meadow' });
  check('A non-backup file is refused', (await restore('not json')).status, "That file isn't an Awesome bookmarks backup.");
  check('A hostile backup is cleaned', await restore(JSON.stringify({ app: 'awesome-bookmarks', version: 1,
    settings: JSON.parse('{"__proto__":{"x":1},"cols":99,"wallpaper":"<img src=x>"}'),
    tasks: [{ id: '../evil', text: 'bad id' }, { id: 'ok1', text: '  Restored  ', done: 'yes', at: 1 }, { id: 'ok2', text: 'Done one', done: true, at: 2 }] })),
    { status: 'Restored 2 tasks, your notes and your settings.', tasks: ['Restored', 'Done one [x]'], cols: 0, wallpaper: 'meadow', polluted: null });
  check('Restore warns with the counts and first downloads what you have now', await ev(`(async () => {
    let asked = '', saved = null; const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { saved = { name: this.download, href: this.href }; };
    window.confirm = m => { asked = m; return true; };
    const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ app: 'awesome-bookmarks', settings: {}, tasks: [{ id: 'r1', text: 'One' }] })], 'b.json'));
    const i = document.getElementById('restore'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900)); HTMLAnchorElement.prototype.click = orig;
    const before = JSON.parse(await (await fetch(saved.href)).text());
    return [asked.includes('your 2 tasks with its 1'), asked.includes('your notes stay'), /^awesome-bookmarks-before-restore-/.test(saved.name), before.tasks.length,
      (await getTasks()).map(t => t.text)]; })()`), [true, true, true, 2, ['One']]);
  await restore(JSON.stringify({ app: 'awesome-bookmarks', version: 1, settings: {}, tasks: [{ id: 'ok1', text: 'Restored', at: 1 }, { id: 'ok2', text: 'Done one', done: true, at: 2 }] }));
  expectErrors = true; // the forced failure below logs on purpose
  check('A restore that fails to save keeps the current tasks', await ev(`(async () => {
    const real = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
    const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ app: 'awesome-bookmarks', settings: {}, tasks: [{ id: 'n1', text: 'New' }] })], 'b.json'));
    const i = document.getElementById('restore'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 800)); chrome.storage.sync.set = real;
    return (await getTasks()).map(t => t.text); })()`), ['Restored', 'Done one']);
  expectErrors = false;
  ws.close();
} catch (err) {
  failed++;
  console.log(`FAIL ${err.message}`);
} finally {
  chrome.kill();
  site.close();
  await wait(500);
  rmSync(profile, { recursive: true, force: true });
  check('No errors on the pages', errors, []);
  console.log(failed ? `\n${failed} failed` : '\nAll passed');
  process.exitCode = failed ? 1 : 0;
}
