// Cloud sync for board state via Vercel KV (Upstash Redis REST API)
export default async function handler(req, res) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV store not configured' });
  }

  const headers = { Authorization: `Bearer ${kvToken}` };
  const key = req.query.key;

  if (!key || !['board', 'ideas'].includes(key)) {
    return res.status(400).json({ error: 'key must be "board" or "ideas"' });
  }

  const kvKey = `dashboard:${key}`;

  // GET — load state
  if (req.method === 'GET') {
    try {
      const resp = await fetch(`${kvUrl}/get/${kvKey}`, { headers });
      if (!resp.ok) {
        return res.status(502).json({ error: 'KV read failed' });
      }
      const data = await resp.json();
      // Upstash returns { result: "stringified JSON" } or { result: null }
      if (data.result === null) {
        return res.json({ data: null });
      }
      return res.json({ data: JSON.parse(data.result) });
    } catch (e) {
      return res.status(502).json({ error: 'KV read error', detail: e.message });
    }
  }

  // POST — save state
  if (req.method === 'POST') {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }

    try {
      const resp = await fetch(`${kvUrl}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', kvKey, JSON.stringify(body)]),
      });
      if (!resp.ok) {
        const detail = await resp.text();
        return res.status(502).json({ error: 'KV write failed', detail });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'KV write error', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
