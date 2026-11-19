const $ = id => document.getElementById(id);

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
$('theme').onchange = () => save({ theme: THEMES.includes($('theme').value) ? $('theme').value : DEFAULTS.theme });
$('view').onchange = () => save({ view: $('view').value === 'list' ? 'list' : 'grid' });
$('rows').onchange = () => save({ rows: Number($('rows').value) });
$('blur').onchange = () => save({ blur: $('blur').checked });
$('icon-style').onchange = () => save({ iconStyle: ICON_STYLES.includes($('icon-style').value) ? $('icon-style').value : DEFAULTS.iconStyle });
$('clock').onchange = () => save({ clock: $('clock').checked });
$('name').onchange = () => save({ name: $('name').value });

// The city is looked up once, here (Open-Meteo's free geocoder); the new tab then asks for that place's weather only.
async function findPlace(query) {
  const lang = /^[a-z]{2}/.exec(navigator.language)?.[0] || 'en';
  const q = new URLSearchParams({ name: query.slice(0, 100), count: '1', language: lang, format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`, { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const r = (await res.json())?.results?.[0];
  return r ? cleanPlace({ name: [r.name, r.country].filter(t => typeof t === 'string').join(', '), lat: r.latitude, lon: r.longitude }) : null;
}
$('place').onchange = async () => {
  const query = $('place').value.trim();
  if (!query) return save({ place: null });
  $('place-status').textContent = 'Looking up…';
  try {
    const place = await findPlace(query);
    if (place) await save({ place });
    else $('place-status').textContent = `Couldn't find “${query.slice(0, 40)}”`;
  } catch (err) {
    console.warn(err.message);
    $('place-status').textContent = "Couldn't reach the weather service";
  }
};
// Reading the most-visited list is an optional permission: Chrome asks the first time it's switched on.
$('frequent').onchange = async () => {
  const on = $('frequent').checked && await chrome.permissions.request({ permissions: ['topSites'] }).catch(() => false);
  $('frequent').checked = on;
  save({ frequent: on });
};

// Connect asks Google for read-only calendar access (Google shows its own consent screen);
// Disconnect revokes it. The token itself stays with Chrome.
// Each connection is in one of these states, with the button doing the next sensible thing:
// Not connected → Connect · Connecting… · Connected → Disconnect · Sign-in expired → Reconnect · Failed → Reconnect.
const NEEDS_SETUP = 'Needs a one-time setup: a Google OAuth client ID (see .env.example).';
async function connecting(which, run) {
  const button = $(`${which}-button`), status = $(`${which}-status`);
  button.disabled = true;
  button.textContent = 'Connecting…';
  status.textContent = 'Waiting for Google…';
  const problem = await run().then(() => '', err => { console.warn(`${which}:`, err.message); return googleError(err); });
  button.disabled = false;
  await refresh();
  if (problem) status.textContent = problem;
}

// The new tab reports whether the calendar last loaded ('ok'), lost its sign-in ('connect') or failed ('error').
const calendarHealth = async () => (await chrome.storage.local.get('calendarHealth')).calendarHealth;
$('calendar-button').onclick = async () => {
  const health = await calendarHealth();
  if (settings.calendar && health !== 'connect') {
    $('calendar-button').disabled = true;
    await disconnectCalendar();
    await save({ calendar: false });
    $('calendar-button').disabled = false;
    return;
  }
  await connecting('calendar', async () => {
    await connectCalendar();
    await chrome.storage.local.remove('calendarHealth'); // the next new tab reports afresh
    await save({ calendar: true });
  });
};

// Drive sync is set up per computer (Chrome asks for sign-in on each), so its state lives in local storage.
$('drive-button').onclick = async () => {
  const drive = await getDrive();
  if (drive.on && !['failed', 'expired'].includes(drive.error)) {
    $('drive-button').disabled = true;
    await disconnectDrive(settings.calendar);
    $('drive-button').disabled = false;
    return;
  }
  await connecting('drive', connectDrive);
};

async function showDrive() {
  const ready = googleConfigured();
  const d = await getDrive();
  $('drive-button').hidden = !ready;
  $('drive-button').textContent = !d.on ? 'Connect' : ['failed', 'expired'].includes(d.error) ? 'Reconnect' : 'Disconnect';
  $('drive-status').textContent = !ready ? NEEDS_SETUP
    : !d.on ? 'Not connected'
    : d.error === 'too big' ? 'Too big to sync (over 5 MB). Use fewer pictures or a smaller wallpaper.'
    : d.error === 'expired' ? 'Sign-in expired. Reconnect to keep syncing.'
    : d.error === 'failed' ? "Couldn't reach Google Drive. It tries again on its own, or reconnect."
    : d.dirty || !d.syncedAt ? 'Syncing…'
    : `Connected · synced ${new Date(d.syncedAt).toLocaleString()}`;
}

async function showCalendar() {
  const ready = googleConfigured(), health = settings.calendar ? await calendarHealth() : null;
  $('calendar-button').hidden = !ready;
  $('calendar-button').textContent = !settings.calendar ? 'Connect' : health === 'connect' ? 'Reconnect' : 'Disconnect';
  $('calendar-status').textContent = !ready ? NEEDS_SETUP
    : !settings.calendar ? 'Not connected'
    : health === 'connect' ? 'Sign-in expired. Reconnect to see your meetings.'
    : health === 'error' ? "Couldn't reach Google Calendar. The new tab tries again every few minutes."
    : 'Connected';
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
  input.onchange = () => { save({ wallpaper: key }); if (key === 'daily') refreshDaily(); };
  swatch.className = 'swatch';
  swatch.id = `swatch-${key}`;
  if (!['custom', 'daily'].includes(key)) swatch.style.background = `var(--wp-${key})`;
  text.textContent = name;
  label.append(input, swatch, text);
  $('wallpapers').append(label);
}

function showError(message) {
  $('image-error').textContent = message;
  $('image-error').hidden = !message;
}

$('image').onchange = async () => {
  const file = $('image').files[0];
  $('image').value = '';
  if (!file) return;
  showError('');
  try {
    const dataUrl = await encodeImage(file);
    await chrome.storage.local.set({ wallpaperImage: dataUrl });
    await save({ wallpaper: 'custom' });
    syncDrive(true);
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
  syncDrive(true);
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
  $('theme').value = settings.theme;
  $('view').value = settings.view;
  $('cols').value = settings.cols;
  $('rows').value = settings.rows;
  $('blur').checked = settings.blur;
  $('icon-style').value = settings.iconStyle;
  $('clock').checked = settings.clock;
  $('frequent').checked = settings.frequent;
  if (document.activeElement !== $('name')) $('name').value = settings.name;
  if (document.activeElement !== $('place')) $('place').value = settings.place?.name || '';
  $('place-status').textContent = settings.place ? 'On the clock' : 'Type a city to show it';
  await showCalendar();
  await showDrive();
  for (const input of document.querySelectorAll('input[name="wallpaper"]')) {
    input.checked = input.value === (settings.wallpaper === 'custom' && !image ? DEFAULTS.wallpaper : settings.wallpaper);
  }
  const daily = await getDaily();
  $('swatch-daily').style.background = daily ? `url("${daily.image}") center / cover` : 'linear-gradient(135deg, #5f8fb8, #d9a86c)';
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
// Redirects are never followed (they could point into this computer or the local network): a redirect means the link works.
async function linkProblem(url) {
  const opts = method => ({ method, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  try {
    let r = await fetch(url, opts('HEAD'));
    if (r.type === 'opaqueredirect') return null;
    if (r.status === 405 || r.status === 501) { r = await fetch(url, opts('GET')); r.body?.cancel(); }
    if (r.type === 'opaqueredirect') return null;
    return r.status === 404 || r.status === 410 ? `Not found (${r.status})` : null;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'Timed out' : "Couldn't connect";
  }
}

// Never probe this computer or the local network: loading a page there can change things (routers, printers, dev servers).
// ponytail: checks the name only (extension pages can't look up DNS); a public name that resolves to a private
// address still gets through. Not following redirects keeps that to the bookmarked address itself.
function isPublicHost(url) {
  let h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, ''); // "localhost." is localhost
  // IPv4 written as IPv6 (URL() turns ::ffff:127.0.0.1 into ::ffff:7f00:1): judge the IPv4 inside.
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    h = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !/[.:]/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { // URL() already wrote it as plain IPv4
    return !/^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  }
  // IPv6: only global unicast (2000::/3), minus NAT64, 6to4 and Teredo, which can wrap a private IPv4 address.
  return !h.includes(':') || (/^[23][0-9a-f]{0,3}:/.test(h) && !/^(64:ff9b:|2002:|2001:0?:)/.test(h));
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

// Downloads a backup of what's here now; also run just before a restore replaces it, so a restore can be undone.
async function downloadBackup(name = 'backup') {
  const data = { app: 'awesome-bookmarks', version: 1, settings: await getSettings(), tasks: await getTasks(), notes: await getNotes() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `awesome-bookmarks-${name}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return data;
}
$('backup').onclick = async () => {
  const data = await downloadBackup();
  backupStatus(`Saved ${data.tasks.length} tasks, your notes and your settings.`);
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
  const tasks = cleanTasks(data.tasks), current = (await getTasks()).length, withNotes = typeof data.notes === 'string';
  if (!confirm(`Restore this backup?\n\nIt replaces your settings and your ${current} task${current === 1 ? '' : 's'} with its ${tasks.length}`
    + `${withNotes ? ', and your notes with its notes' : ' (your notes stay: it has none)'}.\n\n`
    + 'A copy of what you have now is downloaded first, so you can restore that to undo this.')) return;
  try {
    await downloadBackup('before-restore');
    // Frequent sites needs a permission this computer may not have given.
    const frequent = data.settings.frequent === true && await chrome.permissions.contains({ permissions: ['topSites'] });
    // Write the backup's tasks before removing any, so a failed save never leaves you with none.
    const old = await getTasks();
    await saveTasks(tasks);
    const keep = new Set(tasks.map(t => t.id));
    await removeTasks(old.filter(t => !keep.has(t.id)));
    await save(sanitize({ ...DEFAULTS, ...data.settings, frequent }));
    if (typeof data.notes === 'string') await chrome.storage.sync.set({ notes: data.notes.slice(0, MAX_NOTES) }); // older backups have none: keep yours
    backupStatus(`Restored ${tasks.length} tasks, your notes and your settings.`);
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
  if (settingsChanged(changes, area) || 'wallpaperImage' in changes || 'daily' in changes || 'drive' in changes || 'calendarHealth' in changes) refresh();
});

// Side menu: mark the section at the top of the window (the last one whose heading has scrolled past a line
// near the top; at the very bottom, the last section, which may be too short to reach that line).
// A link you click stays marked while its section is on screen, even when the page can't scroll it to the top.
const tocLinks = [...document.querySelectorAll('#toc a')];
let picked = null;
for (const a of tocLinks) a.addEventListener('click', () => { picked = a; requestAnimationFrame(markSection); }); // also when the page doesn't move
const markSection = () => {
  const top = a => document.querySelector(a.hash).getBoundingClientRect().top;
  if (picked && !(top(picked) >= 0 && top(picked) < innerHeight)) picked = null;
  const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
  const current = picked || (atEnd ? tocLinks.at(-1) : tocLinks.findLast(a => top(a) < 120) || tocLinks[0]);
  for (const a of tocLinks) a.setAttribute('aria-current', a === current);
};
addEventListener('scroll', markSection, { passive: true });
markSection();
renderFolders().catch(console.error).finally(refresh);
