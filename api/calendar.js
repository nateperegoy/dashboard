import ical from 'node-ical';

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

    // Parse with node-ical (handles RRULE recurrence expansion)
    const parsed = ical.sync.parseICS(icsText);

    // Build today's date range in Denver timezone
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const todayStart = toDateInTZ(todayStr, '00:00:00', 'America/Denver');
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const todayEvents = [];

    for (const key of Object.keys(parsed)) {
      const evt = parsed[key];
      if (evt.type !== 'VEVENT') continue;
      if (!evt.summary) continue;

      // If the event has an RRULE, expand occurrences for today
      if (evt.rrule) {
        try {
          // Get occurrences between today start and today end
          const occurrences = evt.rrule.between(todayStart, todayEnd, true);
          for (const occ of occurrences) {
            // Check EXDATE exclusions
            if (evt.exdate) {
              const occTime = occ.getTime();
              const excluded = Object.values(evt.exdate).some(exd => {
                const exDate = exd instanceof Date ? exd : new Date(exd);
                return Math.abs(exDate.getTime() - occTime) < 24 * 60 * 60 * 1000
                  && exDate.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) === todayStr;
              });
              if (excluded) continue;
            }

            const duration = evt.end && evt.start
              ? evt.end.getTime() - evt.start.getTime()
              : 30 * 60 * 1000;
            const occEnd = new Date(occ.getTime() + duration);

            todayEvents.push({
              summary: evt.summary,
              start: formatInTZ(occ, 'America/Denver'),
              end: formatInTZ(occEnd, 'America/Denver'),
              location: evt.location || null,
              allDay: isAllDay(evt),
            });
          }
        } catch (e) {
          // If rrule expansion fails, fall through to single-event check
        }
      }

      // Also check the event itself (non-recurring, or the original occurrence)
      if (evt.start) {
        const startDate = evt.start instanceof Date ? evt.start : new Date(evt.start);
        const startStr = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        if (startStr === todayStr) {
          // Avoid duplicates from rrule expansion
          const alreadyAdded = todayEvents.some(e =>
            e.summary === evt.summary &&
            e.start === formatInTZ(startDate, 'America/Denver')
          );
          if (!alreadyAdded) {
            const endDate = evt.end ? (evt.end instanceof Date ? evt.end : new Date(evt.end)) : null;
            todayEvents.push({
              summary: evt.summary,
              start: formatInTZ(startDate, 'America/Denver'),
              end: endDate ? formatInTZ(endDate, 'America/Denver') : null,
              location: evt.location || null,
              allDay: isAllDay(evt),
            });
          }
        }
      }
    }

    // Also check for RECURRENCE-ID overrides (modified occurrences of recurring events)
    // node-ical handles these as separate VEVENT entries with recurrenceid set

    // Sort by start time
    todayEvents.sort((a, b) => a.start.localeCompare(b.start));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.json({ events: todayEvents });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch calendar', detail: e.message });
  }
}

function isAllDay(evt) {
  if (evt.datetype === 'date') return true;
  // All-day: start and end differ by exact multiples of 24h with midnight times
  if (evt.start && evt.end) {
    const s = evt.start instanceof Date ? evt.start : new Date(evt.start);
    const e = evt.end instanceof Date ? evt.end : new Date(evt.end);
    if (s.getUTCHours() === 0 && s.getUTCMinutes() === 0 &&
        e.getUTCHours() === 0 && e.getUTCMinutes() === 0) {
      return true;
    }
  }
  return false;
}

function toDateInTZ(dateStr, timeStr, tz) {
  // Create a Date object representing dateStr + timeStr in the given timezone
  const d = new Date(`${dateStr}T${timeStr}`);
  const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = d.toLocaleString('en-US', { timeZone: tz });
  const offset = new Date(utcStr) - new Date(tzStr);
  return new Date(d.getTime() + offset);
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
