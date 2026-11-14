// End-to-end checks in a real Chrome, with the extension loaded unpacked into a throwaway profile.
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
if (!existsSync(BIN)) { console.error(`Chrome not found at ${BIN}. Set CHROME_BIN.`); process.exit(2); }
// An unpacked extension's ID comes from its folder path: SHA-256, first 32 hex digits mapped 0-f → a-p.
const ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const BASE = `chrome-extension://${ID}/`;
const PORT = 9333, SITE = 9401;

// A tiny site for the link check, CORS-open so it needs no website permission.
const site = http.createServer((q, r) => {
  const h = { 'Access-Control-Allow-Origin': '*' };
  if (q.url === '/gone') { r.writeHead(404, h); return r.end(); }
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
  check('Emoji icons are on by default', await ev(`(() => { const t = document.querySelector('#pager a.app .icon'); return { setting: settings.emoji, emoji: !!t.querySelector('.emoji') }; })()`), { setting: true, emoji: true });
  await ev(`(async () => { await chrome.storage.sync.set({ emoji: false }); await new Promise(r => setTimeout(r, 600)); })()`);
  check('Turning them off shows site icons', await ev(`!!document.querySelector('#pager a.app .icon .emoji')`), false);
  await ev(`(async () => { await chrome.storage.sync.set({ emoji: true }); await new Promise(r => setTimeout(r, 600)); })()`);
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 1' }))[0]; editBookmark(nodes.get(n.id)); })()`);
  await click('#editor-emoji');
  await send('Input.insertText', { text: '🦊 fox' });
  await wait(200);
  check('Typing an emoji previews it', await ev(`({ preview: editorIcon.querySelector('.emoji')?.textContent, box: editorEmoji.value })`), { preview: '🦊', box: '🦊' });
  await click('#editor-form button[type=submit]');
  await wait(600);
  check('The chosen emoji shows on the bookmark', await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 1' }))[0];
    return document.querySelector('#pager a.app[data-id="' + n.id + '"] .emoji')?.textContent; })()`), '🦊');
  // The chooser: open with "Change icon…", pick the site's own icon, then a palette emoji.
  await ev(`(async () => { const n = (await chrome.bookmarks.search({ query: 'Site 2' }))[0]; const t = document.querySelector('#pager a.app[data-id="' + n.id + '"]');
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })); await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('#menu button')].find(b => b.textContent === 'Change icon…').click(); await new Promise(r => setTimeout(r, 300)); })()`);
  check('Change icon… opens a chooser with many options', await ev(`({ open: editor.open, count: iconChoices.children.length > 60, first: [...iconChoices.children].slice(0, 2).map(b => b.title),
    focusInChooser: iconChoices.contains(document.activeElement) })`), { open: true, count: true, first: ["Site's own icon", 'Letter'], focusInChooser: true });
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

  // ---- Settings: backup ----
  check('Backup file', await ev(`(async () => { let href; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { href = this.href; };
    document.getElementById('backup').click(); await new Promise(r => setTimeout(r, 400)); HTMLAnchorElement.prototype.click = orig;
    const d = JSON.parse(await (await fetch(href)).text()); return { app: d.app, tasks: d.tasks.length, wallpaper: d.settings.wallpaper }; })()`),
    { app: 'awesome-bookmarks', tasks: 3, wallpaper: 'meadow' });
  check('A non-backup file is refused', (await restore('not json')).status, "That file isn't an Awesome bookmarks backup.");
  check('A hostile backup is cleaned', await restore(JSON.stringify({ app: 'awesome-bookmarks', version: 1,
    settings: JSON.parse('{"__proto__":{"x":1},"cols":99,"wallpaper":"<img src=x>"}'),
    tasks: [{ id: '../evil', text: 'bad id' }, { id: 'ok1', text: '  Restored  ', done: 'yes', at: 1 }, { id: 'ok2', text: 'Done one', done: true, at: 2 }] })),
    { status: 'Restored 2 tasks and your settings.', tasks: ['Restored', 'Done one [x]'], cols: 0, wallpaper: 'meadow', polluted: null });
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
