# Watchdog: snapshot.yml Liveness Monitor

A Cloudflare Worker that polls the GitHub Actions runs API every 15 minutes and re-dispatches `snapshot.yml` when the last completed run is older than 45 minutes or not in `success` state.

## Operational Urgency

**Observed GH cron drift on this repo: 61-87 minutes between scheduled runs.** The watchdog is load-bearing, not insurance. `workflow_dispatch` starts immediately (proven twice in Task 10). Deploy this worker before relying on scheduled snapshots for production SLA.

## Deployment

### Step 1: Create Fine-Grained PAT (Founder Only)

1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a new token with:
   - **Resource owner:** `0xm0w`
   - **Repository access:** Select `purrbook-data` only
   - **Permissions:** 
     - Actions: Read + Write (required for `workflow_dispatch`)
3. Copy the token to clipboard

### Step 2: Deploy Worker

```bash
cd tools/watchdog

# Authenticate with Cloudflare (one-time)
wrangler login

# Store the GitHub PAT as a secret
wrangler secret put GH_PAT
# Paste the token when prompted

# Deploy
wrangler deploy
```

### Step 3: Verify Deployment

Option A (with workflow disable):
```bash
gh workflow disable snapshot.yml
# Wait 20 minutes...
# Check Cloudflare logs for a workflow_dispatch attempt
cf logs  # (or check CF dashboard)
gh workflow enable snapshot.yml
```

Option B (quick verification, no disable needed):
```bash
# Manually verify the API path works with the PAT
curl -H "Authorization: Bearer ${GH_PAT}" \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: purrbook-watchdog" \
  "https://api.github.com/repos/0xm0w/purrbook-data/actions/workflows/snapshot.yml/runs?per_page=1&status=completed"

# Should return the last completed run's details
```

## How It Works

The worker's `scheduled` handler:
1. Fetches the last completed run from `snapshot.yml` via the Actions API
2. Calculates age in minutes: `(Date.now() - run.updated_at) / 60000`
3. If age > 45 minutes OR the run's conclusion is not `success`, dispatches `workflow_dispatch` with `ref: main`
4. Silently continues on GitHub API transient errors (next tick retries)

The worker is stateless and idempotent—multiple watchdog triggers in a row are harmless.
