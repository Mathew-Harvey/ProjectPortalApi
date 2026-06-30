// Email sending via Resend (mirrors AppHub's services/email.js approach).
//
// Gracefully no-ops when no API key is configured, so lifecycle actions never
// fail just because email isn't set up. Reads the key from RESEND_API_KEY, or
// RESEND as a fallback (some setups name it that).

const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.RESEND || '';
// Until you verify your own domain in Resend, only `onboarding@resend.dev` is an
// allowed sender (and it can only deliver to your own account email). Set
// EMAIL_FROM to an address on a verified domain to email real recipients.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Franmarine Project Portal <onboarding@resend.dev>';

let client = null;
function getClient() {
  if (!RESEND_API_KEY) return null;
  if (!client) {
    const { Resend } = require('resend');
    client = new Resend(RESEND_API_KEY);
  }
  return client;
}

function isConfigured() {
  return !!RESEND_API_KEY;
}

// to: string | string[]. Never throws — returns a result object instead.
async function sendEmail({ to, subject, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return { skipped: true, reason: 'no_recipients' };

  const resend = getClient();
  if (!resend) {
    console.log(`[email] skipped (no RESEND_API_KEY): "${subject}" -> ${recipients.join(', ')}`);
    return { skipped: true, reason: 'not_configured' };
  }

  try {
    const result = await resend.emails.send({ from: EMAIL_FROM, to: recipients, subject, html });
    if (result?.error) {
      console.error('[email] Resend error:', result.error.message || result.error);
      return { error: result.error };
    }
    return { id: result?.data?.id, sent: true };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { sendEmail, isConfigured, EMAIL_FROM };
