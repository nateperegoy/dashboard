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
    const events = parseICS(icsText);

    // Filter to today's events in user's timezone
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const todayEvents = events.filter(e => {
      const startDate = e.start.slice(0, 10);
      return startDate === todayStr;
    });

    // Sort by start time
    todayEvents.sort((a, b) => a.start.localeCompare(b.start));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.json({ events: todayEvents });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch calendar', detail: e.message });
  }
}

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
        events.push({
          summary: event.summary,
          start: parseICSDate(event.dtstart, event.tzid),
          end: event.dtend ? parseICSDate(event.dtend, event.tzid) : null,
          location: event.location || null,
          allDay: event.allDay || false,
        });
      }
    } else if (inEvent) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const keyName = keyPart.split(';')[0].toUpperCase();

      // Extract TZID from params if present
      const tzMatch = keyPart.match(/TZID=([^;:]+)/i);

      if (keyName === 'SUMMARY') {
        event.summary = unescapeICS(value);
      } else if (keyName === 'DTSTART') {
        event.dtstart = value;
        if (tzMatch) event.tzid = tzMatch[1];
        // All-day events use DATE format (8 chars, no T)
        if (keyPart.includes('VALUE=DATE') || (value.length === 8 && !value.includes('T'))) {
          event.allDay = true;
        }
      } else if (keyName === 'DTEND') {
        event.dtend = value;
      } else if (keyName === 'LOCATION') {
        event.location = unescapeICS(value);
      }
    }
  }
  return events;
}

function unfoldLines(text) {
  // iCal spec: lines starting with space or tab are continuations
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
  // Formats: 20261006T140000Z, 20261006T140000, 20261006
  const clean = value.replace(/[^0-9TZ]/g, '');
  if (clean.length === 8) {
    // All-day: YYYYMMDD
    return `${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`;
  }
  const y = clean.slice(0,4), m = clean.slice(4,6), d = clean.slice(6,8);
  const h = clean.slice(9,11), mi = clean.slice(11,13), s = clean.slice(13,15);
  const isUTC = clean.endsWith('Z');

  if (isUTC) {
    // Convert UTC to Denver time
    const utcDate = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}Z`);
    return formatInTZ(utcDate, 'America/Denver');
  }

  // If TZID provided, construct date in that timezone
  if (tzid) {
    try {
      const dateInTZ = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}`);
      // Create a date string assuming the value is in the given TZID
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone: tzid,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(dateInTZ);
      // We need the Denver equivalent
      const utcMs = dateInTZ.getTime();
      // Get offset for the TZID
      const tzOffset = getTimezoneOffset(tzid, dateInTZ);
      const denverOffset = getTimezoneOffset('America/Denver', dateInTZ);
      const adjustedMs = utcMs + (tzOffset - denverOffset) * 60000;
      return formatInTZ(new Date(adjustedMs), 'America/Denver');
    } catch (e) {
      // Fallback: treat as local
    }
  }

  // Treat as Denver local time
  return `${y}-${m}-${d}T${h}:${mi}:${s}`;
}

function formatInTZ(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const p = {};
  parts.forEach(({ type, value }) => p[type] = value);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function getTimezoneOffset(tz, date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: tz });
  return (new Date(utcStr) - new Date(tzStr)) / 60000;
}
