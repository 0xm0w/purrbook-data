// Manual test suite for tools/seed-from-sqlite.mjs. NOT auto-discovered:
// the filename deliberately avoids Node's default test globs (no *.test.*,
// no -test/_test basename suffix, not under a test/ dir) so the scheduled
// snapshot workflow's bare `node --test` never picks it up — the seed is a
// one-time local job, and its docker-backed e2e must not spin a container
// 144x/day in a pipeline whose work is done. Invoke explicitly whenever the
// seed tool is touched:
//   node --test tools/seed.manual.mjs
// (Naming note: seed.manual-test.mjs would NOT have escaped — Node 20 treats
// any basename ending in .test/-test/_test as a test file and Node 22+ globs
// *-test.?(c|m)js; verified empirically on node 24 local + node:20 container.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRow, buildEntries, mergeArchive, runSql, SETTLED_OBSERVED_AT, SEED_SOURCE,
} from './seed-from-sqlite.mjs';

const LIVE_NOW = new Set([1003, 1005]); // fixture "today's live catalog"

// ---- pure-logic unit tests (no docker — fast, deterministic) ----

test('classifyRow: normal settled row is kept with resolutionText intact', () => {
  const v = classifyRow({ outcome_id: 1001, display_name: 'Wintermute', resolution_text: 'This outcome resolves to Yes if Wintermute wins.' }, LIVE_NOW);
  assert.equal(v.skip, false);
  assert.equal(v.resolutionText, 'This outcome resolves to Yes if Wintermute wins.');
});

test('classifyRow: exact "Fallback" and "Recurring Fallback" are both excluded (contains-match)', () => {
  assert.equal(classifyRow({ outcome_id: 2, display_name: 'Fallback', resolution_text: '' }, LIVE_NOW).skip, 'fallback');
  assert.equal(classifyRow({ outcome_id: 3, display_name: 'Recurring Fallback', resolution_text: 'other' }, LIVE_NOW).skip, 'fallback');
});

test('classifyRow: outcome_id present in today\'s live catalog is excluded even if DB marks it settled (stale-status guard)', () => {
  // Mirrors the real collision found in the rescued DB: 173/188/212/510/511/512
  // are status='settled' there yet still live in today's catalog.json — 510-512
  // (the FOMC buckets) provably so, since that meeting postdates the DB snapshot.
  const v = classifyRow({ outcome_id: 1003, display_name: 'StillLive', resolution_text: 'This outcome resolves to Yes if StillLive wins.' }, LIVE_NOW);
  assert.equal(v.skip, 'still-live-today');
});

test('classifyRow: config-blob resolution_text ("other" / "index:N") blanks the text but keeps the row', () => {
  const named = classifyRow({ outcome_id: 9, display_name: 'Recurring Named Outcome', resolution_text: 'index:2' }, LIVE_NOW);
  assert.equal(named.skip, false);
  assert.equal(named.resolutionText, '');
});

test('classifyRow: non-market alpha-env fixture rows (no judge language) are excluded entirely', () => {
  // Real examples from the rescued DB: display_name "Otoro"/"Akami"/"Canned Tuna",
  // resolution_text "Fatty tuna"/"Lean tuna"/"N/A" — not a market, never seed it.
  const v = classifyRow({ outcome_id: 7007, display_name: 'Otoro', resolution_text: 'Fatty tuna' }, LIVE_NOW);
  assert.equal(v.skip, 'not-a-market');
});

test('classifyRow: empty resolution_text is honest (kept, blank), not treated as a fixture row', () => {
  const v = classifyRow({ outcome_id: 11, display_name: 'Quiet Market', resolution_text: null }, LIVE_NOW);
  assert.equal(v.skip, false);
  assert.equal(v.resolutionText, '');
});

