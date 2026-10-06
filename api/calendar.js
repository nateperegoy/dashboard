import { RRule } from 'rrule';

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

    // Today's date range in Denver timezone
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const todayStart = buildDateInTZ(todayStr, '00:00:00', 'America/Denver');
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // Collect EXDATE sets keyed by UID
    const exdates = {};
    rawEvents.forEach(evt => {
      if (evt.exdates && evt.exdates.length && evt.uid) {
        exdates[evt.uid] = evt.exdates.map(d => d.slice(0, 10));
      }
    });

    const todayEvents = [];

    for (const evt of rawEvents) {
      const duration = getDurationMs(evt);

      if (evt.rrule) {
        // Expand recurrence
        try {
          const rule = RRule.fromString(evt.rrule);

          // rrule works in UTC-ish dates; build a window around today
          const windowStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
          const windowEnd = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);
          const occurrences = rule.between(windowStart, windowEnd, true);

          for (const occ of occurrences) {
            // Transfer the original event's time-of-day onto this occurrence date
            const occStart = applyTimeOfDay(occ, evt.startDate, evt.tzid);
            const occStartStr = formatInTZ(occStart, 'America/Denver');
            const occDateStr = occStartStr.slice(0, 10);

            if (occDateStr !== todayStr) continue;

            // Check EXDATE exclusions
            if (exdates[evt.uid] && exdates[evt.uid].includes(occDateStr)) continue;

            const occEnd = new Date(occStart.getTime() + duration);
            todayEvents.push({
              summary: evt.summary,
              start: occStartStr,
              end: formatInTZ(occEnd, 'America/Denver'),
              location: evt.location || null,
              allDay: evt.allDay || false,
            });
          }
        } catch (e) {
          // rrule parse failed — skip this event's recurrence
        }
      }

      // Also check the event's own date (non-recurring or original instance)
      if (evt.startDate) {
        const startStr = formatInTZ(evt.startDate, 'America/Denver');
        if (startStr.slice(0, 10) === todayStr) {
          // Avoid duplicates from rrule expansion
          const dup = todayEvents.some(e =>
            e.summary === evt.summary && e.start === startStr
          );
          if (!dup) {
            const endDate = evt.endDate
              ? formatInTZ(evt.endDate, 'America/Denver')
              : formatInTZ(new Date(evt.startDate.getTime() + duration), 'America/Denver');
            todayEvents.push({
              summary: evt.summary,
              start: startStr,
              end: endDate,
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
        const startDate = parseICSDate(event.dtstart, event.tzid);
        const endDate = event.dtend ? parseICSDate(event.dtend, event.tzid) : null;

        // Build RRULE string with DTSTART for rrule library
        let rruleStr = null;
        if (event.rruleRaw) {
          const dtPart = event.dtstart.includes('Z')
            ? event.dtstart
            : event.dtstart.replace(/[^0-9T]/g, '') + 'Z';
          rruleStr = `DTSTART:${dtPart}\nRRULE:${event.rruleRaw}`;
        }

        events.push({
          uid: event.uid || null,
          summary: event.summary,
          startDate,
          endDate,
          location: event.location || null,
          allDay: event.allDay || false,
          rrule: rruleStr,
          tzid: event.tzid || null,
          exdates: event.exdates || [],
          dtstart: event.dtstart,
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
        // EXDATE can have multiple comma-separated values
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

function parseICSDate(value, tzid) {
  const clean = value.replace(/[^0-9TZ]/g, '');
  if (clean.length === 8) {
    return new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}T00:00:00Z`);
  }
  const y = clean.slice(0,4), m = clean.slice(4,6), d = clean.slice(6,8);
  const h = clean.slice(9,11), mi = clean.slice(11,13), s = clean.slice(13,15);
  const isUTC = clean.endsWith('Z');

  if (isUTC) {
    return new Date(`${y}-${m}-${d}T${h}:${mi}:${s}Z`);
  }

  if (tzid) {
    // Interpret the time as being in the given timezone
    const naive = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}`);
    const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = naive.toLocaleString('en-US', { timeZone: tzid });
    const offset = new Date(utcStr).getTime() - new Date(tzStr).getTime();
    return new Date(naive.getTime() + offset);
  }

  // Treat as Denver local
  const naive = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}`);
  const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
  const denStr = naive.toLocaleString('en-US', { timeZone: 'America/Denver' });
  const offset = new Date(utcStr).getTime() - new Date(denStr).getTime();
  return new Date(naive.getTime() + offset);
}

function getDurationMs(evt) {
  if (evt.startDate && evt.endDate) {
    return evt.endDate.getTime() - evt.startDate.getTime();
  }
  return 30 * 60 * 1000; // default 30 min
}

function applyTimeOfDay(occDate, originalStart, tzid) {
  // Transfer the hour:minute from the original event start to the occurrence date
  if (!originalStart) return occDate;
  const origParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid || 'America/Denver',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(originalStart);
  const op = {};
  origParts.forEach(({ type, value }) => (op[type] = value));

  const occParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid || 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(occDate);
  const dp = {};
  occParts.forEach(({ type, value }) => (dp[type] = value));

  const dateStr = `${dp.year}-${dp.month}-${dp.day}`;
  const timeStr = `${op.hour}:${op.minute}:${op.second}`;
  return buildDateInTZ(dateStr, timeStr, tzid || 'America/Denver');
}

function buildDateInTZ(dateStr, timeStr, tz) {
  const naive = new Date(`${dateStr}T${timeStr}`);
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
