// Step-handoff email notifications. When the lifecycle hands off to the next
// party, email the responsible role(s) plus any extra addresses the PM entered
// on the work item (work_item.notify_emails) telling them a step is required.
//
// Fire-and-forget: callers invoke these AFTER the transaction commits and do not
// await them, so email latency or failure never affects the API response. Every
// path is wrapped so a notify error can't crash a request.

const pool = require('../config/db');
const { sendEmail } = require('./email');
const { signInviteToken } = require('../middleware/auth');

const ROLE_LABELS = {
  admin_pm: 'PM / Integrator',
  engineer: 'Engineer',
  field: 'Field / Diver',
  client: 'Client',
};

function clientUrl() {
  return (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function dedupeEmails(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    const e = String(raw).trim().toLowerCase();
    if (e && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

async function emailsForRoles(orgId, roles) {
  if (!roles || roles.length === 0) return [];
  const res = await pool.query(
    `SELECT email FROM app_user WHERE org_id = $1 AND role = ANY($2::text[]) AND is_active = true`,
    [orgId, roles]
  );
  return res.rows.map((r) => r.email);
}

function renderEmail({ title, message, workItem, url, ctaLabel, redirectedFrom }) {
  const ref = workItem.ref_code || 'work item';
  const loc = workItem.location_ref ? ` · ${workItem.location_ref}` : '';
  const redirectBanner = redirectedFrom && redirectedFrom.length
    ? `<div style="background:#eef4f7;border:1px solid #d6e6ec;border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#0b4f6c">Test mode — this notification was originally addressed to: <strong>${redirectedFrom.join(', ')}</strong></div>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#eef2f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242f">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <div style="font-weight:700;color:#0b4f6c;font-size:18px;margin-bottom:16px">▰ Franmarine <span style="color:#5d6f7c;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Project Portal</span></div>
      ${redirectBanner}
      <div style="background:#fff;border:1px solid #d8e0e7;border-radius:10px;padding:22px">
        <div style="display:inline-block;background:#fdf2e1;color:#b06a00;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:3px 9px;border-radius:20px;margin-bottom:12px">Action required</div>
        <h1 style="font-size:18px;margin:0 0 8px">${title}</h1>
        <p style="margin:0 0 6px;color:#5d6f7c;font-size:13px">${ref}${loc}</p>
        <p style="margin:14px 0;font-size:15px;line-height:1.55">${message}</p>
        <a href="${url}" style="display:inline-block;background:#0b4f6c;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;font-size:14px">${ctaLabel || 'Open the work item'}</a>
      </div>
      <p style="color:#90a0ab;font-size:12px;margin-top:16px">You received this because you are a participant on this Franmarine project. The full audit trail is on the work item.</p>
    </div>
  </body></html>`;
}

// Core: email each recipient (role users + the work item's extra addresses) an
// individual link carrying a personal invite token, so clicking it lets them
// view the work item and claim an account with `inviteRole` to complete the step.
async function handoff({ workItem, roles = [], inviteRole, title, message, ctaLabel }) {
  // Tests don't exercise real email; skip to keep them deterministic and avoid
  // async DB queries running after the suite tears down.
  if (process.env.NODE_ENV === 'test') return { skipped: true };
  try {
    const roleEmails = await emailsForRoles(workItem.org_id, roles);
    const extra = Array.isArray(workItem.notify_emails) ? workItem.notify_emails : [];
    const intended = dedupeEmails([...roleEmails, ...extra]);
    if (intended.length === 0) return { skipped: true, reason: 'no_recipients' };

    // Catch-all for testing without a verified domain: when NOTIFY_REDIRECT_TO
    // is set, deliver to that address instead (the real recipient is shown in
    // the email). Lets you exercise the flow from Resend's shared sender.
    const redirect = (process.env.NOTIFY_REDIRECT_TO || '').trim().toLowerCase();
    const role = inviteRole || roles[0] || 'field';

    const results = [];
    for (const email of intended) {
      const token = signInviteToken({ email, role, workItemId: workItem.id });
      const url = `${clientUrl()}/work-items/${workItem.id}?invite=${encodeURIComponent(token)}`;
      const to = redirect ? [redirect] : [email];
      const html = renderEmail({ title, message, workItem, url, ctaLabel, redirectedFrom: redirect ? [email] : null });
      results.push(await sendEmail({ to, subject: `[Franmarine] ${title}`, html }));
    }
    return { sent: results.length };
  } catch (err) {
    console.error('[notify] handoff failed:', err.message);
    return { error: err.message };
  }
}

// Lifecycle-specific helpers. Each says who must do what next.
const steps = {
  // RDS captured (find) -> engineer must spec & approve.
  specRequired: (wi) => handoff({
    workItem: wi, roles: ['engineer'], inviteRole: 'engineer',
    title: `Engineering spec required: ${wi.ref_code}`,
    message: 'A new work item has been raised from an RDS. An engineering specification and approval are required before any execution can begin.',
    ctaLabel: 'Review & submit the spec',
  }),
  // spec approved (-> fix) -> field crew can execute / sign hold points.
  executionAuthorised: (wi) => handoff({
    workItem: wi, roles: ['field'], inviteRole: 'field',
    title: `Execution authorised: ${wi.ref_code}`,
    message: 'The engineering spec has been approved and the gate is open. ITP hold points are now ready to be signed off as the work is carried out.',
    ctaLabel: 'Open the ITP checklist',
  }),
  // QA captured (-> verify) -> client must sign off.
  clientSignOffRequired: (wi) => handoff({
    workItem: wi, roles: ['client'], inviteRole: 'client',
    title: `Client sign-off required: ${wi.ref_code}`,
    message: 'QA has been captured for this repair. Your client sign-off is required to confirm acceptance.',
    ctaLabel: 'Review QA & sign off',
  }),
  // client signed -> PM can close.
  readyToClose: (wi) => handoff({
    workItem: wi, roles: ['admin_pm'], inviteRole: 'admin_pm',
    title: `Ready to close: ${wi.ref_code}`,
    message: 'The client has signed off the QA record. This work item is verified and ready to be closed.',
    ctaLabel: 'Open the work item',
  }),
  // closed -> courtesy notice to the client + extra recipients.
  closed: (wi) => handoff({
    workItem: wi, roles: ['client'], inviteRole: 'client',
    title: `Completed & closed: ${wi.ref_code}`,
    message: 'This repair has been verified, signed off and closed. The full doc pack is available to download from the work item.',
    ctaLabel: 'View the closed record',
  }),
};

module.exports = { handoff, steps, dedupeEmails, ROLE_LABELS };
