// Widgets on the new tab: a greeting above the search field, a clock, the next meeting from Google Calendar, and a row of frequent sites.
const clockEl = document.getElementById('clock');
const meetingEl = document.getElementById('meeting');
let hour12; // undefined: the computer's own 12/24-hour style
let userName = '';
const timeOf = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });

// ---- Clock ----

function tick() {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; // read each time: it changes when travelling
  const offset = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value;
  const h = now.getHours(), part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening';
  document.getElementById('greeting').textContent = `Good ${part}${userName ? `, ${userName}` : ''}`;
  document.getElementById('clock-time').textContent = timeOf(now);
  document.getElementById('clock-time').dateTime = now.toISOString();
  // Short: the date and the zone's city ("Asia/Calcutta" → "Calcutta"); the full zone and offset on hover.
  const sub = document.getElementById('clock-sub');
  sub.textContent = `${now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${zone.split('/').pop().replaceAll('_', ' ')}`;
  sub.title = `${zone.replaceAll('_', ' ')} (${offset})`;
  if (meeting) showMeeting(); // keep "in 12 min" current
  if (meeting && now >= meeting.end) refreshMeeting(); // it's over: look for the next one
}

// Clicking the time switches between 12- and 24-hour (meeting times follow), synced like other settings.
document.getElementById('clock-toggle').onclick = () => {
  const now12 = new Intl.DateTimeFormat([], { hour: 'numeric', hour12 }).resolvedOptions().hour12;
  chrome.storage.sync.set({ hour12: !now12 }).catch(console.error);
};

// Tick exactly on the minute, so the display changes when the time does.
setTimeout(() => { tick(); setInterval(tick, 60_000); }, 60_000 - (Date.now() % 60_000));

// ---- Next meeting ----

let meeting = null; // { title, start, end, link, join }
let calendarState = 'off'; // off | connect | ok | error
let calendarWhy = ''; // the last error, for the widget's tooltip

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
  if (!res.ok) {
    // Google says why in the body ("Calendar API has not been used in project…"); keep it, shown as plain text only.
    const why = await res.json().then(j => j?.error?.message, () => null);
    throw Object.assign(new Error(`Calendar request failed (${res.status})${typeof why === 'string' ? `: ${why.slice(0, 300)}` : ''}`), { status: res.status });
  }
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
    calendarWhy = err.message;
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
  // Tell the settings page how the connection is doing: 'connect' means the sign-in has expired.
  chrome.storage.local.get('calendarHealth').then(({ calendarHealth }) => {
    if (calendarHealth !== calendarState) return chrome.storage.local.set({ calendarHealth: calendarState });
  }).catch(console.error);
  meetingEl.hidden = calendarState === 'off';
  if (meetingEl.hidden) return;
  const label = el('span', 'widget-label', meeting && new Date() >= meeting.start ? 'Now' : 'Next meeting');
  if (calendarState === 'connect') {
    const connect = el('button', 'glass-button pill primary', 'Connect Google Calendar');
    connect.type = 'button';
    connect.onclick = () => connectCalendar().then(refreshMeeting, err => { // consent needs this click
      console.warn('Calendar:', err.message);
      connect.textContent = 'Couldn’t connect: see Settings';
      connect.title = googleError(err);
    });
    return meetingEl.replaceChildren(el('span', 'widget-label', 'Next meeting'), connect);
  }
  if (calendarState === 'error') {
    const sub = el('span', 'widget-sub', "Couldn't load your calendar.");
    sub.title = calendarWhy; // hover for Google's reason
    return meetingEl.replaceChildren(label, sub);
  }
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

// ---- Weather ----
// Open-Meteo (free, no key) for the city chosen in settings, never your location. Asked at most every 30 minutes.
const weatherEl = document.getElementById('weather');
const WEATHER_EVERY = 30 * 60_000;
const fahrenheit = /-US$/.test(navigator.language);
// WMO weather codes, by the highest code each covers: [max, day, night]
const WEATHER_ICONS = [[0, '☀️', '🌙'], [2, '⛅', '☁️'], [3, '☁️'], [48, '🌫️'], [57, '🌦️'], [67, '🌧️'], [77, '🌨️'], [82, '🌧️'], [86, '🌨️'], [99, '⛈️']];
const weatherIcon = (code, day) => { const [, d, n] = WEATHER_ICONS.find(([max]) => code <= max) || [0, '🌡️']; return (!day && n) || d; };

async function showWeather(place) {
  weatherEl.hidden = !place;
  if (!place) return;
  let { weather: w } = await chrome.storage.local.get('weather');
  // The saved reading is only used for the same place and units, and only once checked.
  if (!(w && w.lat === place.lat && w.lon === place.lon && w.f === fahrenheit && Number.isFinite(w.temp) && Number.isInteger(w.code) && Number.isFinite(w.at))) w = null;
  if (!w || Date.now() - w.at >= WEATHER_EVERY) {
    try {
      const q = new URLSearchParams({ latitude: place.lat, longitude: place.lon, current: 'temperature_2m,weather_code,is_day', ...(fahrenheit && { temperature_unit: 'fahrenheit' }) });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
      const c = res.ok ? (await res.json())?.current : null;
      if (!Number.isFinite(c?.temperature_2m) || !Number.isInteger(c?.weather_code)) throw new Error('Unexpected weather reply');
      w = { lat: place.lat, lon: place.lon, f: fahrenheit, at: Date.now(), temp: c.temperature_2m, code: c.weather_code, day: c.is_day !== 0 };
      await chrome.storage.local.set({ weather: w });
    } catch (err) {
      console.warn('Weather:', err.message);
      if (!w) { weatherEl.hidden = true; return; } // keep showing the last reading for this place
    }
  }
  // Beside the time: the temperature as large as the time, the city under it.
  weatherEl.replaceChildren(el('span', 'weather-temp', `${weatherIcon(w.code, w.day)} ${Math.round(w.temp)}°`), el('span', 'widget-sub weather-city', place.name.split(',')[0]));
  weatherEl.title = place.name;
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
  hour12 = s.hour12 ?? undefined;
  userName = s.name;
  tick();
  showFrequent(s.frequent).catch(console.error);
  showWeather(s.place).catch(console.error);
  refreshMeeting();
}
chrome.storage.onChanged.addListener((changes, area) => { if (settingsChanged(changes, area)) applyWidgets(); });
chrome.permissions.onRemoved.addListener(applyWidgets); // access taken away in chrome://extensions
// Coming back to the tab (or waking the laptop): catch the clock up and re-check the calendar.
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); applyWidgets().catch(console.error); } });
setInterval(() => { if (!document.hidden) { refreshMeeting(); getSettings().then(s => showWeather(s.place)).catch(console.error); } }, 5 * 60_000); // new meetings, fresh weather

tick();
applyWidgets().catch(console.error);
