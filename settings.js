// Settings shared by the new tab and the settings page.
// They sync through chrome.storage.sync; a custom wallpaper image is too big for sync,
// so it stays in chrome.storage.local on this computer.
const WALLPAPERS = { meadow: 'Meadow', dusk: 'Dusk', ocean: 'Ocean', sunrise: 'Sunrise', graphite: 'Graphite', daily: 'Photo of the day', custom: 'Your image' };
// cols/rows 0 = automatic. emoji: an emoji for each bookmark instead of the site's own icon. frequent: the most-visited row (needs the optional topSites permission). calendar: show the next-meeting widget (switched on by connecting, never by default). view: the home page as an icon grid or a list of cards. name: shown in the greeting. place: the city for the weather ({ name, lat, lon }), or null. hour12: null follows the computer's own clock style; clicking the clock sets true (12-hour) or false (24-hour).
const DEFAULTS = { cols: 0, rows: 0, wallpaper: 'meadow', blur: true, emoji: true, hiddenFolders: [], clock: true, calendar: false, frequent: false, view: 'grid', hour12: null, name: '', place: null };
const LIMITS = { cols: [3, 10], rows: [2, 8] };

const MAX_NAME = 40;
// Plain text only: control and formatting characters (e.g. right-to-left overrides) are dropped.
const cleanText = (v, max) => typeof v === 'string' ? v.replace(/\p{C}/gu, '').trim().slice(0, max) : '';
const cleanName = v => cleanText(v, MAX_NAME);
const cleanPlace = p => p && typeof p === 'object' && cleanText(p.name, 80)
  && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
  ? { name: cleanText(p.name, 80), lat: p.lat, lon: p.lon } : null;

// Synced data can come from another computer or an older version: accept only known values.
function sanitize(s) {
  const intIn = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
  return {
    cols: intIn(s.cols, LIMITS.cols) ? s.cols : 0,
    rows: intIn(s.rows, LIMITS.rows) ? s.rows : 0,
    wallpaper: Object.hasOwn(WALLPAPERS, s.wallpaper) ? s.wallpaper : DEFAULTS.wallpaper,
    blur: typeof s.blur === 'boolean' ? s.blur : DEFAULTS.blur,
    emoji: typeof s.emoji === 'boolean' ? s.emoji : DEFAULTS.emoji,
    hiddenFolders: Array.isArray(s.hiddenFolders) ? s.hiddenFolders.filter(id => typeof id === 'string').slice(0, 50) : [],
    clock: typeof s.clock === 'boolean' ? s.clock : DEFAULTS.clock,
    calendar: s.calendar === true,
    frequent: s.frequent === true,
    view: s.view === 'list' ? 'list' : 'grid',
    hour12: typeof s.hour12 === 'boolean' ? s.hour12 : null,
    name: cleanName(s.name),
    place: cleanPlace(s.place),
  };
}

// ---- Google Calendar sign-in ----
// Chrome handles the sign-in and keeps the token; we never store it. The OAuth client ID lives in
// manifest.json ("oauth2"), which configure.sh writes from .env; until a real one is filled in, neither the calendar nor Drive can be connected.
const googleConfigured = () => !/^YOUR_/.test(chrome.runtime.getManifest().oauth2?.client_id || 'YOUR_');

// interactive: may show Google's consent screen (only from a click). Resolves to null when not signed in.
async function calendarToken(interactive) {
  try { return (await chrome.identity.getAuthToken({ interactive })).token || null; } catch { return null; }
}

// Sign-in is an optional permission, asked for on the first Connect (so it must run from a click).
async function connectCalendar() {
  const allowed = await chrome.permissions.request({ permissions: ['identity'] }).catch(() => false);
  return allowed && calendarToken(true);
}

// Forget the token here and revoke it at Google, so access really ends; then hand back the permission.
async function disconnectCalendar() {
  const token = await calendarToken(false);
  if (token) await revokeToken(token);
  if (!(await getDrive()).on) await chrome.permissions.remove({ permissions: ['identity'] }).catch(() => {}); // Drive sync still needs it
}
async function revokeToken(token) {
  await chrome.identity.removeCachedAuthToken({ token });
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {}); // already revoked or offline: the cached token is gone either way
}

