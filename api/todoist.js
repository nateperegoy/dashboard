export default async function handler(req, res) {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TODOIST_API_TOKEN not configured' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // GET — fetch Work tasks due today or overdue
  if (req.method === 'GET') {
    try {
      // 1. Fetch projects to find "WORK" and its subprojects
      const projResp = await fetch('https://api.todoist.com/api/v1/projects', { headers });
      if (!projResp.ok) {
        return res.status(projResp.status).json({ error: 'Failed to fetch projects' });
      }
      const projData = await projResp.json();
      const projects = projData.results || projData || [];

      const workProject = projects.find(p => p.name === 'WORK');
      if (!workProject) {
        return res.json({ tasks: [] });
      }
      const workIds = new Set([workProject.id]);
      projects.forEach(p => {
        if (p.parent_id === workProject.id) workIds.add(p.id);
      });

      // 2. Fetch all tasks (paginate if needed)
      let allTasks = [];
      let cursor = null;
      do {
        const url = new URL('https://api.todoist.com/api/v1/tasks');
        if (cursor) url.searchParams.set('cursor', cursor);
        const taskResp = await fetch(url.toString(), { headers });
        if (!taskResp.ok) {
          const body = await taskResp.text();
          return res.status(taskResp.status).json({ error: 'Todoist API error', detail: body });
        }
        const taskData = await taskResp.json();
        const batch = taskData.results || taskData || [];
        allTasks = allTasks.concat(batch);
        cursor = taskData.next_cursor || null;
      } while (cursor);

      // 3. Filter: Work project + subprojects, due today or overdue
      const today = new Date().toISOString().slice(0, 10);
      const tasks = allTasks.filter(t => {
        if (!workIds.has(t.project_id)) return false;
        if (!t.due) return false;
        return t.due.date <= today;
      });

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
