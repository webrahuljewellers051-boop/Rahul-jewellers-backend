
// Run from a Render Cron Job every 5 minutes. This works while customers are offline.
// Required Cron Job environment: BACKEND_URL, SCHEME_CRON_SECRET.
const url = String(process.env.BACKEND_URL || '').replace(/\/+$/, '');
const secret = process.env.SCHEME_CRON_SECRET || '';
if (!/^https:\/\//.test(url) || secret.length < 32) {
  console.error('Set HTTPS BACKEND_URL and a 32+ character SCHEME_CRON_SECRET.');
  process.exit(1);
}
const response = await fetch(`${url}/api/internal/sweep-overdue`, {
  method: 'POST', headers: {'x-scheme-cron-secret': secret},
  signal: AbortSignal.timeout(120000)
});
if (!response.ok) {
  console.error('Scheme sweep failed:', response.status, await response.text());
  process.exit(1);
}
console.log('Scheme sweep successful:', await response.text());
