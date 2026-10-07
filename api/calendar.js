import crypto from 'crypto';

const SERVICE_ACCOUNT = {
  client_email: 'dashboard-work-calendar@leafy-tenure-510902-d2.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCUWEtjFJYfykNz
qP2cb9LNAfchsjiyjm7E+Lhsdk4yRJkcBEmURo3t7qPIQRy3E+W8kGSilkaVzZwh
g28IjR6nmmKuQ1Gr0a/i07RV9rva+veVwU0k4Dvj0skwF+Aqh3/WeXxL9X/UlAWq
UDYSn8byum0cdKPZxW1YJ14EKtkVQkMI/LtRWvcsH/dSkJ3/GYDGpH+Eg9QqW5nm
AAtFgiFo7cxEY/MGjVj/S6Hb6fUdgGOjQvKZlUk6DdFyxxBKFQY4d0TPzfSlHWyb
OC33rPbqeTau1nNqePlpVVPd1uEz4kl6Qb8cIB5KsmI/75gAIG1dbLS+nIF9UgYH
X089gusBAgMBAAECggEABl6cLg7uO0M2DjtNWHA8vuy8rce3Q4N2IiMD2DRkOyhS
4q8Ucbdt1K+QfMK+9uV10djpWUnWkgwYDiBUnithC5VHc3AUi6ofQUAR2DcV7dsk
0ltQcqrmJ2wfk18TEwBqbs0cly5dZMVOUPfMupP9uOJkWPpxJqKhhU17bfZhB9aV
yfDaLAOZwhe/4aElevEyS7eP0Ol0XY+X0i65y0SFe0v7cQu8ZD7G9AGoMxXO4gn5
Mb3L9OmF4nHo0GjisJkSilyMnBo4QE/PGq453CL5BO4DwunY5cwuIbphq1O4N7af
JQUoVmPLJmE0cY46WlC7D6Q9R+5zAXTKXOLlpffZoQKBgQDEZeQcmf+z71oC3Vya
He/F4td8zC5RiQAxF7nu8JlZW3QUtMVOUCtobiqUaXHE2+krndJKLKsTsKYZL/L0
pwhGFfigf156M7CIlvRv8ridR1FsW/4EwOcEEUzkSs7CQXNpyTWpPRYqH2aW66l1
rDcQysaavR1TLB3DGq/kUv6QTQKBgQDBXSuIQgVneQrqU0R4roUjEAbpkXawwKfi
L2JQjRoz9sfjIoatcpeBU2S33UWcKjk4xmVnlnI7udJoif9PuIqN+AB2xJ/YGP5R
3kxtM6OkbTR2ua5ra22TSFa6YZj+EOyFem98tnPjmJ07VvEsSRP+eOA9pulaW2lo
EjvVGDs/hQKBgHbybvGTo3ZK5G0PvGHq96kV9gSzdOoU23TgNdAtD/M6nFdeFJGV
pHSfJFK2eh0MQ3ATKaWa4BIQzsg6bh8WesBX1jj+ay3/2E8hffG/Q2ieJQZHwNUI
L+IayEMLu6WTFl9faYySXrYsRmnpWLzYDJGy/g4Bs50H/w6HPzg9u8eRAoGALu7R
WSJFM4dCqfuJ/AzIDeme8+Q1vdMVLKY5o7mL6Z71h2Di9YiB04cNRD913OC2wNwO
0uTGV07UDkGocY4mOy0915YEAiyW1gIx5LOK/abv+/03o6UQlJYTTuvPeaNb9U3x
b4DNgimRyExi/0/BhZuLOgugSikz3WnHkgJupw0CgYEAvcMytFUB9HUhbtjYTtWu
EfjP8KYQXbBtbdQyC5rKfzZGTdHHrpqpIpf8a5ii03mdfKPV985CDUh0XizJss32
ouJODaNHs8REycp3s4uHFe2kaiN9Hiq7QtGTFkiapgsR/Wu/0PUjICNU6cEpdala
tKutpT0ye48DcTw2D8fC68M=
-----END PRIVATE KEY-----`,
};

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'nperegoy@ourfatherlutheran.net';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = await getAccessToken(SERVICE_ACCOUNT);

    // Use ?date=YYYY-MM-DD if provided, otherwise today in Denver
    const now = new Date();
    const denver = (d, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', ...opts }).format(d);
    const todayStr = req.query.date || denver(now, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeMin = `${todayStr}T00:00:00-06:00`;
    const timeMax = `${todayStr}T23:59:59-06:00`;

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`
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
