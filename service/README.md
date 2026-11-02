# Private subscription service

Implemented and tested locally; not yet deployed. The public signup page is not yet built. The GitHub monitor has a quiet baseline and its ten-minute schedule is enabled in single-recipient test mode. Its owner-recipient and sender are encrypted GitHub configuration, not committed here.

## Intended deployment

- GitHub Pages: public static signup/confirmation/preferences form.
- GitHub Actions: existing browser monitor, every 10 minutes, best effort.
- Cloudflare Worker + D1: private subscriber addresses, subscriptions, one-time verification tokens and email outbox.
- Resend: verified sender on `atle.no`. Proposed sender is `charts@atle.no`; verify the domain before enabling email.

There are no subscriber addresses or credentials in this repository. The D1 database is not a static asset and must never be copied into the GitHub repository or published as a build artifact.

## API

- `GET /api/status`: public dates and setup status; never subscriber information.
- `POST /api/subscribe`: exact `@umusic.com` address, selected `se/no/dk/fi` markets and a valid Turnstile challenge. Sends a confirmation email; does not activate subscriptions.
- `POST /api/confirm`: consumes a one-time token, activates selections and returns a signed management link.
- `POST /api/preferences`: requires a signed management token; reads or replaces the authenticated member's selections.
- `POST /api/unsubscribe`: requires a signed management token; revokes membership and removes queued messages and unused confirmation tokens.
- `POST /api/ingest`: HMAC-authenticated observations from GitHub. New market baselines stay quiet. Date advances enqueue only matching verified subscribers; duplicate observations cannot duplicate queued mail.

Verification and management tokens go in the static site's URL fragment rather than a query string. The future frontend must require an explicit confirmation button and POST for activation/unsubscribe; email link scanners must not consume tokens with GET. It must clear the fragment immediately after reading it, keep tokens only in memory, render service responses with `textContent`, and never send them to analytics.

## Provisioning checklist

1. Create the private D1 database `nordic-chart-subscribers` and replace the database ID in `wrangler.jsonc`.
2. Apply `schema.sql` using Wrangler's D1 migration/execute facility.
3. Set the exact frontend `SITE_URL`; CORS and Turnstile validation use its origin/hostname.
4. Create a Turnstile widget for the frontend hostname; configure `TURNSTILE_SITE_KEY` and secret `TURNSTILE_SECRET`.
5. Store `RESEND_API_KEY`, random 32-byte `TOKEN_SECRET`, and a separate random 32-byte `INGEST_SECRET` as encrypted Worker secrets. Do not put them in `vars` or a committed file.
6. Set the verified sender address in `ALERT_FROM`. Keep `SENDING_ENABLED=false` until the sender and signup page are ready and an end-to-end test succeeds.
7. Deploy the Worker. Set `MONITOR_INGEST_URL` in GitHub repository variables to its `/api/ingest` URL, and put the matching `INGEST_SECRET` in GitHub Actions secrets. The monitor will then publish observations to the private service instead of using its single-recipient email code.
8. Publish and test the static signup page, verification, preference changes and unsubscribe before opening signups. Verify no addresses/tokens appear in public logs.
9. Enable email delivery, establish a quiet baseline, then set GitHub `MONITOR_ENABLED=true`.

Creating the Worker/Turnstile credentials and transferring the existing Resend key to Cloudflare require the account owner's authorization. The existing Resend key is currently stored only as the repository's encrypted `RESEND_API_KEY` secret.

## Delivery limits and operations

The service caps total email attempts at 100/day, with chart-alert attempts stopping at 90 to leave some room for verification. These conservative counters include retries even when Resend deduplicates an email. Resend limits are shared with other use of that account; monitor account usage as well. Subscription count must be limited operationally until a capacity waitlist/queue notification UI exists.

The one-minute Worker schedule drains up to five queued emails per invocation. Each email has a stable Resend idempotency key; expired events older than 23 hours are held for manual review rather than risk duplication after Resend's deduplication window. Management links expire after 90 days, and confirming a fresh verification link revokes older management links. Retry a fresh signup if verification storage fails after a token has been consumed.

Expired verification/rate records and sent messages are cleaned up. Recipient addresses remain in the private members table after unsubscribe in an inactive state; add an administrative deletion mechanism before production rollout if full erasure is required. Do not enable verbose request logging, traces containing headers/body, or browser screenshots on authenticated API requests. Cloudflare request logging is disabled in the supplied configuration.

GitHub is a best-effort scheduler and cannot guarantee a 15-minute alert. This system detects date advances, not same-date chart corrections. Provider delivery or corporate spam filters can delay email. The frontend and deployment are still pending, so this is not a live signup service yet.
