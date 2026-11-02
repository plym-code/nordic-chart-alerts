// Resend's documented test recipient simulates delivery, not a real mailbox.
// See https://resend.com/changelog/sending-test-emails
if (!process.env.RESEND_API_KEY || !process.env.ALERT_FROM) throw new Error('Email configuration is missing.');
const response = await fetch('https://api.resend.com/emails', {
  method: 'POST', signal: AbortSignal.timeout(20000),
  headers: {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': `setup-check-${process.env.GITHUB_RUN_ID || crypto.randomUUID()}`,
  },
  body: JSON.stringify({
    from: process.env.ALERT_FROM,
    to: ['delivered@resend.dev'],
    subject: 'Nordic chart monitor setup check',
    text: 'A setup check sent to Resend’s simulated-delivery address. No real subscriber is contacted.',
  }),
});
console.log(`Resend simulated delivery request: HTTP ${response.status}`);
if (!response.ok) process.exitCode = 1;
