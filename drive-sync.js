// Custom icons and your own wallpaper image are too big for Chrome Sync, so they sync through
// Google Drive's hidden app folder instead. The drive.appdata scope lets this extension see only
// its own file there, never the rest of your Drive. Chrome keeps the sign-in token; it's never stored here.
// Bookmark ids differ between computers, so icons are saved by bookmark URL.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_NAME = 'awesome-bookmarks.json';
const MAX_DRIVE_FILE = 5 * 1024 * 1024; // Drive's limit for a one-request upload
const MAX_URL = 2048;
const DRIVE_CHECK = 5 * 60_000; // new tabs look for changes from other computers at most this often
const DRIVE_ID_RE = /^[\w-]{1,200}$/;

// This computer's sync state: on, syncedAt (Drive's time for the copy we last matched),
// checkedAt, dirty (a change not sent yet), error ('' | 'failed' | 'too big').
async function getDrive() {
  const { drive } = await chrome.storage.local.get('drive');
  return drive && typeof drive === 'object' ? drive : {};
}
const setDrive = async patch => chrome.storage.local.set({ drive: { ...await getDrive(), ...patch } });

// interactive: may show Google's consent screen (only from a click). Resolves to null when not signed in.
async function driveToken(interactive) {
  try { return (await chrome.identity.getAuthToken({ interactive, scopes: [DRIVE_SCOPE] })).token || null; } catch { return null; }
}

async function driveFetch(path, init = {}, retried = false) {
  const token = await driveToken(false);
  if (!token) throw new Error('Not signed in to Google');
  const res = await fetch(`https://www.googleapis.com/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) { // expired: Chrome fetches a fresh one
    await chrome.identity.removeCachedAuthToken({ token });
    return driveFetch(path, init, true);
  }
  if (!res.ok) throw new Error(`Drive request failed (${res.status})`);
  return res;
}

async function findDriveFile() {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${DRIVE_NAME}'`, orderBy: 'modifiedTime desc', fields: 'files(id,modifiedTime)' });
  const f = (await (await driveFetch(`drive/v3/files?${q}`)).json()).files?.[0];
  return f && DRIVE_ID_RE.test(f.id) && typeof f.modifiedTime === 'string' ? f : null;
}

// The file is only trusted after this, like everything else read from storage.
async function readDriveFile(id) {
  const res = await driveFetch(`drive/v3/files/${id}?alt=media`);
  if (Number(res.headers.get('content-length')) > MAX_DRIVE_FILE) throw new RangeError('too big');
  const text = await res.text();
  if (text.length > MAX_DRIVE_FILE) throw new RangeError('too big');
  const data = JSON.parse(text);
  const icons = data?.icons && typeof data.icons === 'object' ? data.icons : {};
  return {
    icons: new Map(Object.entries(icons).filter(([url, v]) => url.length <= MAX_URL && validIcon(v)).slice(0, MAX_ICONS)),
    wallpaper: typeof data?.wallpaper === 'string' && IMAGE_RE.test(data.wallpaper) ? data.wallpaper : null,
  };
}

// Bookmark id → URL for every bookmark on this computer.
async function bookmarkUrls() {
  const urls = new Map();
  (function walk(n) { if (n.url) urls.set(n.id, n.url); n.children?.forEach(walk); })((await chrome.bookmarks.getTree())[0]);
  return urls;
}

// keepLocal: this computer has changes of its own, so Drive only fills the gaps.
// ponytail: whole-entry last-writer-wins; an icon removed elsewhere while this computer had unsent changes comes back.
async function applyDrive(remote, urls, keepLocal) {
  const next = keepLocal ? await readIcons() : new Map();
  for (const [id, url] of urls) if (remote.icons.has(url) && !next.has(id)) next.set(id, remote.icons.get(url));
  await chrome.storage.local.set({ icons: Object.fromEntries([...next].slice(0, MAX_ICONS)) });
  const local = await getWallpaperImage();
  if (keepLocal && local) return;
  if (remote.wallpaper) await chrome.storage.local.set({ wallpaperImage: remote.wallpaper });
  else if (local) await chrome.storage.local.remove('wallpaperImage');
}

async function pushDrive(file, remote, urls) {
  // Icons of bookmarks this computer doesn't have (yet) are kept; this computer decides the rest.
  const out = new Map(remote?.icons);
  for (const url of urls.values()) out.delete(url);
  for (const [id, v] of await readIcons()) if (urls.has(id)) out.set(urls.get(id), v);
  const body = JSON.stringify({ icons: Object.fromEntries([...out].slice(-MAX_ICONS)), wallpaper: await getWallpaperImage() });
  if (body.length > MAX_DRIVE_FILE) throw new RangeError('too big');
  const json = { 'Content-Type': 'application/json' };
  const id = file?.id || (await (await driveFetch('drive/v3/files?fields=id', {
    method: 'POST', headers: json, body: JSON.stringify({ name: DRIVE_NAME, parents: ['appDataFolder'] }),
  })).json()).id;
  if (!DRIVE_ID_RE.test(id)) throw new Error('Unexpected Drive reply');
  const saved = await (await driveFetch(`upload/drive/v3/files/${id}?uploadType=media&fields=modifiedTime`, { method: 'PATCH', headers: json, body })).json();
  return String(saved.modifiedTime);
}

// push: this computer changed something. Otherwise just look for changes from other computers.
// One run at a time per page; a failed send is retried by the next new tab.
let driveRun = Promise.resolve();
const syncDrive = (push = false) => (driveRun = driveRun.then(async () => {
  const state = await getDrive();
  if (!state.on) return;
  const send = push || state.dirty === true;
  if (!send && Date.now() - (Number(state.checkedAt) || 0) < DRIVE_CHECK) return;
  try {
    const file = await findDriveFile();
    const changed = !!file && file.modifiedTime !== state.syncedAt;
    const urls = await bookmarkUrls();
    const remote = file && (changed || send) ? await readDriveFile(file.id) : null;
    if (changed) await applyDrive(remote, urls, send);
    const syncedAt = send || !file ? await pushDrive(file, remote, urls) : file.modifiedTime;
    await setDrive({ syncedAt, checkedAt: Date.now(), dirty: false, error: '' });
  } catch (err) {
    console.warn('Drive sync:', err.message);
    await setDrive({ checkedAt: Date.now(), dirty: send, error: err instanceof RangeError ? 'too big' : 'failed' });
  }
}));

// Sign-in is the same optional permission the calendar uses, asked for on Connect (so it must run from a click).
async function connectDrive() {
  const allowed = await chrome.permissions.request({ permissions: ['identity'] }).catch(() => false);
  if (!allowed || !await driveToken(true)) return false;
  await setDrive({ on: true, dirty: true, syncedAt: '', error: '' }); // the first sync merges both ways
  syncDrive();
  return true;
}

// Stops syncing on this computer. The grant isn't revoked: your other computers still use it.
// The file stays in Drive for them; Google Account → Third-party access removes both.
async function disconnectDrive(calendarOn) {
  await chrome.storage.local.remove('drive');
  const token = await driveToken(false);
  if (token) await chrome.identity.removeCachedAuthToken({ token });
  if (!calendarOn) await chrome.permissions.remove({ permissions: ['identity'] }).catch(() => {});
}
