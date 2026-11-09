// Dev only: reload the page when one of its files changes on disk.
// Runs only for an unpacked ("Load unpacked") install, so it's inert once published.
// manifest.json changes still need the reload button on chrome://extensions.
const WATCHED = ['newtab.html', 'glass.css', 'style.css','app.js', 'settings.js', 'wallpaper.css', 'options.html', 'options.css', 'options.js', 'widgets.js', 'history-import.js', 'tasks.js'];

chrome.management.getSelf(async self => {
  if (self.installType !== 'development') return;
  const read = () => Promise.all(WATCHED.map(f => fetch(f, { cache: 'no-store' }).then(r => r.text())));
  const before = (await read()).join('\0');
  setInterval(async () => {
    const now = await read().then(t => t.join('\0'), () => before); // ignore a read caught mid-save
    if (now !== before) location.reload();
  }, 1000);
});
