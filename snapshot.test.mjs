import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, buildCatalog, diffAndFreeze } from './snapshot.mjs';
import { readFileSync } from 'node:fs';

const outcomeMeta = JSON.parse(readFileSync('fixtures/outcomeMeta.json', 'utf8'));
const allMids = JSON.parse(readFileSync('fixtures/allMids.json', 'utf8'));
const overlay = { events: { 'wc-champion-2026': { eventId: 'wc-champion-2026', title: 'World Cup Winner', category: 'soccer' } }, markets: [{ outcomeId: 173, eventId: 'wc-champion-2026' }] };
const NOW = '2026-07-16T06:00:00Z';

test('parseRule strips the metadata pipe-suffix and nothing else', () => {
  assert.equal(parseRule('Resolves Yes if X. metadata=category:sports|subCategory:football'), 'Resolves Yes if X.');
  assert.equal(parseRule('No suffix here.'), 'No suffix here.');
});

test('buildCatalog: every non-Fallback outcome priced from #N mids, linked to question + event', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  assert.equal(cat.generatedAt, NOW);
  const arg = cat.outcomes.find((o) => o.outcomeId === 173);
  assert.ok(arg, 'outcome 173 present');
  assert.equal(arg.isFallback, false);
  assert.equal(typeof arg.yesPrice, 'number');
  assert.equal(arg.priceAt, NOW);
  assert.ok(arg.resolutionText.length > 0 && !arg.resolutionText.includes('metadata='));
  const q = cat.questions.find((q) => q.questionId === arg.questionId);
  assert.equal(q.eventId, 'wc-champion-2026');
});

test('buildCatalog: Fallback outcomes flagged, never priced-required', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  for (const o of cat.outcomes.filter((o) => o.displayName === 'Fallback')) {
    assert.equal(o.isFallback, true);
  }
});

test('diffAndFreeze: outcome absent from next catalog is frozen with identity + last price', () => {
  const prev = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const gone = prev.outcomes.find((o) => !o.isFallback);
  const next = { ...prev, outcomes: prev.outcomes.filter((o) => o.outcomeId !== gone.outcomeId) };
  const { archiveAdditions, changedPaths } = diffAndFreeze(prev, next, [], '2026-07-16T06:10:00Z');
  assert.equal(archiveAdditions.length, 1);
  const f = archiveAdditions[0];
  assert.equal(f.outcomeId, gone.outcomeId);
  assert.equal(f.resolutionText, gone.resolutionText);
  assert.deepEqual(f.lastPrice, { yes: gone.yesPrice, at: gone.priceAt });
  assert.equal(f.settledObservedAt, '2026-07-16T06:10:00Z');
  assert.ok(!('winner' in f), 'never claims a winner');
  assert.ok(changedPaths.includes(`/market/${gone.outcomeId}`));
});

test('diffAndFreeze: duplicate outcomeId already in archive is refused (seed-collision guard)', () => {
  const prev = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const gone = prev.outcomes.find((o) => !o.isFallback);
  const next = { ...prev, outcomes: prev.outcomes.filter((o) => o.outcomeId !== gone.outcomeId) };
  const prevArchive = [{ outcomeId: gone.outcomeId, displayName: 'old' }];
  const { archiveAdditions } = diffAndFreeze(prev, next, prevArchive, NOW);
  assert.equal(archiveAdditions.length, 0);
});

test('diffAndFreeze: identical catalogs → no additions, no changed paths (idempotent, no-commit)', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const { archiveAdditions, changedPaths } = diffAndFreeze(cat, cat, [], NOW);
  assert.equal(archiveAdditions.length, 0);
  assert.deepEqual(changedPaths, []);
});

test('buildCatalog: malformed outcomeMeta throws (run must exit non-zero, write nothing)', () => {
  assert.throws(() => buildCatalog({ nope: true }, allMids, overlay, NOW));
});

test('new outcome between runs produces its changed path (for revalidate + IndexNow)', () => {
  const next = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const newOutcome = next.outcomes.find((o) => !o.isFallback);
  const prev = { ...next, outcomes: next.outcomes.filter((o) => o.outcomeId !== newOutcome.outcomeId) };
  const { changedPaths } = diffAndFreeze(prev, next, [], NOW);
  assert.ok(changedPaths.includes(`/market/${newOutcome.outcomeId}`));
});
