const { dedupeEmails } = require('../services/notify');
const email = require('../services/email');

// Email/notify plumbing must be safe even when Resend isn't configured — actions
// should never fail because notifications aren't set up.

describe('notifications plumbing', () => {
  test('dedupeEmails normalises, lowercases and de-duplicates', () => {
    const out = dedupeEmails(['A@x.com', ' a@x.com ', 'b@y.com', '', null, 'B@Y.com']);
    expect(out).toEqual(['a@x.com', 'b@y.com']);
  });

  test('sendEmail no-ops cleanly with no API key (never throws)', async () => {
    const prevKey = process.env.RESEND_API_KEY;
    const prevAlt = process.env.RESEND;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND;
    const res = await email.sendEmail({ to: 'someone@example.com', subject: 'hi', html: '<p>hi</p>' });
    expect(res.skipped).toBe(true);
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
    if (prevAlt !== undefined) process.env.RESEND = prevAlt;
  });

  test('sendEmail skips when there are no recipients', async () => {
    const res = await email.sendEmail({ to: [], subject: 'x', html: 'y' });
    expect(res.skipped).toBe(true);
  });
});
