// One-time archive seeding from the rescued alpha DB. Runs LOCALLY only, never in CI.
// usage: SEED_DIR=<dir containing the .db> node tools/seed-from-sqlite.mjs <db-filename> [--write]
//   Prints proposed archive entries + bucket counts; --write merges them into
//   archive.json (outcomeIds already present are refused — see mergeArchive).
//
// Schema actually discovered (`.schema markets` / `.schema price_history` against
// data/seed-archive/hypebet-alpha-2026-07-10.db, 2026-07-16) — snake_case, and
// NOT the placeholder column names an earlier draft of this tool guessed:
//   markets(outcome_id PK, display_name, category, status, quote_token,
//           updated_at, resolution_text, underlying, strike, expiry_utc)
//   price_history(outcome_id, ts INTEGER epoch-ms, yes_mid REAL, PRIMARY KEY(outcome_id, ts))
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SETTLED_OBSERVED_AT = '2026-07-10T16:00:00Z'; // when the alpha box was rescued
export const SEED_SOURCE = 'alpha-db-2026-07-10';

// Shells out to the same dockerized sqlite3 pattern used to discover the schema
// (keeps purrbook-data itself dependency-free; this tool never runs in CI).
export function runSql(seedDir, dbFileName, query) {
  const flat = query.replace(/\s+/g, ' ').trim();
  const out = execFileSync('docker', [
    'run', '--rm', '-v', `${seedDir}:/seed`, 'alpine:3.20', 'sh', '-c',
    `apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 -json /seed/${dbFileName} "${flat}"`,
  ], { encoding: 'utf8' });
  return JSON.parse(out || '[]');
}

// Recurring-group members carry machine config instead of a judge on this DB too
// (the same shape purrbook-data/snapshot.mjs already blanks for the live pipeline:
// the Fallback member's own text is literally "other", named siblings are
// "index:N"). Blank it — keep the row, it's still a real once-tradable outcome —
// just don't ship the config fragment as if it were a resolution rule.
function isConfigBlob(text) {
  return text === 'other' || /^index:\d+$/.test(text);
}

// Every genuine HL judge string narrates a resolution ("resolves to Yes if…",
// "The market resolves to X if…", "Resolves YES if…"). The rescued DB also
// contains a handful of non-market alpha-env fixture rows (display names
// "Akami"/"Otoro"/"Canned Tuna"/"Other", resolution_text "Lean tuna"/"N/A"/
// "Fatty tuna") that match neither a judge nor the config-blob shape above —
// never let those into the permanent public archive.
function isPlausibleJudgeText(text) {
  return text === '' || /resolves/i.test(text);
}

// A row's outcome_id appearing in TODAY's live catalog outranks whatever this
// six-day-old DB snapshot's own `status` column claims. This matters in practice:
// several rows are marked status='settled' in the DB (173 Argentina, 188 England,
// 212 Spain, 510/511/512 the FOMC buckets) yet are still live/tradable in today's
// catalog.json — 510-512 provably so, since the July FOMC meeting they cover is
// scheduled for July 28-29, *after* this DB's July 10 snapshot, so they cannot
// have genuinely settled yet. Seeding them would (a) publish a false settlement
// for a market still trading today and (b) permanently block that outcome's real
// future freeze — diffAndFreeze's duplicate-outcomeId guard would silently
// refuse the true settlement once it actually happens, because the id would
// already be "claimed" in archive.json by this bad seed. Applying this same
// today-catalog check to BOTH the settled-in-db and the was-live buckets (not
// just was-live, as the brief's original draft did) closes that hole.
export function classifyRow(row, liveNowIds) {
  if (row.display_name.includes('Fallback')) return { skip: 'fallback' };
  if (liveNowIds.has(row.outcome_id)) return { skip: 'still-live-today' };
  const raw = row.resolution_text ?? '';
  if (isConfigBlob(raw)) return { skip: false, resolutionText: '' };
  if (!isPlausibleJudgeText(raw)) return { skip: 'not-a-market' };
  return { skip: false, resolutionText: raw };
}

