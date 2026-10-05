// Cloud sync for board state via Vercel Blob
export default async function handler(req, res) {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  if (!blobToken) {
    return res.status(500).json({ error: 'Blob store not configured' });
  }

  const key = req.query.key;
  if (!key || !['board', 'ideas'].includes(key)) {
    return res.status(400).json({ error: 'key must be "board" or "ideas"' });
  }

  const blobPath = `dashboard-${key}.json`;

  // GET — load state
  if (req.method === 'GET') {
    try {
      // List blobs to find the one with our path
      const listResp = await fetch(
        `https://blob.vercel-storage.com?prefix=${blobPath}&limit=1`,
        { headers: { Authorization: `Bearer ${blobToken}` } }
      );
      if (!listResp.ok) {
        return res.status(502).json({ error: 'Blob list failed' });
      }
      const listData = await listResp.json();
      if (!listData.blobs || listData.blobs.length === 0) {
        return res.json({ data: null });
      }
      // Fetch the blob content
      const blobUrl = listData.blobs[0].url;
      const dataResp = await fetch(blobUrl);
      if (!dataResp.ok) {
        return res.json({ data: null });
      }
      const data = await dataResp.json();
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
      // Delete existing blob with this path first (list + delete)
      const listResp = await fetch(
        `https://blob.vercel-storage.com?prefix=${blobPath}&limit=1`,
        { headers: { Authorization: `Bearer ${blobToken}` } }
      );
      if (listResp.ok) {
        const listData = await listResp.json();
        if (listData.blobs && listData.blobs.length > 0) {
          await fetch(`https://blob.vercel-storage.com/delete`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${blobToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ urls: [listData.blobs[0].url] }),
          });
        }
      }

      // Upload new blob
      const putResp = await fetch(
        `https://blob.vercel-storage.com/${blobPath}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${blobToken}`,
            'Content-Type': 'application/json',
            'x-content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      if (!putResp.ok) {
        const detail = await putResp.text();
        return res.status(502).json({ error: 'Blob write failed', detail });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Blob write error', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
