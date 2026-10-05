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
    // Debug mode: try multiple endpoints to find working filter
    if (req.query.debug === '1') {
      const filter = '(today | overdue) & ##Work';
      const results = {};

      // Test 1: GET /tasks with filter query param
      try {
        const r = await fetch(`https://api.todoist.com/api/v1/tasks?filter=${encodeURIComponent(filter)}`, { headers });
        const d = await r.json();
        results.get_filter = { status: r.status, count: Array.isArray(d) ? d.length : (d.results?.length || 'no results key'), keys: Object.keys(d) };
      } catch(e) { results.get_filter = { error: e.message }; }

      // Test 2: GET /tasks with project_id
      try {
        const r = await fetch('https://api.todoist.com/api/v1/tasks?project_id=6VwHHW45wQWxGQvR', { headers });
        const d = await r.json();
        results.get_project = { status: r.status, count: Array.isArray(d) ? d.length : (d.results?.length || 'no results key'), keys: Object.keys(d) };
      } catch(e) { results.get_project = { error: e.message }; }

      // Test 3: POST /tasks/filter
      try {
        const r = await fetch('https://api.todoist.com/api/v1/tasks/filter', { method: 'POST', headers, body: JSON.stringify({ query: filter }) });
        const d = await r.text();
        results.post_filter = { status: r.status, body: d.substring(0, 300) };
      } catch(e) { results.post_filter = { error: e.message }; }

      // Test 4: POST /sync with items filter
      try {
        const r = await fetch('https://api.todoist.com/api/v1/sync', {
          method: 'POST', headers,
          body: JSON.stringify({ sync_token: '*', resource_types: ['items'], filter: filter })
        });
        const d = await r.text();
        results.sync = { status: r.status, body: d.substring(0, 300) };
      } catch(e) { results.sync = { error: e.message }; }

      return res.json(results);
    }

    const filter = req.query.filter || '(today | overdue) & ##Work';
    const url = new URL('https://api.todoist.com/api/v1/tasks');
    url.searchParams.set('filter', filter);

    try {
      const resp = await fetch(url.toString(), { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ error: 'Todoist API error', detail: body });
      }
      const data = await resp.json();
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
