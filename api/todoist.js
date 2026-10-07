export default async function handler(req, res) {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TODOIST_API_TOKEN not configured' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // GET — fetch tasks due today or overdue for a given project
  if (req.method === 'GET') {
    try {
      // Which top-level project to pull from (default: WORK)
      const projectName = (req.query.project || 'WORK').toUpperCase();

      // 1. Fetch projects to find the target and its subprojects
      const projResp = await fetch('https://api.todoist.com/api/v1/projects', { headers });
      if (!projResp.ok) {
        return res.status(projResp.status).json({ error: 'Failed to fetch projects' });
      }
      const projData = await projResp.json();
      const projects = projData.results || projData || [];

      const targetProject = projects.find(p => p.name.toUpperCase() === projectName);
      if (!targetProject) {
        return res.json({ tasks: [] });
      }
      const workIds = [targetProject.id];
      projects.forEach(p => {
        if (p.parent_id === targetProject.id) workIds.push(p.id);
      });

      // 2. Fetch tasks per project (parallel) — much faster than fetching all tasks
      // Use ?date=YYYY-MM-DD if provided, otherwise today in Denver
      const userToday = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
      const fetches = workIds.map(async (pid) => {
        let projectTasks = [];
        let cursor = null;
        do {
          const url = new URL('https://api.todoist.com/api/v1/tasks');
          url.searchParams.set('project_id', pid);
          if (cursor) url.searchParams.set('cursor', cursor);
          const resp = await fetch(url.toString(), { headers });
          if (!resp.ok) return [];
          const data = await resp.json();
          const batch = data.results || data || [];
          projectTasks = projectTasks.concat(batch);
          cursor = data.next_cursor || null;
        } while (cursor);
        return projectTasks;
      });

      const results = await Promise.all(fetches);
      const allTasks = results.flat();

      // 3. Filter: due today or overdue (check both due.date and due.deadline)
      const tasks = allTasks.filter(t => {
        if (!t.due) return false;
        const dueDate = t.due.date || '';
        // due.date can be YYYY-MM-DD or full datetime — take just the date part
        const dateOnly = dueDate.slice(0, 10);
        return dateOnly && dateOnly <= userToday;
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
