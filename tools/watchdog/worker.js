/**
 * Watchdog: GitHub Actions snapshot.yml liveness monitor.
 *
 * Runs every 15 minutes and re-dispatches workflow_dispatch when the last
 * completed run is > 45 minutes old or not in 'success' state. Liveness is
 * measured by the Actions RUNS API, never by commit age (quiet days commit
 * nothing by design).
 *
 * Observed GH cron drift on this repo: 61-87 minutes between scheduled runs.
 * The watchdog is load-bearing, not insurance. workflow_dispatch starts
 * immediately (proven twice in Task 10).
 */
export default {
  async scheduled(_event, env) {
    const gh = (path, init = {}) => fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.GH_PAT}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'purrbook-watchdog',
        ...init.headers,
      },
    });

    const res = await gh('/repos/0xm0w/purrbook-data/actions/workflows/snapshot.yml/runs?per_page=1&status=completed');
    if (!res.ok) return; // GitHub API blip — next tick retries

    const run = (await res.json()).workflow_runs?.[0];
    const ageMin = run ? (Date.now() - Date.parse(run.updated_at)) / 60000 : Infinity;

    if (ageMin > 45 || run?.conclusion !== 'success') {
      await gh('/repos/0xm0w/purrbook-data/actions/workflows/snapshot.yml/dispatches', {
        method: 'POST',
        body: JSON.stringify({ ref: 'main' }),
      });
    }
  },
};
