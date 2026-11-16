const search = document.getElementById('search');
const empty = document.getElementById('empty');
const drawer = document.getElementById('drawer');
const drawerTitle = document.getElementById('drawer-title');
const back = document.getElementById('back');
const webSearch = document.getElementById('web-search');

let rootId = '0';
let bar = null; // "Bookmarks bar": the folder the home grid reorders into
let other = null; // "Other bookmarks": where the Dock folder lives
let dock = null; // the "Dock" folder, made the first time something is put in the Dock
const DOCK_TITLE = 'Dock';
let nodes = new Map(); // id -> bookmark node, rebuilt on every load
let topItems = [];
let stack = []; // folders opened inside the drawer, for the back button
let jiggle = false;
let g = null; // the pointer gesture in progress
let suppressClick = false; // a drag or long press must not also open the bookmark
let closing = false;

// Bookmark URLs are user data: only render schemes we can open safely (no javascript: bookmarklets).
const SCHEMES = ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'chrome-extension:'];
const scheme = url => { try { return new URL(url).protocol; } catch { return ''; } };
// chrome:// pages that act the moment they load (quit, restart, crash…) never open from a tile.
const CHROME_ACTIONS = /^chrome:\/\/(quit|restart|kill|hang|shorthang|crash|crashdump|gpuclean|gpucrash|gpuhang|memory-exhaust|memory-pressure-[a-z]+|inducebrowser[a-z]+|badcastcrash)\b/i;
const isSafe = url => SCHEMES.includes(scheme(url)) && !CHROME_ACTIONS.test(url);

// Ask for the largest copy Chrome has: 64px icons, doubled on Retina screens.
const FAVICON_SIZE = 64 * Math.min(2, Math.ceil(devicePixelRatio || 1));
const favicon = url => `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=${FAVICON_SIZE}`;
const hostname = url => { try { return new URL(url).hostname; } catch { return url; } };
// The Dock folder's bookmarks show in the Dock, so the grid and folder views leave that folder out.
const leaves = node => node.url ? (isSafe(node.url) ? [node] : []) : node.id === dock?.id ? [] : (node.children || []).flatMap(leaves);
const visible = nodes => nodes.filter(n => leaves(n).length);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Every JS animation goes through here so macOS "Reduce motion" turns them all off.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const animate = (el, frames, opts) => reduceMotion.matches ? null : el.animate(frames, opts);
const inside = (r, e) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;

// A 16x16 pixel fingerprint of an image. _favicon is same-origin, so the canvas stays readable.
function fingerprint(image) {
  const ctx = new OffscreenCanvas(16, 16).getContext('2d');
  ctx.drawImage(image, 0, 0, 16, 16);
  return ctx.getImageData(0, 0, 16, 16).data.join();
}

// Chrome hands back its grey globe for sites it has no icon for. Fingerprint the globe once
// (via an address that can't have an icon) so icons matching it can be swapped for a letter tile.
const globe = (async () => {
  const i = new Image();
  i.src = favicon('https://no-icon.invalid/');
  try { await i.decode(); return fingerprint(i); } catch { return null; }
})();

// "Gmail" -> "G" on a colour picked from the site's name, so a site always gets the same colour.
function letterTile(node) {
  const host = hostname(node.url).replace(/^www\./, '');
  const name = (node.title || host).trim() || '?';
  const span = document.createElement('span');
  span.className = 'letter';
  span.textContent = [...name][0].toUpperCase(); // [...] keeps emoji and accents whole
  span.style.setProperty('--hue', hue(host || name));
  return span;
}

// ---- Emoji icons ----
// Each bookmark gets an emoji that fits the site, picked from its address and name; unknown sites get
// one of a few neutral ones, always the same one for the same site. Checked in order: first match wins.
const EMOJI_RULES = [
  [/\b(mail|gmail|outlook|proton|yahoo mail)\b/, '📧'], [/\bcalendar\b/, '📅'],
  [/\b(docs|sheets|slides|notion|evernote|notes|confluence|keep|onenote|word|office)\b/, '📝'],
  [/\b(jira|linear|trello|asana|clickup|monday|todoist|basecamp)\b/, '✅'],
  [/\b(github|gitlab|bitbucket)\b/, '🐙'],
  [/\b(stackoverflow|stackexchange|mdn|developer|devdocs|readthedocs|npmjs|pypi|codepen|leetcode)\b/, '💻'],
  [/\b(chatgpt|openai|claude|anthropic|gemini|perplexity|copilot|huggingface|midjourney)\b/, '🤖'],
  [/\b(youtube|vimeo|twitch|netflix|primevideo|hotstar|disneyplus|hulu|max|jiocinema)\b/, '🎬'],
  [/\b(spotify|music|soundcloud|deezer|gaana|jiosaavn|tidal)\b/, '🎵'],
  [/\bmaps?\b/, '🗺️'], [/\b(drive|dropbox|icloud|onedrive|box|photos)\b/, '☁️'],
  [/\b(news|times|bbc|cnn|verge|guardian|reuters|ycombinator|hackernews|techcrunch|medium|substack)\b/, '📰'],
  [/\b(steam|steampowered|epicgames|xbox|playstation|nintendo|games?)\b/, '🎮'],
  [/\b(amazon|flipkart|ebay|etsy|myntra|shop|store|aliexpress|walmart|ikea)\b/, '🛒'],
  [/\b(bank|paypal|stripe|finance|money|invest|zerodha|groww|wallet|crypto|coinbase)\b/, '💰'],
  [/\b(twitter|x|facebook|instagram|reddit|linkedin|mastodon|threads|bsky|whatsapp|telegram|messenger)\b/, '💬'],
  [/\b(slack|discord|teams|zoom|meet|webex)\b/, '🗣️'],
  [/\b(wikipedia|wiki|britannica)\b/, '📖'], [/\b(figma|dribbble|behance|canva|design|sketch)\b/, '🎨'],
  [/\b(google|bing|duckduckgo|search)\b/, '🔎'], [/\bweather\b/, '⛅'],
  [/\b(airbnb|booking|expedia|flights?|travel|trip|makemytrip|uber|ola|irctc)\b/, '✈️'],
  [/\b(swiggy|zomato|doordash|ubereats|food|recipes?)\b/, '🍔'],
  [/\b(udemy|coursera|duolingo|khanacademy|edx|learn|course|school|university)\b/, '🎓'],
  [/\b(unsplash|flickr|pinterest|500px)\b/, '📷'], [/\b(health|doctor|fitness|strava|practo)\b/, '🩺'],
  [/\b(jobs?|careers?|indeed|naukri|glassdoor)\b/, '💼'],
  [/\b(vercel|netlify|aws|azure|heroku|cloudflare|digitalocean|firebase|supabase)\b/, '🚀'],
  [/\b(localhost|127\.0\.0\.1)\b/, '🛠️'],
];
const EMOJI_OTHER = ['🔖', '⭐', '📌', '💡', '🧭', '🪐', '🌈', '🍀', '🎯', '🧩', '🔷', '🌟'];
const hue = text => [...text].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7) % 360;

function emojiFor(node) {
  const s = scheme(node.url);
  if (s === 'chrome:' || s === 'chrome-extension:') return '⚙️';
  if (s === 'file:') return '📄';
  const host = hostname(node.url).replace(/^www\./, '');
  const text = `${host.replace(/\./g, ' ')} ${node.title || ''}`.toLowerCase();
  return EMOJI_RULES.find(([re]) => re.test(text))?.[1] || EMOJI_OTHER[hue(host || node.title || '') % EMOJI_OTHER.length];
}

function emojiTile(node, emoji = emojiFor(node)) {
  const span = document.createElement('span');
  span.className = 'emoji';
  span.textContent = emoji;
  span.style.setProperty('--hue', hue(hostname(node.url).replace(/^www\./, '') || node.title || ''));
  return span;
}

// Sites already found to have no icon: re-renders (every search keystroke) draw their letter
// straight away instead of flashing the globe again.
const noIcon = new Set();

// ---- Custom icons ---- (stored and checked in settings.js)
const ICON_SIZE = 128;
let icons = new Map();

// icon: a data URL or emoji to use, or null to go back to the default.
async function setIcon(id, icon) {
  const next = await readIcons();
  if (icon) next.set(id, icon); else next.delete(id);
  await chrome.storage.local.set({ icons: Object.fromEntries(next) });
  syncDrive(true);
}

