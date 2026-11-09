const $ = id => document.getElementById(id);
const MAX_UPLOAD = 25 * 1024 * 1024; // bytes; the stored copy is re-encoded far smaller
const MAX_SIDE = 2560; // px; plenty for a blurred wallpaper and fits Chrome's local storage

let settings = DEFAULTS;
// One save at a time, each starting from what's stored now, so quick successive changes
// (or one arriving from another computer) never overwrite each other.
// patch: the fields to change, or a function from the current settings to them.
let saving = Promise.resolve();
const save = patch => (saving = saving.then(async () => {
  const current = await getSettings();
  await chrome.storage.sync.set(sanitize({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
}).catch(console.error));

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

function range([lo, hi]) {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

$('cols').append(option(0, 'Automatic'), ...range(LIMITS.cols).map(n => option(n, n)));
$('rows').append(option(0, 'Automatic'), ...range(LIMITS.rows).map(n => option(n, n)));
$('cols').onchange = () => save({ cols: Number($('cols').value) });
$('rows').onchange = () => save({ rows: Number($('rows').value) });
$('blur').onchange = () => save({ blur: $('blur').checked });
$('emoji').onchange = () => save({ emoji: $('emoji').checked });
$('clock').onchange = () => save({ clock: $('clock').checked });
// Reading the most-visited list is an optional permission: Chrome asks the first time it's switched on.
$('frequent').onchange = async () => {
  const on = $('frequent').checked && await chrome.permissions.request({ permissions: ['topSites'] }).catch(() => false);
  $('frequent').checked = on;
  save({ frequent: on });
};

// Connect asks Google for read-only calendar access (Google shows its own consent screen);
// Disconnect revokes it. The token itself stays with Chrome.
$('calendar-button').onclick = async () => {
  const button = $('calendar-button');
  button.disabled = true;
  if (settings.calendar) {
    await disconnectCalendar();
    await save({ calendar: false });
  } else if (await connectCalendar()) {
    await save({ calendar: true });
  } else {
    $('calendar-status').textContent = "Couldn't connect. Make sure you're signed in to Chrome, then try again.";
  }
  button.disabled = false;
};

function showCalendar() {
  const ready = calendarConfigured();
  $('calendar-button').hidden = !ready;
  $('calendar-button').textContent = settings.calendar ? 'Disconnect' : 'Connect';
  $('calendar-status').textContent = !ready
    ? 'Needs a one-time setup: an OAuth client ID in manifest.json.'
    : settings.calendar ? 'Connected' : 'Not connected';
}

// One swatch per wallpaper; keys come from the fixed WALLPAPERS list, never from storage.
for (const [key, name] of Object.entries(WALLPAPERS)) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  const swatch = document.createElement('span');
  const text = document.createElement('span');
  label.className = 'swatch-option';
  input.type = 'radio';
  input.name = 'wallpaper';
  input.value = key;
  input.onchange = () => save({ wallpaper: key });
  swatch.className = 'swatch';
  swatch.id = `swatch-${key}`;
  if (key !== 'custom') swatch.style.background = `var(--wp-${key})`;
  text.textContent = name;
  label.append(input, swatch, text);
  $('wallpapers').append(label);
}

function showError(message) {
  $('image-error').textContent = message;
  $('image-error').hidden = !message;
}

const toDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

$('image').onchange = async () => {
  const file = $('image').files[0];
  $('image').value = '';
  if (!file) return;
  showError('');
  try {
    if (file.size > MAX_UPLOAD) throw new RangeError('too big');
    // Decoding proves it's really an image; re-encoding strips everything but the pixels.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const dataUrl = await toDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
    await chrome.storage.local.set({ wallpaperImage: dataUrl });
    await save({ wallpaper: 'custom' });
  } catch (err) {
    console.error(err);
    showError(err instanceof RangeError
      ? 'That image is over 25 MB. Please choose a smaller one.'
      : "Couldn't use that file. Please choose a JPEG, PNG or WebP image.");
  }
};

$('remove-image').onclick = async () => {
  await chrome.storage.local.remove('wallpaperImage'); // the storage change refreshes the page
  save(s => (s.wallpaper === 'custom' ? { wallpaper: DEFAULTS.wallpaper } : {}));
};

// Built once: rebuilding on every save would throw away keyboard focus on the switch just toggled.
async function renderFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const folders = root.children.slice(1); // everything except the Bookmarks bar
  $('folders').replaceChildren(...folders.map(f => {
    const label = document.createElement('label');
    const name = document.createElement('span');
    const input = document.createElement('input');
    label.className = 'row';
    name.textContent = f.title;
    input.type = 'checkbox';
    input.className = 'switch';
    input.dataset.id = f.id;
    input.setAttribute('role', 'switch');
    input.onchange = () => {
      const show = input.checked;
      save(s => ({ hiddenFolders: show ? s.hiddenFolders.filter(id => id !== f.id) : [...new Set([...s.hiddenFolders, f.id])] }));
    };
    label.append(name, input);
    return label;
  }));
}

async function refresh() {
  settings = await getSettings();
  const image = await getWallpaperImage();
  $('cols').value = settings.cols;
  $('rows').value = settings.rows;
  $('blur').checked = settings.blur;
  $('emoji').checked = settings.emoji;
  $('clock').checked = settings.clock;
  $('frequent').checked = settings.frequent;
  showCalendar();
  for (const input of document.querySelectorAll('input[name="wallpaper"]')) {
    input.checked = input.value === (settings.wallpaper === 'custom' && !image ? DEFAULTS.wallpaper : settings.wallpaper);
  }
  // "Your image" only makes sense once there is one.
  const custom = $('swatch-custom');
  custom.style.background = image ? `url("${image}") center / cover` : '';
  custom.closest('label').hidden = !image;
  $('remove-image').hidden = !image;
  for (const input of document.querySelectorAll('#folders .switch')) {
    input.checked = !settings.hiddenFolders.includes(input.dataset.id);
  }
  await applyWallpaper(settings);
}

// ---- Clean up: duplicates and broken links ----
const results = $('cleanup-results');
const cleanupStatus = text => { $('cleanup-status').textContent = text; };

// Every bookmark with the folder it's in, e.g. "Bookmarks bar › Work".
async function allBookmarks() {
  const out = [];
  const walk = (n, path) => n.url ? out.push({ ...n, path }) : n.children?.forEach(c => walk(c, n.title ? [...path, n.title] : path));
  walk((await chrome.bookmarks.getTree())[0], []);
  return out;
}

function resultRow(b, note) {
  const row = document.createElement('div');
  const text = document.createElement('span');
  const name = document.createElement('span');
  const sub = document.createElement('small');
  const del = document.createElement('button');
  row.className = 'row';
  text.className = 'row-text';
  name.textContent = b.title || b.url;
  sub.className = 'row-sub';
  sub.textContent = `${note} · ${b.path.join(' › ')}`;
  text.title = b.url;
  text.append(name, sub);
  del.type = 'button';
  del.className = 'glass-button pill danger';
  del.textContent = 'Delete';
  del.onclick = async () => {
    await chrome.bookmarks.remove(b.id).catch(console.error);
    row.remove();
    results.hidden = !results.querySelector('.row[data-id]');
  };
  row.dataset.id = b.id;
  row.append(text, del);
  return row;
}

function showResults(rows, none) {
  results.replaceChildren(...rows);
  results.hidden = !rows.length;
  cleanupStatus(rows.length ? '' : none);
}

// Same page = same address ignoring the #part and a trailing slash. The oldest copy is kept.
const pageKey = url => { try { const u = new URL(url); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return url; } };

$('find-duplicates').onclick = async () => {
  const groups = Map.groupBy(await allBookmarks(), b => pageKey(b.url));
  const extra = [...groups.values()].flatMap(g => g.sort((a, b) => a.dateAdded - b.dateAdded).slice(1));
  const rows = extra.map(b => resultRow(b, 'Duplicate'));
  if (extra.length > 1) {
    const row = document.createElement('div');
    const all = document.createElement('button');
    row.className = 'row';
    row.append(Object.assign(document.createElement('span'), { textContent: `${extra.length} duplicates. The oldest copy of each is kept.` }));
    all.type = 'button';
    all.className = 'glass-button pill danger';
    all.textContent = 'Delete all';
    all.onclick = async () => {
      if (!confirm(`Delete ${extra.length} duplicate bookmarks?`)) return;
      for (const b of extra) await chrome.bookmarks.remove(b.id).catch(() => {}); // already gone: fine
      showResults([], 'Duplicates deleted.');
    };
    row.append(all);
    rows.unshift(row);
  }
  showResults(rows, 'No duplicates found.');
};

// Only a clear answer counts as broken: no server, a timeout, or "not found". Sites that refuse
// automated checks (403, 429…) are left alone. No cookies are sent.
async function linkProblem(url) {
  const opts = method => ({ method, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  try {
    let r = await fetch(url, opts('HEAD'));
    if (r.status === 405 || r.status === 501) { r = await fetch(url, opts('GET')); r.body?.cancel(); }
    return r.status === 404 || r.status === 410 ? `Not found (${r.status})` : null;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'Timed out' : "Couldn't connect";
  }
}

// Never probe this computer or the local network: loading a page there can change things (routers, printers, dev servers).
// ponytail: checks the name only; a public name that resolves to a private address still gets through.
function isPublicHost(url) {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !/[.:]/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return !/^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h); // URL() already wrote it as plain IPv4
  return !/^(::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(h);
}

const HOSTS = { origins: ['http://*/*', 'https://*/*'] };
$('check-links').onclick = async () => {
  const button = $('check-links');
  // Reading another site's response needs website access: asked for now, given back below.
  if (!await chrome.permissions.request(HOSTS).catch(() => false)) return cleanupStatus('Checking links needs access to websites.');
  button.disabled = true;
  results.replaceChildren();
  results.hidden = true;
  try {
    const list = (await allBookmarks()).filter(b => /^https?:/.test(b.url) && isPublicHost(b.url));
    let next = 0, done = 0;
    const worker = async () => {
      while (next < list.length) {
        const b = list[next++];
        const problem = await linkProblem(b.url);
        cleanupStatus(`Checked ${++done} of ${list.length}…`);
        if (problem) { results.append(resultRow(b, problem)); results.hidden = false; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker)); // ponytail: 6 at a time; plenty for a few thousand bookmarks
    cleanupStatus(results.children.length ? `Checked ${list.length} links. Offline or work-network pages can show up here too.` : `All ${list.length} links work.`);
  } finally {
    await chrome.permissions.remove(HOSTS).catch(() => {});
    button.disabled = false;
  }
};

// ---- Backup ----
const backupStatus = text => { $('backup-status').textContent = text; };

$('backup').onclick = async () => {
  const data = { app: 'awesome-bookmarks', version: 1, settings: await getSettings(), tasks: await getTasks() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `awesome-bookmarks-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  backupStatus(`Saved ${data.tasks.length} tasks and your settings.`);
};

// A backup file is untrusted input: size-capped, parsed as JSON only, and every value re-checked.
$('restore').onchange = async () => {
  const file = $('restore').files[0];
  $('restore').value = '';
  if (!file) return;
  let data;
  try {
    if (file.size > 1_000_000) throw new RangeError();
    data = JSON.parse(await file.text());
    if (data?.app !== 'awesome-bookmarks' || typeof data.settings !== 'object' || !data.settings) throw new TypeError();
  } catch {
    return backupStatus("That file isn't an Awesome bookmarks backup.");
  }
  if (!confirm('Replace your settings and tasks with the ones in this backup?')) return;
  try {
    const tasks = cleanTasks(data.tasks);
    // Frequent sites needs a permission this computer may not have given.
    const frequent = data.settings.frequent === true && await chrome.permissions.contains({ permissions: ['topSites'] });
    // Write the backup's tasks before removing any, so a failed save never leaves you with none.
    const old = await getTasks();
    await saveTasks(tasks);
    const keep = new Set(tasks.map(t => t.id));
    await removeTasks(old.filter(t => !keep.has(t.id)));
    await save(sanitize({ ...DEFAULTS, ...data.settings, frequent }));
    backupStatus(`Restored ${tasks.length} tasks and your settings.`);
  } catch (err) {
    console.error(err);
    backupStatus("Couldn't restore that backup. Please try again.");
  }
};

// Opened from a new tab, Chrome shows settings in that same tab: go back to it rather than close it.
// Opened on their own (e.g. from chrome://extensions), settings have their own tab, which is closed.
// (Settings are already saved, so there's nothing to confirm.)
async function closeSettings() {
  if (history.length > 1) return history.back();
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
  else window.close();
}
$('close').onclick = closeSettings;
document.addEventListener('keydown', e => {
  // Esc in an open dropdown just closes the dropdown.
  if (e.key === 'Escape' && !e.target.matches('select')) closeSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (settingsChanged(changes, area) || 'wallpaperImage' in changes) refresh();
});
renderFolders().catch(console.error).finally(refresh);
