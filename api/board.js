import { put, get, del } from '@vercel/blob';

// Cloud sync for board state via Vercel Blob (OIDC auth via BLOB_STORE_ID)
export default async function handler(req, res) {
  const key = req.query.key;
  if (!key || !['board', 'ideas'].includes(key)) {
    return res.status(400).json({ error: 'key must be "board" or "ideas"' });
  }

  const blobPath = `dashboard-${key}.json`;

  // GET — load state using SDK get() which handles private auth
  if (req.method === 'GET') {
    try {
      const blob = await get(blobPath);
      if (!blob) {
        return res.json({ data: null });
      }
      const text = await blob.text();
      const data = JSON.parse(text);
      return res.json({ data });
    } catch (e) {
      // BlobNotFoundError means no data saved yet
      if (e.code === 'blob_not_found' || e.name === 'BlobNotFoundError') {
        return res.json({ data: null });
      }
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
      await put(blobPath, JSON.stringify(body), {
        contentType: 'application/json',
        access: 'private',
        addRandomSuffix: false,
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Blob write error', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
