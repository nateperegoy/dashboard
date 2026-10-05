import { put, get, del, list } from '@vercel/blob';

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
      const result = await get(blobPath, { access: 'private' });
      if (!result || result.statusCode === 404 || !result.stream) {
        return res.json({ data: null });
      }
      // Read stream to string
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf-8');
      const data = JSON.parse(text);
      return res.json({ data });
    } catch (e) {
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
        allowOverwrite: true,
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Blob write error', detail: e.message });
    }
  }

  // DELETE — clear blob (for cleanup)
  if (req.method === 'DELETE') {
    try {
      const { blobs } = await list({ prefix: blobPath, limit: 10 });
      if (blobs.length > 0) {
        await del(blobs.map(b => b.url));
      }
      return res.json({ ok: true, deleted: blobs.length });
    } catch (e) {
      return res.status(502).json({ error: 'Blob delete error', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
