// Tasks: a small to-do list in a panel on the right of the new tab.
// Kept in chrome.storage.sync (see settings.js), so they follow you to other computers signed in to Chrome
// and update live between open new tabs. Whether the panel is open stays per computer.
const tasksPanel = document.getElementById('tasks');
const tasksToggle = document.getElementById('tasks-toggle');
const tasksList = document.getElementById('tasks-list');
const tasksNew = document.getElementById('tasks-new');
const tasksCount = document.getElementById('tasks-count');
const tasksClear = document.getElementById('tasks-clear');
let tasks = []; // [{ id, text, done, at }]

const store = promise => promise.catch(console.error);

function showTasks(open) {
  tasksPanel.hidden = !open;
  tasksToggle.setAttribute('aria-expanded', open);
  document.body.classList.toggle('tasks-open', open);
  // The grid and the Dock make room for the panel.
  main.layout();
  dockPager.layout();
}
tasksToggle.onclick = () => {
  const open = tasksPanel.hidden;
  showTasks(open);
  store(chrome.storage.local.set({ tasksOpen: open }));
  if (open) tasksNew.focus();
};
document.getElementById('tasks-close').onclick = () => tasksToggle.click();
// Escape closes the panel and returns to its button (in a task's text, Escape first undoes the edit).
tasksPanel.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.target.matches('.task-text')) return;
  e.preventDefault();
  e.stopPropagation(); // the page's own Escape (clear search, blur) must not take focus back off the button
  tasksToggle.click();
  tasksToggle.focus();
});
// Option+T (Alt+T) opens or closes the panel from anywhere, even while typing.
document.addEventListener('keydown', e => {
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyT') {
    e.preventDefault();
    tasksToggle.click();
  }
});

function countTasks() {
  const left = tasks.filter(t => !t.done).length;
  tasksCount.textContent = tasks.length ? `${left} left` : '';
  tasksClear.hidden = left === tasks.length;
}

function renderTasks() {
  tasksList.replaceChildren(...tasks.map(taskRow));
  countTasks();
}

function taskRow(t) {
  const li = el('li', t.done ? 'task done' : 'task');
  const box = document.createElement('input');
  const text = document.createElement('input');
  const del = el('button', 'task-delete', '×');
  box.type = 'checkbox';
  box.checked = t.done;
  box.setAttribute('aria-label', 'Done');
  box.onchange = () => {
    t.done = box.checked;
    li.classList.toggle('done', t.done);
    countTasks();
    store(saveTasks([t]));
  };
  // The text is an input: click to edit, Enter or click away to save, Esc to undo, empty to delete.
  text.className = 'task-text';
  text.value = t.text;
  text.maxLength = MAX_TEXT;
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Task');
  text.onchange = () => {
    const v = text.value.trim();
    if (!v) return removeTask(t);
    t.text = v;
    store(saveTasks([t]));
  };
  text.onkeydown = e => {
    if (e.key === 'Enter') text.blur();
    if (e.key === 'Escape') { text.value = t.text; text.blur(); }
  };
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete task');
  del.onclick = () => removeTask(t);
  li.append(box, text, del);
  return li;
}

function removeTask(t) {
  tasks = tasks.filter(x => x !== t);
  renderTasks();
  store(removeTasks([t]));
}

document.getElementById('tasks-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = tasksNew.value.trim().slice(0, MAX_TEXT);
  if (!text || tasks.length >= MAX_TASKS) return;
  const t = { id: crypto.randomUUID(), text, done: false, at: Date.now() };
  tasks.push(t);
  tasksNew.value = '';
  renderTasks();
  store(saveTasks([t]));
});

tasksClear.onclick = () => {
  const done = tasks.filter(t => t.done);
  tasks = tasks.filter(t => !t.done);
  renderTasks();
  store(removeTasks(done));
};

// Another new tab or computer changed the list: show it, unless a task is being edited here right now.
const reloadTasks = async () => { tasks = await getTasks(); renderTasks(); };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !Object.keys(changes).some(isTaskKey) || tasksList.contains(document.activeElement)) return;
  reloadTasks().catch(console.error);
});

