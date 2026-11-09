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
