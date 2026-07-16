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

test('buildCatalog: protocol-declared fallback (question.fallbackOutcome) is flagged isFallback', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  // Question 145 declares fallbackOutcome 843 ("Recurring Fallback") — name is NOT literally "Fallback".
  const rec = cat.outcomes.find((o) => o.outcomeId === 843);
  assert.ok(rec, 'outcome 843 present in fixture');
  assert.equal(rec.isFallback, true);
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

test('diffAndFreeze: protocol-declared fallback rotating out is never frozen or signaled', () => {
  const prev = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  // 843 is question 145's fallbackOutcome — recurring-group rotation must not archive it.
  const next = { ...prev, outcomes: prev.outcomes.filter((o) => o.outcomeId !== 843) };
  const { archiveAdditions, changedPaths } = diffAndFreeze(prev, next, [], NOW);
  assert.equal(archiveAdditions.length, 0);
  assert.deepEqual(changedPaths, []);
});

test('buildCatalog is deterministic: two independent builds from same inputs are byte-identical', () => {
  const cat1 = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const cat2 = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  assert.equal(JSON.stringify(cat1), JSON.stringify(cat2));
});

test('diffAndFreeze: independently-built identical catalogs → no additions, no changed paths (idempotent, no-commit)', () => {
  const cat1 = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const cat2 = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const { archiveAdditions, changedPaths } = diffAndFreeze(cat1, cat2, [], NOW);
  assert.equal(archiveAdditions.length, 0);
  assert.deepEqual(changedPaths, []);
});

test('buildCatalog: malformed outcomeMeta throws (run must exit non-zero, write nothing)', () => {
  assert.throws(() => buildCatalog({ nope: true }, allMids, overlay, NOW));
});

test('buildCatalog: class:priceBinary machine-blob description yields empty resolutionText (no fake judge)', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  // Fixture outcome 839: "class:priceBinary|underlying:BTC|expiry:...|targetPrice:..." — config, not a rule.
  const rec = cat.outcomes.find((o) => o.outcomeId === 839);
  assert.ok(rec, 'outcome 839 present in fixture');
  assert.equal(rec.resolutionText, '');
});

test('buildCatalog: class:* machine-blob question description yields empty description', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  // Fixture question 145: "class:priceBucket|underlying:BTC|..." — config, not a rule.
  const q = cat.questions.find((q) => q.questionId === 145);
  assert.ok(q, 'question 145 present in fixture');
  assert.equal(q.description, '');
});

test('buildCatalog: members of a machine-blob question get empty resolutionText (index:N / other blobs)', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  // Outcome 844 ("index:0") belongs to blob question 145 — its description is config too.
  const named = cat.outcomes.find((o) => o.outcomeId === 844);
  assert.ok(named, 'outcome 844 present in fixture');
  assert.equal(named.resolutionText, '');
});

test('new outcome between runs produces its changed path (for revalidate + IndexNow)', () => {
  const next = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const newOutcome = next.outcomes.find((o) => !o.isFallback);
  const prev = { ...next, outcomes: next.outcomes.filter((o) => o.outcomeId !== newOutcome.outcomeId) };
  const { changedPaths } = diffAndFreeze(prev, next, [], NOW);
  assert.ok(changedPaths.includes(`/market/${newOutcome.outcomeId}`));
});

test('priceBinary outcomes carry parsed underlying/strike/expiryUtc + resolutionSource mark', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const bin = cat.outcomes.find((o) => o.outcomeId === 839); // class:priceBinary|underlying:BTC|expiry:20260716-0600|targetPrice:64953|period:1d
  assert.equal(bin.underlying, 'BTC');
  assert.equal(bin.strike, 64953);
  assert.equal(bin.expiryUtc, '2026-07-16T06:00:00Z');
  assert.equal(bin.resolutionSource, 'mark');
});

test('event outcomes: no binary fields, resolutionSource validators', () => {
  const cat = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const arg = cat.outcomes.find((o) => o.outcomeId === 173);
  assert.equal(arg.underlying, undefined);
  assert.equal(arg.resolutionSource, 'validators');
});

test('freeze inherits binary fields, resolutionSource, and eventTitle', () => {
  const prev = buildCatalog(outcomeMeta, allMids, overlay, NOW);
  const gone = prev.outcomes.find((o) => o.outcomeId === 173);
  const next = { ...prev, outcomes: prev.outcomes.filter((o) => o.outcomeId !== 173) };
  const { archiveAdditions } = diffAndFreeze(prev, next, [], NOW);
  const f = archiveAdditions[0];
  assert.equal(f.resolutionSource, 'validators');
  assert.equal(f.eventTitle, 'World Cup Winner'); // overlay fixture's event title
  assert.ok(!('winner' in f));
});
