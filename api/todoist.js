export default async function handler(req, res) {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TODOIST_API_TOKEN not configured' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // GET — fetch tasks with filter
  if (req.method === 'GET') {
    const filter = req.query.filter || '(today | overdue) & ##Work';
    const limit = req.query.limit || '50';
    const url = new URL('https://api.todoist.com/api/v1/tasks');
    url.searchParams.set('filter', filter);

    try {
      const resp = await fetch(url.toString(), { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ error: 'Todoist API error', detail: body });
      }
      const data = await resp.json();
      // v1 API returns { results: [...] }, v2 returned plain array
      const tasks = Array.isArray(data) ? data : (data.results || []);
      return res.json({ tasks });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Todoist', detail: e.message });
    }
  }

  // POST — complete a task
  if (req.method === 'POST') {
    const { taskId } = req.body || {};
    if (!taskId) {
      return res.status(400).json({ error: 'taskId required' });
    }

    try {
      const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}/close`, {
        method: 'POST',
        headers,
      });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ error: 'Failed to complete task', detail: body });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Todoist', detail: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