// ---- Custom icons ----
// A picture or emoji the user chose for a bookmark, in chrome.storage.local under "icons" ({ bookmark id: data URL or emoji }).
// Too big for Chrome Sync: Google Drive sync (drive-sync.js) carries them to other computers, by URL.
const MAX_ICONS = 500, MAX_ICON_URL = 200_000;
// Only a WebP this page encoded itself is ever used; anything else in storage is dropped.
const ICON_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/;
// The first character someone typed, if it's an emoji (flags, skin tones and joined emoji count as one).
const segmenter = new Intl.Segmenter();
function oneEmoji(text) {
  const first = segmenter.segment(String(text).trim())[Symbol.iterator]().next().value?.segment || '';
  return first.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : null;
}
const isPicture = v => v.length <= MAX_ICON_URL && ICON_RE.test(v);
// Besides a picture or an emoji, a bookmark can be set to always use the site's own icon, or its letter.
const KINDS = ['site', 'letter'];

const validIcon = v => typeof v === 'string' && (KINDS.includes(v) || isPicture(v) || oneEmoji(v) === v);
const cleanIcons = stored => new Map(Object.entries(stored && typeof stored === 'object' ? stored : {})
  .filter(([id, v]) => /^\d{1,20}$/.test(id) && validIcon(v))
  .slice(0, MAX_ICONS));
const readIcons = async () => cleanIcons((await chrome.storage.local.get('icons')).icons);

const getSettings = async () => sanitize(await chrome.storage.sync.get(DEFAULTS));
// Sync also holds tasks; only a change to a setting means settings changed.
const settingsChanged = (changes, area) => area === 'sync' && Object.keys(changes).some(k => Object.hasOwn(DEFAULTS, k));

// ---- Tasks ----
// They sync like settings, one key per task ("task:<id>"): a single key would hit sync's 8 KB-per-item limit.
const TASK_KEY = 'task:';
const MAX_TASKS = 200, MAX_TEXT = 200;
const isTaskKey = k => k.startsWith(TASK_KEY);

// Stored data is only trusted after this: known fields, right types, capped sizes.
function cleanTask(id, t) {
  if (!/^[\w-]{1,40}$/.test(id) || !t || typeof t.text !== 'string' || !t.text.trim()) return null;
  return { id, text: t.text.trim().slice(0, MAX_TEXT), done: t.done === true, at: Number.isFinite(t.at) ? t.at : 0 };
}
const cleanTasks = list => (Array.isArray(list) ? list : [])
  .map(t => cleanTask(String(t?.id), t)).filter(Boolean).slice(0, MAX_TASKS);

async function getTasks() {
  const all = await chrome.storage.sync.get(null);
  return Object.entries(all).filter(([k]) => isTaskKey(k))
    .map(([k, v]) => cleanTask(k.slice(TASK_KEY.length), v)).filter(Boolean)
    .sort((a, b) => a.at - b.at).slice(0, MAX_TASKS);
}
const taskEntries = list => Object.fromEntries(list.map(t => [TASK_KEY + t.id, { text: t.text, done: t.done, at: t.at }]));
const saveTasks = list => chrome.storage.sync.set(taskEntries(list));
const removeTasks = list => chrome.storage.sync.remove(list.map(t => TASK_KEY + t.id));

// ---- Notes ----
// One synced key; 2,000 characters stays under sync's 8 KB-per-item limit even in 3-byte characters.
const MAX_NOTES = 2000;
const getNotes = async () => { const { notes } = await chrome.storage.sync.get('notes'); return typeof notes === 'string' ? notes.slice(0, MAX_NOTES) : ''; };

// Only ever a JPEG the settings page encoded itself; anything else is ignored, never put into CSS.
const IMAGE_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
async function getWallpaperImage() {
  const { wallpaperImage } = await chrome.storage.local.get('wallpaperImage');
  return typeof wallpaperImage === 'string' && IMAGE_RE.test(wallpaperImage) ? wallpaperImage : null;
}

// ---- Pictures ----
const MAX_UPLOAD = 25 * 1024 * 1024; // bytes; the stored copy is re-encoded far smaller
const MAX_SIDE = 2560; // px; plenty for a blurred wallpaper and fits Chrome's local storage

const toDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// Decoding proves it's really an image; re-encoding as JPEG strips everything but the pixels.
async function encodeImage(blob) {
  if (blob.size > MAX_UPLOAD) throw new RangeError('too big');
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return toDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
}

// ---- Photo of the day ----
// Wikimedia Commons' picture of the day (freely licensed; the new tab credits it). Every computer picks the
// same photo for a date. Portrait photos are skipped for the latest landscape one from the past week.
const DAILY_HOSTS = ['thumb.wikimedia.org', 'upload.wikimedia.org'];
const DAILY_RETRY = 60 * 60_000; // after a failed try (offline, say), wait this long before the next
const localDate = (back = 0) => { const d = new Date(); d.setDate(d.getDate() - back); return d.toLocaleDateString('en-CA'); }; // YYYY-MM-DD

async function getDaily() {
  const { daily: d } = await chrome.storage.local.get('daily');
  if (!d || typeof d.date !== 'string' || !IMAGE_RE.test(d.image)) return null;
  const page = typeof d.page === 'string' && d.page.startsWith('https://commons.wikimedia.org/wiki/') ? d.page : null;
  return { date: d.date, image: d.image, credit: cleanText(d.credit, 120), page };
}

let dailyRun = null;
const refreshDaily = () => (dailyRun ??= (async () => {
  try {
    if ((await getDaily())?.date === localDate()) return;
    const { dailyTried } = await chrome.storage.local.get('dailyTried');
    if (Date.now() - (Number(dailyTried) || 0) < DAILY_RETRY) return;
    await chrome.storage.local.set({ dailyTried: Date.now() });
    const opts = { credentials: 'omit', signal: AbortSignal.timeout(15_000) };
    for (let back = 0; back < 7; back++) {
      const res = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${localDate(back).replaceAll('-', '/')}`, opts);
      if (!res.ok) continue;
      const pic = (await res.json())?.image;
      const { width, height } = pic?.image || {};
      const src = typeof pic?.thumbnail?.source === 'string' ? new URL(pic.thumbnail.source) : null;
      if (!(width >= height) || src?.protocol !== 'https:' || !DAILY_HOSTS.includes(src.hostname)) continue;
      // The feed links a small copy; the same path at 1920px is one of Wikimedia's standard sizes.
      if (width >= 1920) src.pathname = src.pathname.replace(/\/\d+px-([^/]+)$/, '/1920px-$1');
      const file = await fetch(src, opts);
      if (!file.ok || !/^image\//.test(file.headers.get('content-type') || '')) continue;
      const title = typeof pic.title === 'string' && /^File:[^/?#]{1,250}$/.test(pic.title) ? pic.title : null;
      await chrome.storage.local.set({ daily: {
        date: localDate(),
        image: await encodeImage(await file.blob()),
        credit: cleanText([pic.description?.text, pic.artist?.text].filter(t => typeof t === 'string').join(' · '), 120),
        page: title && `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      } });
      return;
    }
  } catch (err) {
    console.warn('Photo of the day:', err.message);
  } finally {
    dailyRun = null;
  }
})());

async function applyWallpaper(s) {
  const root = document.documentElement;
  const image = s.wallpaper === 'custom' ? await getWallpaperImage() : s.wallpaper === 'daily' ? (await getDaily())?.image : null;
  root.style.setProperty('--wallpaper-image', image ? `url("${image}")` : 'none');
  root.dataset.wallpaper = image ? 'custom' : ['custom', 'daily'].includes(s.wallpaper) ? DEFAULTS.wallpaper : s.wallpaper;
  root.classList.toggle('blur-wallpaper', s.blur);
  root.classList.toggle('bright-wallpaper', !!image && await brightness(image) > 0.6);
}

// Average brightness (0 dark – 1 white) of an image, read from a 16×16 copy. Bright photos get dimmed
// so the white labels on top stay readable.
async function brightness(src) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob(), { resizeWidth: 16, resizeHeight: 16 });
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const px = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return sum / (px.length / 4) / 255;
  } catch { return 0; }
}