test('buildEntries: shape has identity, resolutionText, lastPrice{yes,at}, settledObservedAt, seedSource — never a winner field', () => {
  const rows = [{ outcome_id: 1001, display_name: 'Wintermute', resolution_text: 'This outcome resolves to Yes if Wintermute wins.' }];
  const prices = new Map([[1001, { yes: 0.02, at: '2026-07-10T08:00:00.000Z' }]]);
  const [entry] = buildEntries(rows, LIVE_NOW, prices);
  assert.deepEqual(entry, {
    outcomeId: 1001,
    displayName: 'Wintermute',
    resolutionText: 'This outcome resolves to Yes if Wintermute wins.',
    lastPrice: { yes: 0.02, at: '2026-07-10T08:00:00.000Z' },
    settledObservedAt: SETTLED_OBSERVED_AT,
    seedSource: SEED_SOURCE,
  });
  assert.ok(!('winner' in entry), 'never claims a winner');
});

test('buildEntries: missing price history yields lastPrice null rather than a fabricated price', () => {
  const rows = [{ outcome_id: 1001, display_name: 'Wintermute', resolution_text: 'This outcome resolves to Yes if Wintermute wins.' }];
  const [entry] = buildEntries(rows, LIVE_NOW, new Map());
  assert.equal(entry.lastPrice, null);
});

test('buildEntries: excludes Fallback, still-live, and non-market rows; blanks config-blob text', () => {
  const rows = [
    { outcome_id: 1001, display_name: 'Wintermute', resolution_text: 'This outcome resolves to Yes if Wintermute wins.' },
    { outcome_id: 1002, display_name: 'Fallback', resolution_text: '' },
    { outcome_id: 1003, display_name: 'StillLive', resolution_text: 'This outcome resolves to Yes if StillLive wins.' },
    { outcome_id: 1006, display_name: 'Recurring Named Outcome', resolution_text: 'index:0' },
    { outcome_id: 1007, display_name: 'Otoro', resolution_text: 'Fatty tuna' },
  ];
  const entries = buildEntries(rows, LIVE_NOW, new Map());
  const ids = entries.map((e) => e.outcomeId).sort();
  assert.deepEqual(ids, [1001, 1006]);
  assert.equal(entries.find((e) => e.outcomeId === 1006).resolutionText, '');
});

test('mergeArchive: refuses outcomeIds already present, merges the rest', () => {
  const existing = [{ outcomeId: 1001, displayName: 'old' }];
  const fresh = [
    { outcomeId: 1001, displayName: 'Wintermute' },
    { outcomeId: 1004, displayName: 'Gone Team' },
  ];
  const { archive, freshCount, duplicateCount } = mergeArchive(existing, fresh);
  assert.equal(freshCount, 1);
  assert.equal(duplicateCount, 1);
  assert.equal(archive.length, 2);
  assert.deepEqual(archive.map((a) => a.outcomeId).sort(), [1001, 1004]);
});

// ---- docker-backed integration test: real dockerized sqlite3, real fixture DB ----
// Local-only, like the tool it tests (this file is outside `node --test`
// auto-discovery — see header). The broad try/catch below still turns ANY
// docker/sqlite runtime failure into a clean skip rather than a hard failure,
// so a transient image-pull or apk hiccup reads as "environment can't run the
// e2e", not as a seed-tool regression.

function dockerReady() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = !dockerReady() && 'docker is unavailable in this environment (tool is local-only by design)';