// ---- Focus timer ----
// The end time is kept on this computer, so the timer carries on across new tabs and after closing them.
// ponytail: it only rings in a new tab that's in front when time's up; ringing from the background needs a service worker.
const FOCUS = { focus: [25, 'Focus'], break: [5, 'Break'] };
const focusTime = document.getElementById('focus-time');
const focusLabel = document.getElementById('focus-label');
const focusStart = document.getElementById('focus-start');
const focusBreak = document.getElementById('focus-break');
const focusStop = document.getElementById('focus-stop');
const pageTitle = document.title;
let focusRun = null, focusTick = null, focusDone = '';
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

async function readFocus() {
  const { focus: f } = await chrome.storage.local.get('focus');
  return f && Object.hasOwn(FOCUS, f.kind) && Number.isFinite(f.endsAt) && f.endsAt - Date.now() <= FOCUS[f.kind][0] * 60_000 ? { kind: f.kind, endsAt: f.endsAt } : null;
}
function showFocus() {
  const left = focusRun ? focusRun.endsAt - Date.now() : 0;
  if (focusRun && left <= 0) return finishFocus();
  focusTime.textContent = focusRun ? mmss(left) : '25:00';
  focusLabel.textContent = focusRun ? FOCUS[focusRun.kind][1] : focusDone || 'Ready';
  focusStart.hidden = focusBreak.hidden = !!focusRun;
  focusStop.hidden = !focusRun;
  document.title = focusRun ? `${mmss(left)} · ${FOCUS[focusRun.kind][1]}` : pageTitle;
}
function setFocus(run) {
  focusRun = run;
  clearInterval(focusTick);
  focusTick = run ? setInterval(showFocus, 1000) : null;
  showFocus();
}
function finishFocus() {
  const { kind, endsAt } = focusRun;
  focusDone = kind === 'focus' ? 'Done: time for a break' : 'Break over';
  setFocus(null);
  if (document.visibilityState === 'visible' && Date.now() - endsAt < 60_000) chime(); // not for one that ended long ago
  store(chrome.storage.local.remove('focus'));
}
// Two soft notes, made on the spot: no sound file to load.
function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime + i * 0.25;
      osc.frequency.value = freq;
      osc.connect(gain).connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.start(t);
      osc.stop(t + 0.65);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* no sound available: the label still says it's done */ }
}
const startFocus = kind => {
  focusDone = '';
  const run = { kind, endsAt: Date.now() + FOCUS[kind][0] * 60_000 };
  setFocus(run);
  store(chrome.storage.local.set({ focus: run }));
};
focusStart.onclick = () => startFocus('focus');
focusBreak.onclick = () => startFocus('break');
focusStop.onclick = () => { focusDone = ''; setFocus(null); store(chrome.storage.local.remove('focus')); };
// Started, stopped or finished in another new tab.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !('focus' in changes)) return;
  const run = await readFocus();
  if (!run && !focusRun) return; // this tab's own finish or stop: keep its "Done" label
  if (!run && focusRun.endsAt - Date.now() < 1500) return finishFocus();
  focusDone = '';
  setFocus(run);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) showFocus(); });
readFocus().then(setFocus).catch(console.error);

// ---- Notes ----
// Saved once typing pauses (sync allows about one write every two seconds), and when leaving the box.
const notesEl = document.getElementById('notes');
const notesStatus = document.getElementById('notes-status');
let notesTimer = null;
const saveNotes = () => {
  clearTimeout(notesTimer);
  notesTimer = null;
  store(chrome.storage.sync.set({ notes: notesEl.value.slice(0, MAX_NOTES) }).then(() => { notesStatus.textContent = 'Saved'; }));
};
notesEl.addEventListener('input', () => { notesStatus.textContent = ''; clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 1500); });
notesEl.addEventListener('blur', () => { if (notesTimer) saveNotes(); });
// Changed in another tab or on another computer: show it, unless you're typing here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'notes' in changes && document.activeElement !== notesEl) getNotes().then(n => { notesEl.value = n; }).catch(console.error);
});
getNotes().then(n => { notesEl.value = n; }).catch(console.error);

(async () => {
  // Version 1.3 kept tasks on this computer only: move them into sync once.
  const { tasks: old, tasksOpen } = await chrome.storage.local.get(['tasks', 'tasksOpen']);
  if (old) {
    await saveTasks(cleanTasks(old).map((t, i) => ({ ...t, at: i })));
    await chrome.storage.local.remove('tasks');
  }
  await reloadTasks();
  if (tasksOpen === true) showTasks(true);
})().catch(console.error);