// Decoding proves it's really an image; re-encoding keeps only the pixels, fitted (not cropped) into a square.
async function iconFromFile(file) {
  if (file.size > 10 * 1024 * 1024) throw new RangeError('too big');
  const bitmap = await createImageBitmap(file);
  const scale = ICON_SIZE / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (ICON_SIZE - w) / 2, (ICON_SIZE - h) / 2, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  if (url.length > MAX_ICON_URL || !ICON_RE.test(url)) throw new TypeError('not usable');
  return url;
}

// A chosen picture fills the tile; a chosen emoji sits on the same soft tile as automatic ones.
function customIcon(node, custom) {
  if (custom === 'site') return node.url ? img({ ...node, id: undefined }) : letterTile(node);
  if (custom === 'letter') return letterTile(node);
  if (!isPicture(custom)) return emojiTile(node, custom);
  const i = document.createElement('img');
  i.className = 'custom';
  i.src = custom;
  i.alt = '';
  i.draggable = false;
  return i;
}

function img(node) {
  if (icons.has(node.id)) return customIcon(node, icons.get(node.id));
  if (settings.emoji && node.id) return emojiTile(node); // bookmarks only: not history rows or frequent sites
  if (noIcon.has(node.url)) return letterTile(node);
  const i = document.createElement('img');
  i.src = favicon(node.url);
  i.alt = '';
  i.loading = 'lazy';
  i.draggable = false;
  const useLetter = () => { noIcon.add(node.url); i.replaceWith(letterTile(node)); };
  i.onerror = useLetter;
  i.onload = async () => {
    const g = await globe;
    try { if (g && fingerprint(i) === g) useLetter(); } catch { /* unreadable: keep the icon */ }
  };
  return i;
}

