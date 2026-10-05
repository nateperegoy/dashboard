import { put, list, del } from '@vercel/blob';

// Cloud sync for board state via Vercel Blob (OIDC auth via BLOB_STORE_ID)
export default async function handler(req, res) {
  const key = req.query.key;
  if (!key || !['board', 'ideas'].includes(key)) {
    return res.status(400).json({ error: 'key must be "board" or "ideas"' });
  }

  const blobPath = `dashboard-${key}.json`;

  // GET — load state
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: blobPath, limit: 1 });
      if (blobs.length === 0) {
        return res.json({ data: null });
      }
      const resp = await fetch(blobs[0].url);
      if (!resp.ok) {
        return res.json({ data: null, debug: { status: resp.status, url: blobs[0].url.substring(0, 80) } });
      }
      const data = await resp.json();
      return res.json({ data });
    } catch (e) {
      return res.status(502).json({ error: 'Blob read error', detail: e.message });
    }
  }

  // POST — save state
  if (req.method === 'POST') {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }

    try {
      // Delete old blob if exists
      const { blobs } = await list({ prefix: blobPath, limit: 1 });
      if (blobs.length > 0) {
        await del(blobs[0].url);
      }
      // Upload new — access: 'public' so the URL can be fetched without auth
      const result = await put(blobPath, JSON.stringify(body), {
        contentType: 'application/json',
        access: 'public',
        addRandomSuffix: false,
      });
      return res.json({ ok: true, url: result.url });
    } catch (e) {
      return res.status(502).json({ error: 'Blob write error', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
