export default async function handler(req, res) {
  const feedUrl = process.env.CALENDAR_FEED_URL;
  if (!feedUrl) {
    return res.status(500).json({ error: 'CALENDAR_FEED_URL not configured' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const resp = await fetch(feedUrl, {
      headers: { 'User-Agent': 'WorkDashboard/1.0' },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Failed to fetch calendar feed' });
    }
    const icsText = await resp.text();
    const rawEvents = parseICS(icsText);

    // Today's boundaries in Denver
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

    const todayEvents = [];

    for (const evt of rawEvents) {
      // If recurring, expand and check for today
      if (evt.rruleRaw) {
        const occurrences = expandRRule(evt, todayStr);
        for (const occ of occurrences) {
          todayEvents.push(occ);
        }
      }

      // Check the event's own start date
      if (evt.startDenver) {
        if (evt.startDenver.slice(0, 10) === todayStr) {
          const dup = todayEvents.some(e =>
            e.summary === evt.summary && e.start === evt.startDenver
          );
          if (!dup) {
            todayEvents.push({
              summary: evt.summary,
              start: evt.startDenver,
              end: evt.endDenver || null,
              location: evt.location || null,
              allDay: evt.allDay || false,
            });
          }
        }
      }
    }

    todayEvents.sort((a, b) => a.start.localeCompare(b.start));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.json({ events: todayEvents });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch calendar', detail: e.message });
  }
}

// ── Lightweight RRULE expansion ──

function expandRRule(evt, todayStr) {
  const results = [];
  const rule = parseRRule(evt.rruleRaw);
  if (!rule || !rule.freq) return results;
  if (!evt.startDate) return results;

  const todayDate = new Date(todayStr + 'T12:00:00Z'); // noon UTC as reference
  const todayDay = todayDate.getUTCDay(); // 0=Sun
  const todayDayOfMonth = parseInt(todayStr.slice(8, 10));
  const todayMonth = parseInt(todayStr.slice(5, 7));
  const todayYear = parseInt(todayStr.slice(0, 4));

  // Original event's day-of-week and time
  const origDate = evt.startDate;
  const origDay = getDayInTZ(origDate, evt.tzid || 'America/Denver');
  const origDayOfMonth = getDayOfMonthInTZ(origDate, evt.tzid || 'America/Denver');
  const origMonth = getMonthInTZ(origDate, evt.tzid || 'America/Denver');

  // Check UNTIL
  if (rule.until) {
    const untilStr = rule.until.slice(0, 10);
    if (todayStr > untilStr) return results;
  }

  // Check if event started before or on today
  const evtStartStr = evt.startDenver ? evt.startDenver.slice(0, 10) : '';
  if (evtStartStr > todayStr) return results;

  const interval = rule.interval || 1;
  let matches = false;

  if (rule.freq === 'DAILY') {
    // Every N days
    const daysDiff = Math.round((todayDate.getTime() - new Date(evtStartStr + 'T12:00:00Z').getTime()) / 86400000);
    if (daysDiff >= 0 && daysDiff % interval === 0) {
      matches = true;
    }
  } else if (rule.freq === 'WEEKLY') {
    // Check BYDAY if present, otherwise use original event's day
    const targetDays = rule.byday
      ? rule.byday.map(dayNameToNum)
      : [origDay];

    if (targetDays.includes(todayDay)) {
      // Check interval (every N weeks)
      if (interval === 1) {
        matches = true;
      } else {
        // Weeks since start
        const startMonday = getWeekStart(new Date(evtStartStr + 'T12:00:00Z'));
        const todayMonday = getWeekStart(todayDate);
        const weeksDiff = Math.round((todayMonday.getTime() - startMonday.getTime()) / (7 * 86400000));
        if (weeksDiff >= 0 && weeksDiff % interval === 0) {
          matches = true;
        }
      }
    }
  } else if (rule.freq === 'MONTHLY') {
    if (rule.byday && rule.byday.length === 1 && rule.bysetpos) {
      // e.g., 1st Monday, 3rd Wednesday
      const targetDay = dayNameToNum(rule.byday[0]);
      const pos = rule.bysetpos;
      if (todayDay === targetDay) {
        const nthOccurrence = Math.ceil(todayDayOfMonth / 7);
        if (nthOccurrence === pos) {
          if (interval === 1 || monthsDiff(evtStartStr, todayStr) % interval === 0) {
            matches = true;
          }
        }
      }
    } else {
      // Same day of month
      if (todayDayOfMonth === origDayOfMonth) {
        if (interval === 1 || monthsDiff(evtStartStr, todayStr) % interval === 0) {
          matches = true;
        }
      }
    }
  } else if (rule.freq === 'YEARLY') {
    if (todayMonth === origMonth && todayDayOfMonth === origDayOfMonth) {
      const yearsDiff = todayYear - parseInt(evtStartStr.slice(0, 4));
      if (yearsDiff >= 0 && yearsDiff % interval === 0) {
        matches = true;
      }
    }
  }

  if (!matches) return results;

  // Check EXDATE
  if (evt.exdates && evt.exdates.includes(todayStr)) return results;

  // Check COUNT — approximate: if COUNT is small and event started long ago, skip
  if (rule.count) {
    const maxPossible = estimateOccurrenceCount(rule, evtStartStr, todayStr);
    if (maxPossible > rule.count) return results;
  }

  // Build the occurrence using today's date + original event's time
  const timePart = evt.startDenver ? evt.startDenver.slice(10) : 'T00:00:00';
  const occStart = todayStr + timePart;

  let occEnd = null;
  if (evt.startDenver && evt.endDenver) {
    const durMs = new Date('2000-01-01' + evt.endDenver.slice(10)).getTime() -
                  new Date('2000-01-01' + evt.startDenver.slice(10)).getTime();
    const endMs = new Date('2000-01-01' + timePart).getTime() + durMs;
    const endD = new Date(endMs);
    const eh = String(endD.getUTCHours()).padStart(2, '0');
    const em = String(endD.getUTCMinutes()).padStart(2, '0');
    const es = String(endD.getUTCSeconds()).padStart(2, '0');
    occEnd = todayStr + `T${eh}:${em}:${es}`;
  }

  results.push({
    summary: evt.summary,
    start: occStart,
    end: occEnd,
    location: evt.location || null,
    allDay: evt.allDay || false,
  });

  return results;
}

function parseRRule(str) {
  const rule = {};
  str.split(';').forEach(part => {
    const [k, v] = part.split('=');
    if (!k || !v) return;
    const key = k.toUpperCase();
    if (key === 'FREQ') rule.freq = v.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = parseInt(v);
    else if (key === 'COUNT') rule.count = parseInt(v);
    else if (key === 'UNTIL') rule.until = v;
    else if (key === 'BYDAY') rule.byday = v.split(',').map(d => d.replace(/[0-9+-]/g, ''));
    else if (key === 'BYSETPOS') rule.bysetpos = parseInt(v);
    else if (key === 'BYMONTHDAY') rule.bymonthday = parseInt(v);
  });
  return rule;
}

function dayNameToNum(name) {
  const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return map[name.toUpperCase()] ?? -1;
}

function getWeekStart(d) {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday = 0
  return new Date(d.getTime() - diff * 86400000);
}

function monthsDiff(startStr, endStr) {
  const sy = parseInt(startStr.slice(0, 4)), sm = parseInt(startStr.slice(5, 7));
  const ey = parseInt(endStr.slice(0, 4)), em = parseInt(endStr.slice(5, 7));
  return (ey - sy) * 12 + (em - sm);
}

function estimateOccurrenceCount(rule, startStr, todayStr) {
  const start = new Date(startStr + 'T12:00:00Z');
  const today = new Date(todayStr + 'T12:00:00Z');
  const days = Math.round((today - start) / 86400000);
  const interval = rule.interval || 1;

  if (rule.freq === 'DAILY') return Math.floor(days / interval) + 1;
  if (rule.freq === 'WEEKLY') {
    const bydayCount = rule.byday ? rule.byday.length : 1;
    return Math.floor(days / (7 * interval)) * bydayCount + bydayCount;
  }
  if (rule.freq === 'MONTHLY') return Math.floor(monthsDiff(startStr, todayStr) / interval) + 1;
  if (rule.freq === 'YEARLY') {
    const years = parseInt(todayStr.slice(0, 4)) - parseInt(startStr.slice(0, 4));
    return Math.floor(years / interval) + 1;
  }
  return 9999;
}

function getDayInTZ(date, tz) {
  const str = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[str] ?? 0;
}

function getDayOfMonthInTZ(date, tz) {
  return parseInt(date.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
}

function getMonthInTZ(date, tz) {
  return parseInt(date.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
}

// ── iCal parsing ──

function parseICS(text) {
  const events = [];
  const lines = unfoldLines(text);
  let inEvent = false;
  let event = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      event = {};
    } else if (line === 'END:VEVENT') {
      inEvent = false;
      if (event.summary && event.dtstart) {
        const startDate = parseICSDateToJS(event.dtstart, event.tzid);
        const endDate = event.dtend ? parseICSDateToJS(event.dtend, event.tzid) : null;

        events.push({
          uid: event.uid || null,
          summary: event.summary,
          startDate,
          endDate,
          startDenver: startDate ? formatInTZ(startDate, 'America/Denver') : null,
          endDenver: endDate ? formatInTZ(endDate, 'America/Denver') : null,
          location: event.location || null,
          allDay: event.allDay || false,
          rruleRaw: event.rruleRaw || null,
          tzid: event.tzid || null,
          exdates: event.exdates || [],
        });
      }
    } else if (inEvent) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const keyName = keyPart.split(';')[0].toUpperCase();
      const tzMatch = keyPart.match(/TZID=([^;:]+)/i);

      if (keyName === 'UID') {
        event.uid = value;
      } else if (keyName === 'SUMMARY') {
        event.summary = unescapeICS(value);
      } else if (keyName === 'DTSTART') {
        event.dtstart = value;
        if (tzMatch) event.tzid = tzMatch[1];
        if (keyPart.includes('VALUE=DATE') || (value.length === 8 && !value.includes('T'))) {
          event.allDay = true;
        }
      } else if (keyName === 'DTEND') {
        event.dtend = value;
      } else if (keyName === 'LOCATION') {
        event.location = unescapeICS(value);
      } else if (keyName === 'RRULE') {
        event.rruleRaw = value;
      } else if (keyName === 'EXDATE') {
        if (!event.exdates) event.exdates = [];
        value.split(',').forEach(d => {
          const clean = d.replace(/[^0-9T]/g, '');
          if (clean.length >= 8) {
            event.exdates.push(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`);
          }
        });
      }
    }
  }
  return events;
}

function unfoldLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

function unescapeICS(str) {
  return str.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseICSDateToJS(value, tzid) {
  const clean = value.replace(/[^0-9TZ]/g, '');
  if (clean.length === 8) {
    return new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}T00:00:00Z`);
  }
  const y = clean.slice(0,4), m = clean.slice(4,6), d = clean.slice(6,8);
  const h = clean.slice(9,11), mi = clean.slice(11,13), s = clean.slice(13,15);

  if (clean.endsWith('Z')) {
    return new Date(`${y}-${m}-${d}T${h}:${mi}:${s}Z`);
  }

  // Interpret in the given timezone (or Denver)
  const tz = tzid || 'America/Denver';
  const naive = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}`);
  const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = naive.toLocaleString('en-US', { timeZone: tz });
  const offset = new Date(utcStr).getTime() - new Date(tzStr).getTime();
  return new Date(naive.getTime() + offset);
}

function formatInTZ(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach(({ type, value }) => (p[type] = value));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
