// Append-only event log — the foundation of the product (contractual
// transparency). Every state change, approval, sign-off and upload writes ONE
// event row with actor + timestamp. Rows are NEVER updated or deleted.
//
// `log` accepts a transaction `client` so the event is written in the SAME
// transaction as the mutation it records — if the mutation rolls back, so does
// its event, and vice versa. They are committed together, atomically.
//
//   await log(client, {
//     projectId, workItemId, orgId, actorId,
//     type: 'spec.approved',
//     payload: { specId },
//   });

const pool = require('../config/db');

async function log(client, evt) {
  const runner = client || pool;
  const { projectId, workItemId, orgId, actorId, type, payload } = evt;
  const result = await runner.query(
    `INSERT INTO event (project_id, work_item_id, org_id, actor_id, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, project_id, work_item_id, org_id, actor_id, type, payload, created_at`,
    [
      projectId,
      workItemId || null,
      orgId,
      actorId || null,
      type,
      JSON.stringify(payload || {}),
    ]
  );
  return result.rows[0];
}

// Read helpers join the actor so timelines show who did what.
const EVENT_SELECT = `
  SELECT e.id, e.type, e.payload, e.created_at,
         e.work_item_id, e.project_id,
         e.actor_id, u.name AS actor_name, u.email AS actor_email, u.role AS actor_role
  FROM event e
  LEFT JOIN app_user u ON e.actor_id = u.id
`;

async function listForWorkItem(workItemId) {
  const result = await pool.query(
    `${EVENT_SELECT} WHERE e.work_item_id = $1 ORDER BY e.id ASC`,
    [workItemId]
  );
  return result.rows;
}

async function listForProject(projectId) {
  const result = await pool.query(
    `${EVENT_SELECT} WHERE e.project_id = $1 ORDER BY e.id DESC`,
    [projectId]
  );
  return result.rows;
}

module.exports = { log, listForWorkItem, listForProject };
