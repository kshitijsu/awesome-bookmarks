// Widgets on the new tab: a clock, the next meeting from Google Calendar, and a row of frequent sites.
const clockEl = document.getElementById('clock');
const meetingEl = document.getElementById('meeting');
const timeOf = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---- Clock ----

function tick() {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; // read each time: it changes when travelling
  const offset = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value;
  document.getElementById('clock-time').textContent = timeOf(now);
  document.getElementById('clock-time').dateTime = now.toISOString();
  document.getElementById('clock-sub').textContent =
    `${now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${zone.replaceAll('_', ' ')} (${offset})`;
  if (meeting) showMeeting(); // keep "in 12 min" current
  if (meeting && now >= meeting.end) refreshMeeting(); // it's over: look for the next one
}

// Tick exactly on the minute, so the display changes when the time does.
setTimeout(() => { tick(); setInterval(tick, 60_000); }, 60_000 - (Date.now() % 60_000));

// ---- Next meeting ----

let meeting = null; // { title, start, end, link, join }
let calendarState = 'off'; // off | connect | ok | error

const httpsUrl = u => { try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; } };

// Today's remaining events, soonest first. Throws { status } on HTTP errors.
async function todaysEvents(token) {
  const now = new Date(), endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const query = new URLSearchParams({
    timeMin: now.toISOString(), // includes a meeting that's already started but not ended
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
    fields: 'items(summary,status,start,end,hangoutLink,htmlLink,conferenceData(entryPoints(entryPointType,uri)),attendees(self,responseStatus))',
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Calendar request failed (${res.status})`), { status: res.status });
  return (await res.json()).items || [];
}

// A meeting: timed (not all-day), not cancelled, not one I've declined.
const isMeeting = e => e.status !== 'cancelled' && e.start?.dateTime
  && !e.attendees?.some(a => a.self && a.responseStatus === 'declined');

async function refreshMeeting() {
  const s = await getSettings();
  if (!s.calendar || !googleConfigured()) {
    calendarState = 'off';
    meeting = null;
    return showMeeting();
  }
  try {
    let token = await calendarToken(false);
    if (!token) { calendarState = 'connect'; meeting = null; return showMeeting(); }
    let events;
    try {
      events = await todaysEvents(token);
    } catch (err) {
      if (err.status !== 401) throw err;
      await chrome.identity.removeCachedAuthToken({ token }); // expired: Chrome fetches a fresh one
      token = await calendarToken(false);
      events = token ? await todaysEvents(token) : null;
      if (!events) { calendarState = 'connect'; meeting = null; return showMeeting(); }
    }
    const e = events.find(isMeeting);
    meeting = e && {
      title: (e.summary || '').trim() || '(No title)',
      start: new Date(e.start.dateTime),
      end: new Date(e.end.dateTime),
      link: httpsUrl(e.htmlLink),
      join: httpsUrl(e.hangoutLink || e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri),
    };
    calendarState = 'ok';
  } catch (err) {
    console.error(err);
    calendarState = 'error';
  }
  showMeeting();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text; // calendar text is never treated as HTML
  return node;
}

function untilText(start, end, now = new Date()) {
  if (now >= start) return `Until ${timeOf(end)}`; // the label above already says "Now"
  const mins = Math.round((start - now) / 60_000);
  const inText = mins < 1 ? 'starting now' : mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ''}`.trim();
  return `${timeOf(start)} – ${timeOf(end)} · ${inText}`;
}

function showMeeting() {
  meetingEl.hidden = calendarState === 'off';
  if (meetingEl.hidden) return;
  const label = el('span', 'widget-label', meeting && new Date() >= meeting.start ? 'Now' : 'Next meeting');
  if (calendarState === 'connect') {
    const connect = el('button', 'glass-button pill primary', 'Connect Google Calendar');
    connect.type = 'button';
    connect.onclick = async () => { if (await connectCalendar()) refreshMeeting(); }; // consent needs this click
    return meetingEl.replaceChildren(el('span', 'widget-label', 'Next meeting'), connect);
  }
  if (calendarState === 'error') return meetingEl.replaceChildren(label, el('span', 'widget-sub', "Couldn't load your calendar."));
  if (!meeting) return meetingEl.replaceChildren(label, el('span', 'widget-title', 'No more meetings today'));

  const title = el(meeting.link ? 'a' : 'span', 'widget-title', meeting.title);
  title.title = meeting.title;
  if (meeting.link) { title.href = meeting.link; title.target = '_blank'; title.rel = 'noopener'; }
  const parts = [label, title, el('span', 'widget-sub', untilText(meeting.start, meeting.end))];
  if (meeting.join) {
    const join = el('a', 'glass-button pill primary join', 'Join');
    join.href = meeting.join;
    join.target = '_blank';
    join.rel = 'noopener';
    parts.push(join);
  }
  meetingEl.replaceChildren(...parts);
}

// ---- Frequent sites ----
// Chrome's own most-visited list (what its default new tab shows), as a small row under the search field.
// Needs the optional "topSites" permission, which the settings switch asks for.
const frequentEl = document.getElementById('frequent');

async function showFrequent(on) {
  const allowed = on && await chrome.permissions.contains({ permissions: ['topSites'] });
  const sites = allowed ? await chrome.topSites.get() : [];
  frequentEl.replaceChildren(...sites.filter(s => ['http:', 'https:'].includes(scheme(s.url))).slice(0, 8).map(s => {
    const a = el('a', 'frequent-site');
    a.href = s.url;
    a.draggable = false;
    a.title = s.title || hostname(s.url);
    a.setAttribute('aria-label', a.title);
    a.append(img({ url: s.url, title: s.title })); // favicon, or a letter tile, like the grid
    return a;
  }));
  frequentEl.hidden = !frequentEl.children.length;
}

// ---- Wiring ----

async function applyWidgets() {
  const s = await getSettings();
  clockEl.hidden = !s.clock;
  showFrequent(s.frequent).catch(console.error);
  refreshMeeting();
}
chrome.storage.onChanged.addListener((changes, area) => { if (settingsChanged(changes, area)) applyWidgets(); });
chrome.permissions.onRemoved.addListener(applyWidgets); // access taken away in chrome://extensions
// Coming back to the tab (or waking the laptop): catch the clock up and re-check the calendar.
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); applyWidgets().catch(console.error); } });
setInterval(() => { if (!document.hidden) refreshMeeting(); }, 5 * 60_000); // pick up newly added meetings

tick();
applyWidgets().catch(console.error);
