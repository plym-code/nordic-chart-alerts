# Nordic chart date alerts

Prototype: watches the displayed date on Spotify's public Top 50 playlists for Sweden, Norway, Denmark and Finland. No Spotify account, developer API, track comparisons or rankings are used.

The browser probe has succeeded on a GitHub-hosted runner for all four markets. Automatic scheduled delivery is still disabled. A private subscription backend now exists under [`service/`](service/README.md), with tests for exact `@umusic.com` validation, confirmation, country preferences, unsubscribe and signed monitor ingestion. The signup frontend and Cloudflare backend deployment are not live yet. The Resend API key is stored as an encrypted GitHub Actions secret; no key is committed here.

## Local probe

Requires Node.js 24 or later:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run check -- --probe
npm test
```

The probe sends no email and stores no state. Output contains only check time, browser duration, country codes and dates or diagnostic codes.

## Free hosted setup

Use a public GitHub repository with a standard runner. Source code and observed dates are public. Put `RESEND_API_KEY`, `ALERT_FROM` and `ALERT_TO` in GitHub Actions secrets. Never commit an API key or email configuration. Use a sending-only Resend key and a verified sender; Resend's test sender can only deliver to the account's permitted test recipient.

Run the workflow manually in probe mode first. If the hosted probe reads all four dates, run with probe disabled to establish the baseline, then set the repository variable `MONITOR_ENABLED` to `true`. Scheduled browser runs remain disabled until that variable is set. That first successful observation stays quiet. The included schedule checks every 10 minutes, offset from the hour. A date advance queues an email; repeated dates stay quiet. Failures create a separate attention email, with another notice on recovery. Failed email requests remain queued and use Resend idempotency keys; events older than 23 hours need review before resending. GitHub failure notifications provide an independent signal for a failed workflow or email service.

`state.json` retains the last date per market and any queued event text. GitHub commits changes after a run, including failed runs. It contains no API key or recipient address. Keep a single serialized workflow and do not edit state concurrently with a running job. Configure GitHub Actions failure notifications for this repository.

This is best effort: GitHub scheduled jobs can be late or dropped, and public-repository schedules may be disabled after 60 days without repository activity. Spotify can change or block the page, and CDN/browser visibility may lag publication. This measures a change in the displayed daily chart date, not every correction within the same chart date. No 15-minute delivery guarantee is made.

Cloudflare's free Browser Run allowance is 10 browser minutes per day. At a 10-minute poll interval, that permits an average of 4.17 browser seconds per run for all four markets; at 15 minutes, 6.25 seconds. Local timing is not proof that Cloudflare will meet those limits. Use a hosted probe before choosing that option.

References: [GitHub billing](https://docs.github.com/en/actions/concepts/billing-and-usage), [GitHub scheduling](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows), [Cloudflare browser limits](https://developers.cloudflare.com/browser-run/limits/), [Resend idempotency](https://resend.com/changelog/idempotency-keys).