test('end-to-end against a real dockerized-sqlite fixture: golden shape, Fallback exclusion, stale-status collision, blob-blanking, non-market exclusion', { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-fixture-')).replace(/\\/g, '/');
  const dbFile = 'fixture.db';

  // Infra (docker/network/sqlite) failures degrade to a clean skip, never a
  // hard failure — a transient Alpine-mirror or daemon hiccup is an
  // environment problem, not a seed-tool bug, and must not read as one.
  let settledRows;
  let liveRows;
  let lastRows;
  try {
    execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/seed`, 'alpine:3.20', 'sh', '-c',
      `apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /seed/${dbFile} "
        CREATE TABLE markets (outcome_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, quote_token TEXT NOT NULL, updated_at INTEGER NOT NULL, resolution_text TEXT, underlying TEXT, strike REAL, expiry_utc TEXT);
        CREATE TABLE price_history (outcome_id INTEGER NOT NULL, ts INTEGER NOT NULL, yes_mid REAL NOT NULL, PRIMARY KEY (outcome_id, ts));
        INSERT INTO markets (outcome_id, display_name, category, status, quote_token, updated_at, resolution_text) VALUES
          (1001, 'Wintermute', 'test', 'settled', 'USDC', 1000, 'This outcome resolves to Yes if Wintermute wins.'),
          (1002, 'Fallback', 'test', 'settled', 'USDC', 1000, ''),
          (1003, 'StillLive', 'test', 'settled', 'USDC', 1000, 'This outcome resolves to Yes if StillLive wins.'),
          (1004, 'Gone Team', 'test', 'live', 'USDC', 1000, 'The market resolves to Gone Team if it wins.'),
          (1005, 'Still Trading', 'test', 'live', 'USDC', 1000, 'This outcome resolves to Yes if Still Trading wins.'),
          (1006, 'Recurring Named Outcome', 'test', 'live', 'USDC', 1000, 'index:0'),
          (1007, 'Otoro', 'test', 'live', 'USDC', 1000, 'Fatty tuna');
        INSERT INTO price_history (outcome_id, ts, yes_mid) VALUES
          (1001, 2000, 0.02), (1002, 2000, 0.5), (1003, 2000, 0.61),
          (1004, 2000, 0.03), (1005, 2000, 0.77), (1006, 2000, 0.4), (1007, 2000, 0.9);
      "`,
    ], { encoding: 'utf8' });

    settledRows = runSql(dir, dbFile, "SELECT outcome_id, display_name, resolution_text FROM markets WHERE status='settled' ORDER BY outcome_id");
    liveRows = runSql(dir, dbFile, "SELECT outcome_id, display_name, resolution_text FROM markets WHERE status='live' ORDER BY outcome_id");
    lastRows = runSql(dir, dbFile, `
      SELECT p.outcome_id, p.ts, p.yes_mid FROM price_history p
      JOIN (SELECT outcome_id, MAX(ts) AS max_ts FROM price_history GROUP BY outcome_id) m
        ON p.outcome_id = m.outcome_id AND p.ts = m.max_ts`);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    t.skip(`docker/sqlite runtime failure, skipping: ${err.message}`);
    return;
  }

  try {
    const lastPriceByOutcome = new Map(lastRows.map((r) => [r.outcome_id, { yes: r.yes_mid, at: new Date(r.ts).toISOString() }]));

    assert.equal(settledRows.length, 3);
    assert.equal(liveRows.length, 4);

    const settledEntries = buildEntries(settledRows, LIVE_NOW, lastPriceByOutcome);
    const reconstructedEntries = buildEntries(liveRows, LIVE_NOW, lastPriceByOutcome);

    // settled bucket: only Wintermute survives (Fallback excluded, StillLive collides with today's catalog)
    assert.deepEqual(settledEntries.map((e) => e.outcomeId), [1001]);
    assert.equal(settledEntries[0].lastPrice.yes, 0.02);
    assert.equal(settledEntries[0].seedSource, 'alpha-db-2026-07-10');

    // reconstructed bucket: Gone Team + blanked Recurring Named Outcome survive;
    // Still Trading (still live today) and Otoro (non-market fixture row) excluded
    assert.deepEqual(reconstructedEntries.map((e) => e.outcomeId).sort(), [1004, 1006]);
    assert.equal(reconstructedEntries.find((e) => e.outcomeId === 1006).resolutionText, '');

    // duplicate-refusal path
    const { freshCount, duplicateCount } = mergeArchive([{ outcomeId: 1001 }], [...settledEntries, ...reconstructedEntries]);
    assert.equal(freshCount, 2);
    assert.equal(duplicateCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