export function buildEntries(rows, liveNowIds, lastPriceByOutcome) {
  const entries = [];
  for (const row of rows) {
    const verdict = classifyRow(row, liveNowIds);
    if (verdict.skip) continue;
    const price = lastPriceByOutcome.get(row.outcome_id) ?? null;
    entries.push({
      outcomeId: row.outcome_id,
      displayName: row.display_name,
      resolutionText: verdict.resolutionText,
      lastPrice: price ? { yes: price.yes, at: price.at } : null,
      settledObservedAt: SETTLED_OBSERVED_AT,
      seedSource: SEED_SOURCE,
    });
  }
  return entries;
}

// Never a winner field (parent spec §6.7: never infer a winner from price) —
// entries only ever carry identity, judge text, and an observed last price.
export function mergeArchive(existingArchive, newEntries) {
  const existingIds = new Set(existingArchive.map((a) => a.outcomeId));
  const fresh = newEntries.filter((e) => !existingIds.has(e.outcomeId));
  return {
    archive: [...existingArchive, ...fresh],
    freshCount: fresh.length,
    duplicateCount: newEntries.length - fresh.length,
  };
}

// Diagnostic breakdown (why each row was kept/skipped) — printed in dry-run for
// human review, not part of the emitted archive entries.
function tally(rows, liveNowIds) {
  const counts = {};
  for (const row of rows) {
    const key = classifyRow(row, liveNowIds).skip || 'kept';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---- CLI (only when run directly: `node tools/seed-from-sqlite.mjs <db> [--write]`) ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbFileName, writeFlag] = process.argv.slice(2);
  const seedDir = process.env.SEED_DIR;
  if (!dbFileName || !seedDir) {
    console.error('usage: SEED_DIR=<dir containing db> node tools/seed-from-sqlite.mjs <db-filename> [--write]');
    process.exit(1);
  }

  const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'));
  const liveNowIds = new Set(catalog.outcomes.map((o) => o.outcomeId));

  const settledRows = runSql(seedDir, dbFileName,
    "SELECT outcome_id, display_name, resolution_text FROM markets WHERE status='settled' ORDER BY outcome_id");
  const liveRows = runSql(seedDir, dbFileName,
    "SELECT outcome_id, display_name, resolution_text FROM markets WHERE status='live' ORDER BY outcome_id");
  // One batched query for every outcome's last price tick — avoids one docker
  // invocation per candidate row (100+ on the real DB; each spins a fresh
  // container and re-runs `apk add`, so per-row would take minutes).
  const lastRows = runSql(seedDir, dbFileName, `
    SELECT p.outcome_id, p.ts, p.yes_mid FROM price_history p
    JOIN (SELECT outcome_id, MAX(ts) AS max_ts FROM price_history GROUP BY outcome_id) m
      ON p.outcome_id = m.outcome_id AND p.ts = m.max_ts`);
  const lastPriceByOutcome = new Map(
    lastRows.map((r) => [r.outcome_id, { yes: r.yes_mid, at: new Date(r.ts).toISOString() }]),
  );

  const settledEntries = buildEntries(settledRows, liveNowIds, lastPriceByOutcome);
  const reconstructedEntries = buildEntries(liveRows, liveNowIds, lastPriceByOutcome);
  const entries = [...settledEntries, ...reconstructedEntries];

  console.log(JSON.stringify(entries, null, 2));
  console.log(`proposed: ${entries.length} entries (${settledEntries.length} settled-in-db + ${reconstructedEntries.length} reconstructed)`);
  console.log('settled-bucket breakdown:', tally(settledRows, liveNowIds));
  console.log('live-bucket breakdown:', tally(liveRows, liveNowIds));

  if (writeFlag === '--write') {
    const existingArchive = JSON.parse(readFileSync('archive.json', 'utf8'));
    const { archive, freshCount, duplicateCount } = mergeArchive(existingArchive, entries);
    writeFileSync('archive.json', JSON.stringify(archive, null, 2) + '\n');
    console.log(`wrote ${freshCount} (${duplicateCount} duplicates refused)`);
  }
}
