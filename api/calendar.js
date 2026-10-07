import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const creds = process.env.GOOGLE_SERVICE_ACCOUNT;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!creds || !calendarId) {
    return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT or GOOGLE_CALENDAR_ID not configured' });
  }

  try {
    const sa = JSON.parse(creds);
    const token = await getAccessToken(sa);

    // Today's boundaries in Denver
    const now = new Date();
    const denver = (d, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', ...opts }).format(d);
    const todayStr = denver(now, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeMin = `${todayStr}T00:00:00-06:00`;
    const timeMax = `${todayStr}T23:59:59-06:00`;

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
      + `?timeMin=${encodeURIComponent(timeMin)}`
      + `&timeMax=${encodeURIComponent(timeMax)}`
      + `&singleEvents=true`
      + `&orderBy=startTime`
      + `&timeZone=America/Denver`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return res.status(resp.status).json({ error: 'Google Calendar API error', detail: errBody });
    }

    const data = await resp.json();
    const events = (data.items || []).map(item => {
      const start = item.start?.dateTime || item.start?.date || '';
      const end = item.end?.dateTime || item.end?.date || '';
      const allDay = !item.start?.dateTime;

      return {
        summary: item.summary || '(No title)',
        start: allDay ? start : formatInDenver(start),
        end: allDay ? end : formatInDenver(end),
        location: item.location || null,
        allDay,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.json({ events });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch calendar', detail: e.message });
  }
}

// Format an ISO datetime string into Denver local time (matching old format)
function formatInDenver(isoStr) {
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = {};
  parts.forEach(({ type, value }) => (p[type] = value));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// Google Service Account JWT auth — zero dependencies
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(claim)),
  ];
  const signingInput = segments.join('.');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(sa.private_key);
  const jwt = signingInput + '.' + base64url(signature);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Token exchange failed: ${errBody}`);
  }

  const tokenData = await resp.json();
  return tokenData.access_token;
}

function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