// file:// needs the user to switch on "Allow access to file URLs" for the extension; say so instead of doing nothing.
// newTab: open in a background tab, like Chrome's own "Open in new tab".
async function openViaApi(url, newTab = false) {
  if (scheme(url) === 'file:' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    if (confirm('To open files from bookmarks, turn on "Allow access to file URLs" for Awesome bookmarks.\n\nOpen that setting now?')) {
      chrome.tabs.update({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    }
    return;
  }
  if (newTab) chrome.tabs.create({ url, active: false });
  else chrome.tabs.update({ url });
}

function tile(node) {
  const el = document.createElement(node.url ? 'a' : 'button');
  const icon = document.createElement('div');
  const label = document.createElement('span');
  el.className = 'app';
  el.dataset.id = node.id;
  el.draggable = false; // we run our own drag; the browser's link drag would fight it
  el.title = node.title || node.url || '';
  label.textContent = node.title || hostname(node.url);

  if (node.url) {
    const del = document.createElement('span');
    del.className = 'delete';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', `Delete ${label.textContent}`);
    del.textContent = '×';
    el.href = node.url;
    el.setAttribute('aria-keyshortcuts', 'Delete');
    icon.className = 'icon';
    icon.append(img(node), del);
    // Pages can't link to chrome:// or file:// directly; the extension API can.
    if (['chrome:', 'file:'].includes(scheme(node.url))) {
      el.onclick = e => { e.preventDefault(); openViaApi(node.url); };
    }
  } else {
    icon.className = 'icon folder';
    for (const b of leaves(node).slice(0, 9)) icon.append(img(b));
    el.onclick = () => openFolder(node, el);
  }

  el.append(icon, label);
  return el;
}

// A row of pages with dots. Used twice: the home grid and the open folder.
class Pager {
  // grid: optional () => [cols, rows] from settings, 0 meaning automatic
  constructor(root, dots, { cell, maxRows, fit = false, grid }) {
    Object.assign(this, { root, dots, cell, maxRows, fit, grid, track: root.querySelector('.track'), page: 0, size: 1, items: [], tiles: new Map() });
    root.addEventListener('pointerdown', e => pointerDown(e, this));
    root.addEventListener('wheel', e => this.wheel(e), { passive: false });
    // Tabbing onto a tile on another page: slide that page into view.
    root.addEventListener('focusin', e => {
      const i = this.items.indexOf(this.nodeOf(e.target.closest('.app') || root));
      if (i >= 0) this.go(Math.floor(i / this.size));
    });
  }

  // parent: the folder that reordering moves bookmarks within; sortable: false for search results.
  // Tiles are kept between calls (a search keystroke only rearranges them); load() clears them when bookmarks change.
  set(items, parent, sortable) {
    Object.assign(this, { items: [...items], parent, sortable });
    this.layout();
  }

  tileFor(node) {
    if (!this.tiles.has(node.id)) this.tiles.set(node.id, tile(node));
    return this.tiles.get(node.id);
  }

  nodeOf(el) {
    return this.items.find(n => n.id === el.dataset.id);
  }

  // Launchpad's grid is 7x5; shrink it when the space can't fit that. A folder grows to fit its items.
  pageSize() {
    const [wantCols, wantRows] = this.grid?.() || [];
    const w = this.width || this.root.clientWidth, h = this.root.clientHeight; // width: set by the Dock, whose own width is still easing
    const cols = wantCols || clamp(Math.floor(w / this.cell), 3, 7);
    const rows = this.fit
      ? clamp(Math.ceil(this.items.length / cols), 1, this.maxRows)
      : wantRows || clamp(Math.floor(h / this.cell), 2, this.maxRows);
    if (this.fit) this.root.style.height = `${rows * this.cell}px`;
    // Size icons to their cells, so a dense custom grid still fits the window.
    if (this.grid) this.root.style.setProperty('--icon', `${clamp(Math.min(w / cols * .62, h / rows * .66), 36, 88)}px`);
    this.root.style.setProperty('--cols', cols);
    this.root.style.setProperty('--rows', rows);
    return cols * rows;
  }

  // slide: move tiles from their old spots to their new ones (FLIP), used while dragging
  layout(slide = false) {
    const before = slide && new Map(this.items.map(n => [n.id, this.tileFor(n).getBoundingClientRect()]));
    this.size = this.pageSize();
    const pages = [];
    for (let i = 0; i < this.items.length; i += this.size) {
      const p = document.createElement('div');
      p.className = 'page';
      p.append(...this.items.slice(i, i + this.size).map(n => this.tileFor(n)));
      pages.push(p);
    }
    this.track.replaceChildren(...pages);
    this.dots.replaceChildren(...(pages.length > 1 ? pages.map((_, i) => this.dot(i)) : []));
    this.go(this.page);

    if (!before) return;
    for (const n of this.items) {
      const el = this.tileFor(n), a = before.get(n.id), b = el.getBoundingClientRect();
      const dx = a && a.left - b.left, dy = a && a.top - b.top;
      if (a && (dx || dy) && Math.abs(dx) < this.root.clientWidth) {
        animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
      }
    }
  }

  dot(i) {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `Page ${i + 1}`);
    b.onclick = () => this.go(i);
    return b;
  }

  go(i) {
    const last = this.track.children.length - 1, prev = this.page;
    this.page = clamp(i, 0, Math.max(0, last));
    this.track.style.transition = '';
    this.track.style.transform = `translateX(${-this.page * 100}%)`;
    [...this.dots.children].forEach((d, j) => d.setAttribute('aria-current', j === this.page));
    // Asked to go past the first/last page: a small spring bounce instead.
    if (last >= 0 && i !== this.page) {
      animate(this.track, [{ translate: '0' }, { translate: `${i < 0 ? 40 : -40}px` }, { translate: '0' }], { duration: 350, easing: 'ease-out' });
    }
    // The icons on the arriving page settle in gently.
    if (this.page !== prev) {
      animate(this.track.children[this.page], [{ scale: .94, opacity: .4 }, { scale: 1, opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }

  // Follow a finger/mouse; past the first or last page it stretches like a rubber band.
  drag(dx) {
    const last = this.track.children.length - 1;
    if ((this.page === 0 && dx > 0) || (this.page >= last && dx < 0)) dx /= 3;
    this.track.style.transition = 'none';
    this.track.style.transform = `translateX(calc(${-this.page * 100}% + ${dx}px))`;
  }

  release(dx, fast) {
    const turn = Math.abs(dx) > this.root.clientWidth * 0.2 || (fast && Math.abs(dx) > 30);
    const next = this.page - (turn ? Math.sign(dx) : 0);
    this.go(clamp(next, 0, this.track.children.length - 1)); // no extra bounce: the rubber band already showed it
  }

  wheel(e) {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Trackpad swipe: follow the fingers, turn at most one page per gesture (momentum included).
      clearTimeout(this.wheelEnd);
      this.wheelEnd = setTimeout(() => { if (!this.swiped) this.release(this.dx, false); this.dx = 0; this.swiped = false; }, 150);
      if (this.swiped) return;
      this.dx = (this.dx || 0) - e.deltaX;
      if (Math.abs(this.dx) > this.root.clientWidth * 0.25) {
        this.swiped = true;
        this.go(this.page - Math.sign(this.dx));
      } else this.drag(this.dx);
    } else if (Math.abs(e.deltaY) > 4 && Date.now() > (this.wheelLock || 0)) {
      // Mouse wheel (or vertical trackpad scroll): one page per notch.
      this.wheelLock = Date.now() + 400;
      this.go(this.page + Math.sign(e.deltaY));
    }
  }
}

let settings = DEFAULTS;
const main = new Pager(document.getElementById('pager'), document.getElementById('dots'), { cell: 130, maxRows: 5, grid: () => [settings.cols, settings.rows] });
const folder = new Pager(document.getElementById('folder-pager'), document.getElementById('folder-dots'), { cell: 116, maxRows: 3, fit: true });
const activePager = () => drawer.open ? folder : dockEl.contains(document.activeElement) ? dockPager : main;

// ---- Dock ----
// A one-row Pager, so dragging into, out of and around it uses the same code as the grid.
const dockEl = document.getElementById('dock');
class DockPager extends Pager {
  tileFor(node) {
    const t = super.tileFor(node);
    t.removeAttribute('title'); // the Dock shows its own label above the icon
    return t;
  }
}
const dockPager = new DockPager(dockEl, document.getElementById('dock-dots'), {
  cell: 84, maxRows: 1,
  // One column per icon; the Dock is exactly as wide as its icons, shrinking them when there are many.
  grid: () => {
    const n = Math.max(dockPager.items.length, 1);
    // The page's width, less the Tasks panel when it's open. Measured on the page, not the icon grid:
    // the grid is hidden (0 wide) in list view.
    const body = getComputedStyle(document.body);
    const w = document.body.clientWidth - parseFloat(body.paddingLeft) - parseFloat(body.paddingRight);
    const room = w > 700 ? w - 228 : w; // clear of the corner buttons
    dockPager.width = n * clamp(room / n, 58, 84);
    dockEl.style.width = `${dockPager.width}px`;
    return [n, 1];
  },
});

async function dockFolder() {
  return dock ||= await chrome.bookmarks.create({ parentId: other.id, title: DOCK_TITLE });
}

// Magnification: icons near the pointer swell, like the macOS Dock. Distances are measured from where
// the icons sat before growing, so the swelling never feeds back into itself.
// The shelf stretches by however much the icons grew, so they stay on it.
let dockCentres = [], dockWidth = 0;
dockEl.addEventListener('pointerenter', () => {
  dockWidth = parseFloat(dockEl.style.width) || dockEl.offsetWidth; // the resting width, even if it's still easing back
  dockCentres = [...dockEl.querySelectorAll('.app')].map(a => { const r = a.getBoundingClientRect(); return [a, r.left + r.width / 2]; });
});
// At most once a frame: a fast mouse sends several moves per frame, each of which would restart the easing.
let dockX = null;
dockEl.addEventListener('pointermove', e => {
  if (g || reduceMotion.matches || !dockWidth) return;
  if (dockX === null) requestAnimationFrame(magnify);
  dockX = e.clientX;
});
function magnify() {
  const x0 = dockX;
  dockX = null;
  if (g || !dockWidth) return;
  const icon = parseFloat(dockEl.style.getPropertyValue('--icon'));
  let extra = 0;
  for (const [a, x] of dockCentres) {
    const grow = 1 + .5 * Math.max(0, 1 - Math.abs(x0 - x) / 150);
    a.style.setProperty('--grow', grow);
    extra += (grow - 1) * icon;
  }
  dockEl.style.width = `${dockWidth + extra}px`;
}
function unmagnify() {
  for (const [a] of dockCentres) a.style.removeProperty('--grow');
  if (dockWidth) dockEl.style.width = `${dockWidth}px`;
  dockCentres = [];
  dockWidth = 0;
}
dockEl.addEventListener('pointerleave', unmagnify);

// ---- Keyboard ----

// How far each arrow moves within a grid of `cols` columns. Pages hold whole rows,
// so stepping off a page's edge lands on the neighbouring page.
const step = (key, cols) => ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols })[key];
const cols = p => +p.root.style.getPropertyValue('--cols');

function focusTile(p, key) {
  const cur = p.items.findIndex(n => p.tiles.get(n.id) === document.activeElement);
  // Nothing selected on this page yet: the first arrow press selects its first icon, like Launchpad.
  const i = cur < 0 || Math.floor(cur / p.size) !== p.page ? p.page * p.size : clamp(cur + step(key, cols(p)), 0, p.items.length - 1);
  if (!p.items[i]) return;
  p.go(Math.floor(i / p.size));
  p.tileFor(p.items[i]).focus({ preventScroll: true });
}

// Search keeps the caret in the box, so its "selection" is a highlight, not focus.
let highlighted = -1;
function highlight(i) {
  main.tiles.get(main.items[highlighted]?.id)?.classList.remove('selected');
  highlighted = main.items.length ? clamp(i, 0, main.items.length - 1) : -1;
  if (highlighted < 0) return;
  main.tiles.get(main.items[highlighted].id).classList.add('selected');
  main.go(Math.floor(highlighted / main.size));
}

// ---- Folders ----

// Grow the drawer out of the folder icon (or shrink back into it).
function zoom(fromTile, reverse) {
  const a = fromTile.querySelector('.icon').getBoundingClientRect(), b = drawer.getBoundingClientRect();
  const frames = [
    { transform: `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width})`, opacity: 0 },
    { transform: 'none', opacity: 1 },
  ];
  return animate(drawer, reverse ? frames.reverse() : frames, { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: reverse ? 'forwards' : 'none' });
}

function openFolder(node, fromTile) {
  stack.push(node);
  folder.page = 0;
  if (drawer.open) return showFolder();
  drawer.showModal();
  showFolder();
  // showModal focuses the title; start on the first bookmark instead (the title is for renaming, by click).
  folder.root.querySelector('.app')?.focus({ preventScroll: true });
  if (document.activeElement === drawerTitle) drawerTitle.blur();
  if (fromTile) zoom(fromTile);
}

function showFolder() {
  const node = stack.at(-1);
  if (document.activeElement !== drawerTitle) drawerTitle.value = node.title || 'Folder';
  drawerTitle.readOnly = node.parentId === rootId; // Chrome's own root folders can't be renamed
  back.hidden = stack.length < 2;
  folder.set(visible(node.children), node, true);
  // Open all: only for the bookmarks directly in this folder (like Chrome's own), hidden when there are none.
  const count = node.children.filter(n => n.url && isSafe(n.url)).length;
  openAllButton.hidden = !count;
  openAllButton.title = `Open ${count} bookmark${count === 1 ? '' : 's'} in new tabs`;
}

const openAllButton = document.getElementById('open-all');
openAllButton.onclick = () => openAll(stack.at(-1)).catch(console.error);

// Every bookmark directly in the folder, in background tabs, so this page stays put.
async function openAll(node) {
  const urls = node.children.filter(n => n.url && isSafe(n.url)).map(n => n.url);
  if (urls.length > 10 && !confirm(`Open ${urls.length} tabs?`)) return;
  const isFile = url => scheme(url) === 'file:';
  const fileAccess = !urls.some(isFile) || await chrome.extension.isAllowedFileSchemeAccess();
  for (const url of urls) if (fileAccess || !isFile(url)) chrome.tabs.create({ url, active: false });
  if (!fileAccess) openViaApi(urls.find(isFile)); // explains how to allow file links, once
}

// Close the panel and forget its folders in the same step. (The dialog's own "close" event arrives
// later, sometimes after another folder has already been opened, so it can't be trusted to reset this.)
function hideDrawer() {
  stack = [];
  drawer.close();
}

async function closeFolder(shrink = true) {
  if (!drawer.open || closing) return;
  const from = shrink && main.tiles.get(stack[0]?.id);
  const a = from?.isConnected && zoom(from, true);
  if (a) {
    closing = true;
    drawer.classList.add('closing');
    await a.finished;
    drawer.classList.remove('closing');
    hideDrawer();
    a.cancel();
    closing = false;
  } else hideDrawer();
}

function renameFolder() {
  const node = stack.at(-1);
  const title = drawerTitle.value.trim().slice(0, 255);
  if (!node || drawerTitle.readOnly || !title || title === node.title) {
    drawerTitle.value = node?.title || '';
    return;
  }
  chrome.bookmarks.update(node.id, { title }).catch(err => { console.error(err); load(); });
}

// "google.com" + "mail.google.com" -> "Google"; otherwise a plain name the user can change.
function folderName(a, b) {
  const site = url => hostname(url).replace(/^www\./, '').split('.').slice(-2, -1)[0] || '';
  const s = site(a.url);
  return s && s === site(b.url) ? s[0].toUpperCase() + s.slice(1) : 'New Folder';
}

// Launchpad drops a folder once its last item leaves. Chrome's root folders always stay.
// Returns true when it removed the folder.
async function removeIfEmpty(id) {
  const f = nodes.get(id);
  if (!f || f.url || id === rootId || f.parentId === rootId) return false;
  if ((await chrome.bookmarks.getChildren(id)).length) return false;
  await chrome.bookmarks.remove(id);
  return true;
}

// ---- Delete, with Undo ----
// No "are you sure?": deleting is instant and a message offers Undo for a few seconds, like Launchpad.
// Chrome has no undo for bookmarks, so we keep a copy and re-create it (it gets new ids).

const toast = document.getElementById('toast');
let undoLast = null, toastTimer;

const copyOf = n => ({ title: n.title, url: n.url, icon: icons.get(n.id), children: n.children?.map(copyOf) });

async function recreate(c, parentId, index) {
  const made = await chrome.bookmarks.create({ parentId, index, title: c.title, url: c.url });
  if (c.icon) await setIcon(made.id, c.icon); // the new copy has a new id: its picture goes with it
  for (const child of c.children || []) await recreate(child, made.id);
}

async function removeNode(node) {
  const parent = nodes.get(node.parentId), copy = copyOf(node);
  if (node.url) await chrome.bookmarks.remove(node.id);
  else await chrome.bookmarks.removeTree(node.id); // load() then drops it from an open folder view
  const parentGone = await removeIfEmpty(node.parentId); // its folder emptied and went too: Undo brings both back
  offerUndo(`Deleted “${node.title || hostname(node.url)}”`, async () => {
    const parentId = parentGone
      ? (await chrome.bookmarks.create({ parentId: parent.parentId, index: parent.index, title: parent.title })).id
      : node.parentId;
    // Things may have moved meanwhile: back to its old spot, or the end if that's gone.
    const index = Math.min(node.index, (await chrome.bookmarks.getChildren(parentId)).length);
    await recreate(copy, parentId, index);
  });
}
const removeOrReload = node => removeNode(node).catch(err => { console.error(err); load(); });

function showToast() {
  // Inside an open folder everything outside the dialog is inert, so the message has to live in it (like the menu).
  const host = drawer.open ? drawer : document.body;
  if (toast.parentElement !== host) host.append(toast); // moving a popover closes it
  if (!toast.matches(':popover-open')) toast.showPopover();
}

function offerUndo(text, undo) {
  undoLast = undo;
  toast.querySelector('span').textContent = text;
  showToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() {
  undoLast = null;
  clearTimeout(toastTimer);
  if (toast.matches(':popover-open')) toast.hidePopover();
}

async function undo() {
  const run = undoLast;
  hideToast();
  if (run) await run().catch(err => { console.error(err); load(); });
}
toast.querySelector('button').onclick = undo;
// The folder closed while the message was up: bring it back out onto the home grid.
drawer.addEventListener('close', () => { if (undoLast) showToast(); });

// ---- Add / edit form ----

const editor = document.getElementById('editor');
const editorName = document.getElementById('editor-name');
const editorUrl = document.getElementById('editor-url');
const editorError = document.getElementById('editor-error');
const editorIcon = document.getElementById('editor-icon');
const editorIconFile = document.getElementById('editor-icon-file');
const editorIconReset = document.getElementById('editor-icon-reset');
const editorEmoji = document.getElementById('editor-emoji');
const iconChoices = document.getElementById('icon-choices');
const iconField = document.getElementById('editor-icon-field');
const uploadGlyph = document.getElementById('upload-glyph').content.firstElementChild;
// The picture chosen in this dialog: undefined = leave as is, null = back to the site's icon, or a data URL.
let editorIconChoice, editorNode;

// What a bookmark shows with nothing chosen: its emoji, or the site's icon when emoji icons are off.
const defaultIcon = node => settings.emoji ? emojiTile(node) : node.url ? img({ ...node, id: undefined }) : letterTile(node);

// A few dozen to pick from; the ones that suit this site come first.
const ICON_PALETTE = ['🔖', '⭐', '📌', '💡', '🧭', '🎯', '🧩', '🌈', '🍀', '🪐', '🔷', '🌟',
  '🏠', '🏢', '💼', '📊', '📈', '🗂️', '📁', '📝', '✅', '📅', '📧', '💬', '🗣️', '📞',
  '💻', '🖥️', '📱', '🐙', '🛠️', '⚙️', '🔧', '🧪', '🤖', '🧠', '🚀', '☁️', '🔒', '🔑',
  '📰', '📖', '📚', '🎓', '✏️', '🔎', '🗺️', '✈️', '🧳', '🏖️', '🚗', '⛅',
  '🎬', '📺', '🎵', '🎧', '🎮', '📷', '🎨', '🎉', '🎁', '🏆', '⚽', '🏏',
  '🛒', '🛍️', '💰', '💳', '🏦', '🪙', '🍔', '🍕', '☕', '🍎', '🩺', '💊', '🧘', '❤️',
  '🔥', '⚡', '🌍', '🌙', '☀️', '🌸', '🌳', '🐶', '🐱', '🦊', '🐼', '👶'];

function showEditorIcon() {
  const node = { ...editorNode, url: typedUrl(editorUrl.value) || editorNode.url || '' };
  const custom = editorIconChoice === undefined ? icons.get(node.id) : editorIconChoice;
  editorIcon.replaceChildren(custom ? customIcon(node, custom) : defaultIcon(node));
  editorIconReset.hidden = !custom;
  editorEmoji.value = custom && oneEmoji(custom) === custom ? custom : '';
  showIconChoices(node, custom);
}

// The chooser: upload an image, your picture (if one is chosen), the site's own icon, its letter,
// then emoji (this site's suggestion first). Click to pick.
function showIconChoices(node, current) {
  const suggested = emojiFor(node);
  const picture = current && isPicture(current) ? [current] : [];
  const values = [...picture, 'site', 'letter', suggested, ...ICON_PALETTE.filter(e => e !== suggested)];
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.className = 'choice upload';
  upload.title = 'Upload an image (or paste or drop one here)';
  upload.setAttribute('aria-label', 'Upload an image');
  upload.append(uploadGlyph.cloneNode(true));
  upload.onclick = () => editorIconFile.click();
  iconChoices.replaceChildren(upload, ...values.map(v => {
    const b = document.createElement('button');
    const tile = document.createElement('span');
    b.type = 'button';
    b.className = 'choice';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', v === current);
    b.title = v === 'site' ? "Site's own icon" : v === 'letter' ? 'Letter' : isPicture(v) ? 'Your image' : v;
    b.setAttribute('aria-label', b.title);
    tile.className = 'icon';
    tile.append(customIcon(node, v));
    b.append(tile);
    b.onclick = () => {
      editorIconChoice = v;
      const keep = iconChoices.scrollTop;
      showEditorIcon();
      iconChoices.scrollTop = keep;
      iconChoices.querySelector('[aria-selected="true"]')?.focus();
    };
    return b;
  }));
}
// Type or paste an emoji (Ctrl+Cmd+Space on a Mac opens the emoji picker).
editorEmoji.addEventListener('input', () => {
  const emoji = oneEmoji(editorEmoji.value);
  if (!emoji) return;
  editorIconChoice = emoji;
  showEditorIcon();
});
editorIconFile.onchange = () => {
  const file = editorIconFile.files[0];
  editorIconFile.value = '';
  useIconFile(file);
};
// A pasted or dropped image works like an uploaded one; pasting text into the fields is untouched.
const imageIn = files => [...files].find(f => f.type.startsWith('image/'));
editor.addEventListener('paste', e => {
  const file = imageIn(e.clipboardData.files);
  if (file && !iconField.hidden) { e.preventDefault(); useIconFile(file); }
});
editor.addEventListener('dragover', e => { if (!iconField.hidden && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
editor.addEventListener('drop', e => {
  const file = imageIn(e.dataTransfer.files);
  if (!file || iconField.hidden) return;
  e.preventDefault();
  useIconFile(file);
});
async function useIconFile(file) {
  if (!file) return;
  try {
    editorIconChoice = await iconFromFile(file);
    editorError.hidden = true;
  } catch (err) {
    console.error(err);
    editorError.textContent = err instanceof RangeError
      ? 'That image is over 10 MB. Please choose a smaller one.'
      : "Couldn't use that file. Please choose a PNG, JPEG, WebP or GIF image.";
    editorError.hidden = false;
  }
  showEditorIcon();
}
editorIconReset.onclick = () => { editorIconChoice = null; showEditorIcon(); };
let editorSave = null; // what Save does for the form currently open

// The address's own error, under it (the form-wide one is for saving failures).
const urlError = document.getElementById('editor-url-error');
function showUrlError(message) {
  urlError.textContent = message;
  urlError.hidden = !message;
  if (message) editorUrl.setAttribute('aria-invalid', 'true'); else editorUrl.removeAttribute('aria-invalid');
}
const urlProblem = text => !text.trim() ? 'Enter an address, like example.com.'
  : typedUrl(text) ? '' : "That doesn't look like a web address. Try something like example.com.";
editorUrl.addEventListener('input', () => showUrlError(''));
editorUrl.addEventListener('change', () => {
  if (editorUrl.value.trim()) showUrlError(urlProblem(editorUrl.value)); // empty: only on Save
  showEditorIcon(); // a new address: preview its site icon
  nameFromHistory().catch(console.error);
});

// An empty name gets the page's title from your history, if you've allowed history access (no new permission).
async function nameFromHistory() {
  const url = typedUrl(editorUrl.value);
  if (!url || editorName.value.trim() || !await chrome.permissions.contains({ permissions: ['history'] })) return;
  const hit = (await chrome.history.search({ text: hostname(url), startTime: 0, maxResults: 100 })).find(h => h.url === url);
  if (hit?.title && !editorName.value.trim() && typedUrl(editorUrl.value) === url) editorName.value = hit.title.slice(0, 255);
}

// What the user typed, as a URL we're willing to store: "example.com" gets https://,
// and only the schemes we can open are accepted (never javascript:).
function typedUrl(text) {
  const s = text.trim();
  if (!s || /\s/.test(s)) return null; // a space inside is a typo, never part of a real address
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  return isSafe(url) ? new URL(url).href : null; // isSafe also rejects anything that doesn't parse
}

// fields: { title, url }; withUrl false for folders (name only). onSave gets { title, url }.
function openEditor(heading, fields, withUrl, onSave) {
  document.getElementById('editor-heading').textContent = heading;
  document.getElementById('editor-url-field').hidden = !withUrl;
  editorName.value = fields.title || '';
  editorUrl.value = fields.url || '';
  editorName.placeholder = withUrl ? 'The site name, if left empty' : '';
  document.querySelector('#editor-name-label .optional').hidden = !withUrl; // a folder's name is the whole form
  document.getElementById('icon-more').open = false;
  editorError.hidden = true;
  showUrlError('');
  editorSave = onSave;
  // Bookmarks get an icon row; folders show their contents instead.
  document.getElementById('editor-icon-field').hidden = !withUrl;
  editorNode = fields;
  editorIconChoice = undefined;
  if (withUrl) showEditorIcon();
  editor.showModal();
  const first = withUrl && !fields.url ? editorUrl : editorName;
  first.focus();
  first.select();
}

document.getElementById('editor-form').addEventListener('submit', async e => {
  e.preventDefault();
  const title = editorName.value.trim();
  const withUrl = !editor.querySelector('#editor-url-field').hidden;
  const problem = withUrl && urlProblem(editorUrl.value);
  if (problem) {
    showUrlError(problem);
    editorUrl.focus();
    return;
  }
  const url = withUrl ? typedUrl(editorUrl.value) : undefined;
  try {
    await editorSave({ title, url, icon: editorIconChoice });
    editor.close();
  } catch (err) {
    console.error(err);
    editorError.textContent = "Couldn't save that. Please try again.";
    editorError.hidden = false;
  }
});
document.getElementById('editor-cancel').onclick = () => editor.close();

const addBookmark = parent => openEditor('Add bookmark', {}, true, async ({ title, url, icon }) => {
  const made = await chrome.bookmarks.create({ parentId: parent.id, title: title || hostname(url), url });
  if (icon) await setIcon(made.id, icon);
});
const editBookmark = node => openEditor('Edit bookmark', node, true, async ({ title, url, icon }) => {
  if (icon !== undefined) await setIcon(node.id, icon);
  await chrome.bookmarks.update(node.id, { title: title || hostname(url), url });
});
const renameFolderNode = node => openEditor('Rename folder', node, false,
  ({ title }) => title && title !== node.title && chrome.bookmarks.update(node.id, { title }));

// Add into the open folder, or the Bookmarks bar from the home grid.
const addHere = () => addBookmark(drawer.open ? stack.at(-1) : bar);
document.getElementById('add').onclick = addHere;
document.getElementById('folder-add').onclick = addHere;

// ---- Right-click menu ----

const menu = document.getElementById('menu');

// items: [label, action, destructive?]
function showMenu(items, x, y) {
  menu.replaceChildren(...items.map(([label, run, danger]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('role', 'menuitem');
    if (danger) b.className = 'danger';
    b.onclick = () => { menu.hidePopover(); run(); };
    return b;
  }));
  // Inside an open folder everything outside the dialog is inert, so the menu has to live in it.
  (drawer.open ? drawer : document.body).append(menu);
  menu.showPopover();
  menu.style.left = `${clamp(x, 8, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${clamp(y, 8, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('button').focus();
}

// Up/down move through the items; keep those keys away from the grid underneath.
menu.addEventListener('keydown', e => {
  if (e.key !== 'Escape') e.stopPropagation();
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...menu.children], i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

document.addEventListener('contextmenu', e => {
  if (e.target.closest('input, #editor, #importer, #menu, #tasks') || g) return; // text fields and panels keep the normal menu
  e.preventDefault();
  const el = e.target.closest('.app, .list-row'), node = el && nodes.get(el.dataset.id);
  let { clientX: x, clientY: y } = e;
  if (el && !x && !y) { const r = el.getBoundingClientRect(); [x, y] = [r.left + r.width / 2, r.top + r.height / 2]; } // from the keyboard
  if (!node) return showMenu([['Add bookmark…', addHere]], x, y);
  const dockItem = node.parentId === dock?.id
    ? ['Remove from Dock', () => chrome.bookmarks.move(node.id, { parentId: bar.id }).catch(console.error)]
    : ['Keep in Dock', () => toDock(node).catch(err => { console.error(err); load(); })];
  const moveItem = ['Move to…', () => showMenu(moveTargets(node), x, y)];
  if (node.url) {
    return showMenu([
      ['Open in new tab', () => openViaApi(node.url, true)],
      dockItem,
      moveItem,
      ['Edit…', () => editBookmark(node)],
      ['Change icon…', () => { editBookmark(node); document.getElementById('icon-more').open = true; (iconChoices.querySelector('[aria-selected="true"]') || iconChoices.firstChild)?.focus(); }],
      ['Copy link', () => navigator.clipboard.writeText(node.url).catch(console.error)],
      ['Delete', () => removeOrReload(node), true],
    ], x, y);
  }
  const ownFolder = node.parentId !== rootId; // Chrome's root folders can't be renamed or deleted
  showMenu([
    ['Open', () => openFolder(node, el)],
    ...(ownFolder ? [dockItem, moveItem, ['Rename…', () => renameFolderNode(node)], ['Delete folder', () => removeOrReload(node), true]] : []),
  ], x, y);
});

// "Move to…": every folder in the Bookmarks bar and Other bookmarks, indented by depth — the keyboard's
// way to do what dragging does. Not the one it's already in, not the Dock, not itself or its own subfolders.
function moveTargets(node) {
  const items = [];
  const walk = (f, depth) => {
    if (f.id === node.id || f.id === dock?.id) return;
    if (f.id !== node.parentId) items.push([`${' '.repeat(depth)}${f.title || 'Folder'}`, () => chrome.bookmarks.move(node.id, { parentId: f.id }).catch(console.error)]);
    for (const c of f.children || []) if (!c.url) walk(c, depth + 1);
  };
  for (const root of [bar, other]) if (root) walk(root, 0);
  return items.length ? items : [['No other folders', () => {}]];
}

async function toDock(node) {
  const oldParent = node.parentId;
  await chrome.bookmarks.move(node.id, { parentId: (await dockFolder()).id });
  await removeIfEmpty(oldParent);
}

function setJiggle(on) {
  jiggle = on;
  document.body.classList.toggle('jiggle', on);
}

// ---- Gestures: drag icons, drag pages, long press ----

function pointerDown(e, pager) {
  if (e.button !== 0 || g || e.target.closest('.delete, input')) return;
  const el = e.target.closest('.app');
  g = { pager, el, node: el && pager.nodeOf(el), x0: e.clientX, y0: e.clientY, t0: Date.now() };
  if (el) g.hold = setTimeout(() => { suppressClick = true; setJiggle(true); }, 550);
}

function startDrag() {
  unmagnify(); // drop positions are worked out from the Dock's resting layout
  const icon = g.el.querySelector('.icon'), r = icon.getBoundingClientRect();
  // Where on the icon it was grabbed: from the press, not this first move (which may be far off already).
  g.offX = g.x0 - r.left;
  g.offY = g.y0 - r.top;
  g.iconSize = icon.offsetWidth; // its size right now, hover growth included: the ghost matches it
  g.start = { pager: g.pager, index: g.pager.items.indexOf(g.node) };
  // A popover sits in the top layer, so the ghost shows above the open folder too.
  g.ghost = icon.cloneNode(true);
  g.ghost.classList.add('ghost');
  // The grid's base icon size (not the page default); the ghost's own --grow lifts it to the hovered size.
  g.ghost.style.setProperty('--icon', getComputedStyle(g.el).getPropertyValue('--icon'));
  g.ghost.popover = 'manual';
  document.body.append(g.ghost);
  g.ghost.showPopover();
  g.el.classList.add('dragging');
}

function clearHover(d = g) {
  clearTimeout(d.hover?.timer);
  d.hover = d.merge = null;
  document.querySelector('.app.merge')?.classList.remove('merge');
}

// Move the dragged icon into grid position `slot`; the others slide aside.
function moveTo(p, slot) {
  p.items.splice(p.items.indexOf(g.node), 1);
  p.items.splice(slot, 0, g.node);
  p.layout(true);
}

// Which grid cell (as an index into p.items) the point is over, or -1 off the grid.
// Pure geometry from the grid's rows and columns, so tiles sliding around never change the answer.
// Empty cells after the last icon count as the last position.
function slotAt(p, x, y) {
  const page = p.track.children[p.page];
  if (!page || !inside(p.root.getBoundingClientRect(), { clientX: x, clientY: y })) return -1;
  const r = page.getBoundingClientRect(), pad = parseFloat(getComputedStyle(page).paddingLeft);
  const c = cols(p), rows = +p.root.style.getPropertyValue('--rows');
  const col = clamp(Math.floor((x - r.left - pad) / ((r.width - 2 * pad) / c)), 0, c - 1);
  const row = clamp(Math.floor((y - r.top) / (r.height / rows)), 0, rows - 1);
  return Math.min(p.page * p.size + row * c + col, p.items.length - 1);
}

function moveDrag(e) {
  g.ghost.style.translate = `${e.clientX - g.offX}px ${e.clientY - g.offY}px`;
  let p = g.pager;

  // Dragged out of an open folder: carry it onto the home grid.
  if (p === folder && !inside(drawer.getBoundingClientRect(), e)) {
    p.items.splice(p.items.indexOf(g.node), 1);
    closeFolder(false);
    clearHover();
    clearInterval(g.edgeTimer);
    g.edge = 0;
    p = g.pager = main;
    p.items.splice(Math.min(p.items.length, (p.page + 1) * p.size), 0, g.node);
    g.el = p.tileFor(g.node);
    g.el.classList.add('dragging');
    p.layout(true);
  }

  // Between the home grid and the Dock: whichever the pointer is over takes the icon.
  const overDock = inside(dockEl.getBoundingClientRect(), e);
  if (p !== folder && overDock !== (p === dockPager)) {
    unmagnify();
    p.items.splice(p.items.indexOf(g.node), 1);
    p.layout(true);
    clearHover();
    clearInterval(g.edgeTimer);
    g.edge = 0;
    p = g.pager = overDock ? dockPager : main;
    p.items.splice(overDock ? p.items.length : Math.min(p.items.length, (p.page + 1) * p.size), 0, g.node);
    g.el = p.tileFor(g.node);
    g.el.classList.add('dragging');
    p.layout(true);
  }

  // Held near a side edge: flip pages.
  const pr = p.root.getBoundingClientRect();
  const edge = e.clientX < pr.left + 40 ? -1 : e.clientX > pr.right - 40 ? 1 : 0;
  if (edge !== g.edge) {
    clearInterval(g.edgeTimer);
    g.edge = edge;
    if (edge) g.edgeTimer = setInterval(() => {
      const from = p.page;
      p.go(p.page + edge);
      if (p.page === from) return;
      // Carry the icon along: it lands in the new page's last slot until dropped elsewhere.
      p.items.splice(p.items.indexOf(g.node), 1);
      p.items.splice(Math.min(p.items.length, p.page * p.size + p.size - 1), 0, g.node);
      p.layout();
    }, 700);
  }

  // Aim with the centre of the dragged icon, not the pointer: people line icons up by eye,
  // and the pointer can be anywhere on the icon (or its label) they grabbed.
  const x = e.clientX - g.offX + g.iconSize / 2, y = e.clientY - g.offY + g.iconSize / 2;
  let slot = slotAt(p, x, y);
  const occupant = p.items[slot];
  if (slot < 0 || occupant === g.node) return clearHover();

  // Like Launchpad, act only once the icon rests: over another icon's middle it makes/joins a folder,
  // anywhere else in that cell it moves there. Passing over cells on the way does nothing.
  const tileEl = p.tileFor(occupant), r = tileEl.querySelector('.icon').getBoundingClientRect();
  const onIcon = Math.abs(x - (r.left + r.width / 2)) < r.width * 0.35
    && Math.abs(y - (r.top + r.height / 2)) < r.height * 0.35;
  const kind = onIcon && g.node.url ? 'merge' : 'slot';
  // The home grid ends with Chrome's own folders (Other bookmarks, …), which can't be reordered.
  // A bookmark dropped among them is saved at the end of the Bookmarks bar, so show it there too.
  if (kind === 'slot') {
    slot = Math.min(slot, p.items.findLastIndex(n => n.parentId === p.parent?.id || n === g.node));
    if (p.items[slot] === g.node) return clearHover(); // already as far along as it can go
  }
  // Moving icons aside needs the dragged icon to actually stop: any movement restarts the wait,
  // so gliding towards an icon to make a folder never shoves that icon away first.
  const resting = g.hover?.kind !== 'slot' || Math.hypot(x - g.hover.x, y - g.hover.y) < 6;
  if (g.hover?.slot === slot && g.hover.kind === kind && resting) return;
  clearHover();
  g.hover = {
    slot, kind, x, y,
    timer: kind === 'merge'
      ? setTimeout(() => { g.merge = occupant; tileEl.classList.add('merge'); }, 300)
      : setTimeout(() => moveTo(p, slot), 300),
  };
}

async function endDrag(d, commit) {
  const { node, merge, pager: p, start } = d;
  clearInterval(d.edgeTimer);
  clearHover(d);
  d.ghost.remove();
  d.el.classList.remove('dragging');
  const moved = p !== start.pager || p.items.indexOf(node) !== start.index;

  try {
    if (!commit) return;
    const oldParent = node.parentId;
    if (merge?.url) {
      // Bookmark onto bookmark: new folder in the target's spot, holding both.
      const f = await chrome.bookmarks.create({ parentId: merge.parentId, index: merge.index, title: folderName(node, merge) });
      await chrome.bookmarks.move(merge.id, { parentId: f.id });
      await chrome.bookmarks.move(node.id, { parentId: f.id });
      await removeIfEmpty(oldParent);
      await load();
      openFolder(nodes.get(f.id), main.tiles.get(f.id));
      drawerTitle.focus();
      drawerTitle.select(); // Launchpad lets you type the new folder's name right away
    } else if (merge) {
      await chrome.bookmarks.move(node.id, { parentId: merge.id });
      await removeIfEmpty(oldParent);
    } else if (moved) {
      // "Insert before the next item" maps cleanly onto Chrome's move index.
      const parent = p.parent || await dockFolder(); // first thing dropped into the Dock makes its folder
      const next = p.items[p.items.indexOf(node) + 1];
      const index = next?.parentId === parent.id ? next.index : parent.children?.length ?? 0;
      await chrome.bookmarks.move(node.id, { parentId: parent.id, index });
      await removeIfEmpty(oldParent);
    }
  } catch (err) {
    console.error(err);
  } finally {
    load();
  }
}

document.addEventListener('pointermove', e => {
  if (!g) return;
  // The mouse button came up somewhere we never heard about (another app, after Cmd+Tab): cancel.
  if (e.pointerType === 'mouse' && !(e.buttons & 1)) return cancelGesture();
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.mode) {
    if (Math.hypot(dx, dy) < 6) return;
    clearTimeout(g.hold);
    suppressClick = true;
    const draggable = g.node && g.pager.sortable && g.node.parentId !== rootId;
    g.mode = draggable ? 'icon' : 'page';
    if (draggable) startDrag();
  }
  if (g.mode === 'page') g.pager.drag(dx);
  else moveDrag(e);
});

function pointerEnd(e) {
  const d = g;
  g = null;
  if (!d) return;
  clearTimeout(d.hold);
  if (d.mode === 'page') d.pager.release(e.clientX - d.x0, Date.now() - d.t0 < 250);
  else if (d.mode === 'icon') endDrag(d, e.type === 'pointerup');
  else if (!d.el && jiggle) setJiggle(false); // tap on empty space ends jiggle mode
  setTimeout(() => { suppressClick = false; }); // the click (if any) fires before this runs
}
document.addEventListener('pointerup', pointerEnd);
document.addEventListener('pointercancel', pointerEnd);
// Put everything back as it was: no drop, pages snap back, no stray click afterwards.
const cancelGesture = () => g && pointerEnd({ type: 'pointercancel', clientX: g.x0 });
addEventListener('blur', cancelGesture); // switching apps mid-drag

document.addEventListener('click', e => {
  const del = e.target.closest('.delete');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    const node = nodes.get(del.closest('.app').dataset.id);
    if (node) removeOrReload(node);
    return;
  }
  // After a drag or long press, and in jiggle mode, a click must not open the bookmark.
  if (suppressClick || (jiggle && e.target.closest('a.app'))) {
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }
}, true);

// ---- List view ----
// One card per folder, its bookmarks as rows. Bookmarks not in any folder are grouped by website;
// a website with just one bookmark isn't grouped: that bookmark stands on its own.
const listEl = document.getElementById('list');
let collapsed = new Set(); // cards folded shut, on this computer: folder ids or "site:<host>"
const site = url => hostname(url).replace(/^www\./, '') || scheme(url).replace(':', '');

function listRow(node) {
  const row = document.createElement(node.url ? 'a' : 'button');
  const icon = document.createElement('span');
  const text = document.createElement('span');
  const name = document.createElement('span');
  const sub = document.createElement('small');
  row.className = 'list-row';
  row.dataset.id = node.id;
  row.title = node.title || node.url || '';
  icon.className = 'icon';
  text.className = 'list-text';
  name.textContent = node.title || hostname(node.url);
  if (node.url) {
    row.href = node.url;
    icon.append(img(node));
    sub.textContent = site(node.url);
    if (['chrome:', 'file:'].includes(scheme(node.url))) row.onclick = e => { e.preventDefault(); openViaApi(node.url); };
  } else {
    row.type = 'button';
    icon.classList.add('list-folder');
    icon.textContent = '📁';
    const n = leaves(node).length;
    sub.textContent = `${n} bookmark${n === 1 ? '' : 's'}`;
    row.onclick = () => openFolder(node, row);
  }
  text.append(name, sub);
  row.append(icon, text);
  row.draggable = true;
  row.ondragstart = e => {
    e.dataTransfer.setData(DRAG_TYPE, node.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  };
  row.ondragend = () => row.classList.remove('dragging');
  return row;
}

// Drag a row onto a row of a folder card to put it there, onto a folder card to add it at the end,
// or onto any other card to take it out of its folder (to the Bookmarks bar).
const DRAG_TYPE = 'application/x-awesome-bookmark';
function dropTarget(e) {
  const card = e.target.closest?.('.list-card');
  if (!card || !e.dataTransfer.types.includes(DRAG_TYPE)) return null;
  const parent = nodes.get(card.dataset.folder) || bar;
  const row = card.dataset.folder ? e.target.closest('.list-row') : null;
  return { card, row, parent, index: row ? nodes.get(row.dataset.id)?.index : undefined };
}
function markDrop(t) {
  for (const el of listEl.querySelectorAll('.drop-target, .drop-before')) el.classList.remove('drop-target', 'drop-before');
  t?.card.classList.add('drop-target');
  t?.row?.classList.add('drop-before');
}
listEl.addEventListener('dragover', e => {
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  markDrop(t);
});
listEl.addEventListener('dragleave', e => { if (!listEl.contains(e.relatedTarget)) markDrop(null); });
listEl.addEventListener('drop', async e => {
  const t = dropTarget(e);
  markDrop(null);
  if (!t) return;
  e.preventDefault();
  const node = nodes.get(e.dataTransfer.getData(DRAG_TYPE));
  if (!node || node.id === t.parent.id || (!t.card.dataset.folder && node.parentId === bar.id)) return;
  try {
    await chrome.bookmarks.move(node.id, { parentId: t.parent.id, ...(t.index !== undefined && { index: t.index }) });
  } catch (err) {
    console.error(err); // e.g. a folder dropped into itself
  }
});

// key: what remembers the fold; parent: where "Add link" saves.
function listCard(key, title, parent, children) {
  const card = document.createElement('section');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const name = document.createElement('span');
  const count = document.createElement('span');
  const add = document.createElement('button');
  card.className = 'list-card glass thin';
  if (!key.startsWith('site:')) card.dataset.folder = parent.id;
  name.className = 'list-title';
  name.textContent = title;
  count.className = 'list-count';
  count.textContent = children.length;
  summary.append(name, count);
  details.open = !collapsed.has(key);
  details.ontoggle = () => {
    if (details.open !== collapsed.has(key)) return; // already recorded (also skips the toggle from building it)
    details.open ? collapsed.delete(key) : collapsed.add(key);
    chrome.storage.local.set({ collapsed: [...collapsed] }).catch(console.error);
  };
  add.type = 'button';
  add.className = 'list-add';
  add.textContent = '+ Add link';
  add.onclick = () => addBookmark(parent);
  // Long folders scroll inside the card, so the title and "Add link" stay in view.
  const rows = document.createElement('div');
  rows.className = 'list-rows';
  rows.append(...children.map(listRow));
  details.append(summary, rows, add);
  card.append(details);
  return card;
}

function renderList() {
  const bySite = Map.groupBy(topItems.filter(n => n.url), n => site(n.url));
  listEl.replaceChildren(
    ...topItems.filter(n => !n.url).map(f => listCard(f.id, f.title || 'Folder', f, visible(f.children))),
    ...[...bySite].filter(([, links]) => links.length > 1).map(([host, links]) => listCard(`site:${host}`, host, bar, links)),
    ...[...bySite.values()].filter(links => links.length === 1).map(([node]) => {
      const card = document.createElement('section');
      card.className = 'list-card list-single glass thin';
      card.append(listRow(node));
      return card;
    }),
  );
}

// ---- Search, keys, loading ----

function render() {
  const q = search.value.trim().toLowerCase();
  // Search covers bookmarks and folders at any depth (a matching folder opens like any other).
  const everything = n => [n, ...(n.children || []).flatMap(everything)];
  const items = q
    ? topItems.flatMap(everything).filter(n => visible([n]).length
        && (n.title.toLowerCase().includes(q) || n.url?.toLowerCase().includes(q)))
    : topItems;

  document.body.classList.toggle('no-bookmarks', !topItems.length); // must precede layout: it changes the pager's size
  document.body.classList.toggle('searching', !!q);
  empty.hidden = items.length > 0;
  empty.textContent = q ? 'No bookmarks found. Press Enter to search the web.' : 'No bookmarks found';
  webSearch.hidden = !q;
  webSearch.textContent = `Search the web for “${search.value.trim()}”`;
  // List view shows the home page as cards; a search always shows its results as tiles.
  const listView = settings.view === 'list' && !q && topItems.length > 0;
  document.body.classList.toggle('list-view', listView);
  listEl.hidden = !listView;
  if (listView) renderList();
  main.set(items, bar, !q); // search results mix folders, so they can't be reordered
  document.querySelector('.app.selected')?.classList.remove('selected'); // tiles are reused across searches
  highlighted = -1;
  if (q) highlight(0); // Enter opens the highlighted result
}

async function load() {
  if (g?.mode === 'icon') return; // re-rendering mid-drag would pull the tile away; endDrag reloads
  const [root] = await chrome.bookmarks.getTree();
  rootId = root.id;
  nodes = new Map();
  (function walk(n) { nodes.set(n.id, n); n.children?.forEach(walk); })(root);
  icons = await readIcons();
  const stored = (await chrome.storage.local.get('collapsed')).collapsed;
  collapsed = new Set(Array.isArray(stored) ? stored.filter(k => typeof k === 'string' && k.length <= 300).slice(0, 500) : []);
  // Pictures of deleted bookmarks are dropped (Undo keeps its own copy). Ids are never reused.
  if ([...icons.keys()].some(id => !nodes.has(id))) {
    for (const id of icons.keys()) if (!nodes.has(id)) icons.delete(id);
    chrome.storage.local.set({ icons: Object.fromEntries(icons) }).catch(console.error);
  }
  const others = root.children.slice(1); // Other bookmarks, Mobile bookmarks
  bar = root.children[0];
  other = root.children[1];
  dock = other.children?.find(n => !n.url && n.title === DOCK_TITLE) || null;
  topItems = [...visible(bar.children), ...visible(others).filter(f => !settings.hiddenFolders.includes(f.id))];

  main.tiles = new Map(); // bookmarks changed: rebuild tiles from the fresh data
  folder.tiles = new Map();
  dockPager.tiles = new Map();
  const docked = dock ? visible(dock.children) : [];
  dockEl.classList.toggle('empty', !docked.length);
  dockPager.set(docked, dock, true);
  stack = stack.map(n => nodes.get(n.id)).filter(n => n && visible([n]).length);
  if (drawer.open) stack.length ? showFolder() : hideDrawer();
  render();
}

back.onclick = () => { stack.pop(); folder.page = 0; showFolder(); };
// Esc steps back one level: jiggle mode, then a nested folder, then the folder itself.
drawer.addEventListener('cancel', e => {
  e.preventDefault();
  if (jiggle) setJiggle(false);
  else if (stack.length > 1) back.click();
  else closeFolder();
});
// Backdrop clicks land on the dialog itself, outside its box. (Keyboard-made clicks on buttons inside report
// position 0,0, so checking the position alone would close the folder on Enter.)
drawer.addEventListener('click', e => { if (e.target === drawer && !inside(drawer.getBoundingClientRect(), e)) closeFolder(); });

drawerTitle.addEventListener('change', renameFolder);
drawerTitle.addEventListener('keydown', e => {
  if (e.key === 'Enter') drawerTitle.blur();
  if (e.key === 'Escape') {
    e.preventDefault(); // keep the folder open; just undo the edit
    drawerTitle.value = stack.at(-1)?.title || '';
    drawerTitle.blur();
  }
});

search.addEventListener('input', () => { main.page = 0; render(); });

// Searches with the user's own default search engine (Chrome's setting), in this tab.
function searchWeb() {
  const text = search.value.trim();
  if (text) chrome.search.query({ text, disposition: 'CURRENT_TAB' }).catch(console.error);
}
webSearch.onclick = searchWeb;
search.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    // Open the highlighted bookmark; with no match (or Shift+Enter), search the web with Chrome's own search engine.
    const hit = !e.shiftKey && main.tiles.get(main.items[highlighted]?.id);
    if (hit) hit.click();
    else searchWeb();
  }
  // With a query, arrows move through the results instead of the caret.
  if (search.value && step(e.key, 1)) {
    e.preventDefault();
    highlight(highlighted + step(e.key, cols(main)));
  }
  // Esc clears the query first, then leaves the box.
  if (e.key === 'Escape') {
    if (search.value) { search.value = ''; main.page = 0; render(); } else search.blur();
  }
});

window.addEventListener('resize', () => {
  main.layout();
  dockPager.layout();
  if (drawer.open) folder.layout();
});

document.addEventListener('keydown', e => {
  // Option+D (Alt+D) jumps to the Dock, even from the search field; arrows then move along it.
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyD' && !drawer.open) {
    e.preventDefault();
    if (dockPager.items.length) dockPager.tileFor(dockPager.items[0]).focus({ preventScroll: true });
    return;
  }
  // Text fields, dropdowns and the add/edit and history panels keep their own keys; they're not for the grid behind.
  if (document.activeElement?.closest('input, select, textarea, #editor, #importer')) return;
  if (undoLast && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  const p = activePager();
  if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    p.go(e.key === 'ArrowLeft' ? 0 : p.track.children.length - 1);
    return;
  }
  if (step(e.key, 1)) {
    e.preventDefault();
    focusTile(p, e.key);
    return;
  }
  // Delete (or Backspace) on a selected bookmark: the keyboard route to jiggle mode's ✕ badge.
  if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement?.matches('a.app')) {
    e.preventDefault();
    const node = nodes.get(document.activeElement.dataset.id);
    if (node) removeOrReload(node);
    return;
  }
  // Esc in the home grid: leave jiggle mode, then drop the selection. (The open folder handles its own.)
  if (e.key === 'Escape' && !drawer.open) {
    if (jiggle) setJiggle(false);
    else document.activeElement?.blur();
    return;
  }
  // "/" jumps to the search field (without typing a slash, which every address contains).
  if (e.key === '/' && !drawer.open && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); search.focus(); return; }
  // Start typing anywhere to search, like Launchpad.
  if (!drawer.open && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) search.focus();
});

// Changes often come in bursts (sync, bulk adds): redraw once they settle, not once per bookmark.
let reloadTimer;
const scheduleLoad = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 50); };
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
  chrome.bookmarks[ev].addListener(scheduleLoad);
}

document.getElementById('settings').onclick = () => chrome.runtime.openOptionsPage();

// Settings changed (here, on the settings page, or synced from another computer): apply live.
const credit = document.getElementById('photo-credit');
async function applySettings() {
  settings = await getSettings();
  await applyWallpaper(settings);
  const daily = settings.wallpaper === 'daily' ? await getDaily() : null;
  credit.hidden = !daily?.credit;
  credit.textContent = daily?.credit ? `📷 ${daily.credit}` : '';
  if (daily?.page) credit.href = daily.page; else credit.removeAttribute('href');
  if (settings.wallpaper === 'daily') refreshDaily(); // a new day: fetch the next photo (the storage change re-applies)
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  const wallpaperChanged = 'wallpaperImage' in changes || 'daily' in changes;
  if (area === 'local' && 'icons' in changes && !wallpaperChanged) return scheduleLoad(); // a picture changed here or in another tab
  if (!settingsChanged(changes, area) && !wallpaperChanged) return; // e.g. tasks: nothing on the grid changed
  await applySettings();
  load();
});

// If settings can't be read, carry on with the defaults rather than leave the page blank.
applySettings().catch(console.error).then(load).finally(() => document.body.classList.add('ready'));
syncDrive(); // pick up icons or a wallpaper changed on another computer
