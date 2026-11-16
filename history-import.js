// Add bookmarks from browsing history: search, tick one or more pages, pick a folder, add.
// History access is an optional permission: Chrome asks the first time this is used, not at install.
const importer = document.getElementById('importer');
const importerQuery = document.getElementById('importer-query');
const importerList = document.getElementById('importer-list');
const importerNote = document.getElementById('importer-note');
const importerFolder = document.getElementById('importer-folder');
const importerName = document.getElementById('importer-new-folder');
const importerAdd = document.getElementById('importer-add');
const NEW_FOLDER = 'new';
const picked = new Map(); // url -> title; kept while the search changes, so picks can span several searches

document.getElementById('import-history').onclick = async () => {
  // Asked straight from the click (Chrome requires that); resolves at once if already granted.
  const granted = await chrome.permissions.request({ permissions: ['history'] }).catch(() => false);
  if (!granted) return;
  picked.clear();
  importerQuery.value = '';
  fillFolders();
  importer.showModal();
  importerQuery.focus();
  searchHistory();
};
document.getElementById('importer-close').onclick = () => importer.close();

// Every folder, shown as a path ("Bookmarks bar / Work"), plus "New folder…".
function fillFolders() {
  const path = f => (f.parentId && f.parentId !== rootId ? `${path(nodes.get(f.parentId))} / ` : '') + f.title;
  const folders = [...nodes.values()].filter(n => !n.url && n.id !== rootId);
  importerFolder.replaceChildren(...folders.map(f => new Option(path(f), f.id)), new Option('New folder…', NEW_FOLDER));
  importerFolder.value = bar.id;
  importerName.hidden = true;
  importerName.value = '';
}

let searchTimer, searchRun = 0;
importerQuery.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchHistory, 150); });

async function searchHistory() {
  const run = ++searchRun;
  const text = importerQuery.value.trim();
  // startTime 0: all the history Chrome keeps (by default it would only look at the last day).
  const results = await chrome.history.search({ text, startTime: 0, maxResults: 1000 });
  if (run !== searchRun) return; // a newer search has started; don't overwrite it
  const saved = new Set([...nodes.values()].filter(n => n.url).map(n => n.url));
  const items = results
    .filter(h => isSafe(h.url))
    .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitTime - a.lastVisitTime)
    .slice(0, 100);
  importerList.replaceChildren(...items.map(h => historyRow(h, saved.has(h.url))));
  importerList.scrollTop = 0;
  importerNote.hidden = items.length > 0;
  importerNote.textContent = text ? 'Nothing in your history matches that.' : 'Your history is empty.';
  updateAddButton();
}

function historyRow(h, saved) {
  const title = (h.title || '').trim().slice(0, 255) || hostname(h.url);
  const row = document.createElement('label');
  const box = document.createElement('input');
  const icon = el('span', 'history-icon');
  const text = el('span', 'history-text');
  row.className = 'history-row';
  box.type = 'checkbox';
  box.checked = saved || picked.has(h.url);
  box.disabled = saved; // already a bookmark
  box.onchange = () => {
    if (box.checked) picked.set(h.url, title);
    else picked.delete(h.url);
    updateAddButton();
  };
  icon.append(img({ url: h.url, title })); // the grid's icon logic: favicon, or a letter tile when there's none
  text.append(el('span', 'history-title', title), el('span', 'history-url', h.url.replace(/^https?:\/\//, '')));
  row.title = h.url;
  row.append(box, icon, text, saved ? el('span', 'history-count saved', '✓ Already saved') : el('span', 'history-count', `${h.visitCount}×`));
  return row;
}

importerFolder.onchange = () => {
  importerName.hidden = importerFolder.value !== NEW_FOLDER;
  if (!importerName.hidden) importerName.focus();
  updateAddButton();
};
importerName.addEventListener('input', updateAddButton);

function updateAddButton() {
  const n = picked.size;
  importerAdd.textContent = n ? `Add ${n} bookmark${n === 1 ? '' : 's'}` : 'Add';
  importerAdd.disabled = !n || (importerFolder.value === NEW_FOLDER && !importerName.value.trim());
}

importerAdd.onclick = async () => {
  importerAdd.disabled = true;
  try {
    let parentId = importerFolder.value, folderName = importerFolder.selectedOptions[0]?.textContent.trim();
    const newFolder = parentId === NEW_FOLDER && await chrome.bookmarks.create({ parentId: bar.id, title: importerName.value.trim() });
    if (newFolder) [parentId, folderName] = [newFolder.id, newFolder.title];
    const made = [];
    for (const [url, title] of picked) made.push(await chrome.bookmarks.create({ parentId, title, url }));
    importer.close();
    // Say where they went, with an Undo like deleting has.
    offerUndo(`Added ${made.length} bookmark${made.length === 1 ? '' : 's'} to ${folderName}`, async () => {
      if (newFolder) await chrome.bookmarks.removeTree(newFolder.id);
      else for (const b of made) await chrome.bookmarks.remove(b.id);
    });
  } catch (err) {
    console.error(err);
    importerNote.textContent = "Couldn't add them. Please try again.";
    importerNote.hidden = false;
    updateAddButton();
  }
};
