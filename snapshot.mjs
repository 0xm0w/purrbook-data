// snapshot.mjs — zero-dependency snapshot writer. Pure core + thin CLI.
// Prices come from allMids: coin '#'+(outcomeId*10) is the YES leg
// (verified against live data 2026-07-16; Task 2 Step 2 re-checks fixtures).
import { parseBucketSpec, bandsFor, bucketEventId, bucketEventTitle } from './priceBucket.mjs';

export function parseRule(description) {
  const i = description.lastIndexOf(' metadata=');
  return i === -1 ? description : description.slice(0, i);
}

// Machine-blob descriptions (class:priceBinary|underlying:BTC|expiry:20260716-0600|
// targetPrice:64953|period:1d) are blanked as rule text (§ Phase 2) but still
// carry the judge-relevant facts — parse them BEFORE blanking. Expiry compact
// form YYYYMMDD-HHMM is UTC (mirrors @hypebet/shared compactExpiryToIso).
function parseBinaryFields(rawRule) {
  if (!/^class:/.test(rawRule)) return {};
  const kv = Object.fromEntries(rawRule.split('|').map((p) => p.split(':', 2)));
  const out = {};
  if (kv.underlying) out.underlying = kv.underlying;
  const strike = Number(kv.targetPrice);
  if (Number.isFinite(strike)) out.strike = strike;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(kv.expiry ?? '');
  if (m) out.expiryUtc = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
  return out;
}

export function buildCatalog(outcomeMeta, allMids, overlay, nowIso) {
  if (!Array.isArray(outcomeMeta?.outcomes) || !Array.isArray(outcomeMeta?.questions)) {
    throw new Error('malformed outcomeMeta');
  }
  const eventByOutcome = new Map(
    (overlay.markets ?? []).filter((m) => m.eventId).map((m) => [m.outcomeId, m.eventId]),
  );
  // Protocol-declared fallbacks: a question's fallbackOutcome is a fallback even
  // when its name isn't literally "Fallback" (e.g. recurring groups' "Recurring
  // Fallback") — missing this would ship it tradable-looking and freeze it into
  // the archive on the first recurring-group rotation.
  const fallbackIds = new Set(
    outcomeMeta.questions.map((q) => q.fallbackOutcome).filter((x) => x != null),
  );
  // Questions whose RAW description is a machine blob ("class:priceBucket|…"):
  // their member outcomes' descriptions are config fragments ("index:0", "other"),
  // not resolution rules — blank those too.
  const blobQuestionIds = new Set(
    outcomeMeta.questions
      .filter((q) => /^class:/.test(parseRule(q.description ?? '')))
      .map((q) => q.question),
  );
  // Price-bucket questions carry the whole market spec; their member outcomes
  // carry only `index:N`. Resolve each question's spec once, then bind each leg
  // to its band. Without this the legs ship as "Recurring Named Outcome" — the
  // literal HL placeholder — on a public, indexable surface.
  const bucketByQuestion = new Map();
  for (const q of outcomeMeta.questions) {
    const spec = parseBucketSpec(parseRule(q.description ?? ''));
    if (spec) bucketByQuestion.set(q.question, { spec, bands: bandsFor(spec) });
  }
  const questions = outcomeMeta.questions.map((q) => {
    // A question's eventId: any member outcome carrying one in the overlay.
    const memberIds = [...(q.namedOutcomes ?? []), q.fallbackOutcome].filter((x) => x != null);
    const eventId = memberIds.map((id) => eventByOutcome.get(id)).find(Boolean) ?? null;
    const ev = eventId ? overlay.events?.[eventId] : null;
    const desc = parseRule(q.description ?? '');
    const bucket = bucketByQuestion.get(q.question);
    // A bucket event can never be curated, because its ids re-mint daily — a
    // hand-curated overlay event still wins over the derived one when present.
    const derived = bucket
      ? { eventId: bucketEventId(bucket.spec), eventTitle: bucketEventTitle(bucket.spec), category: 'crypto' }
      : null;
    return {
      questionId: q.question, name: q.name,
      description: /^class:/.test(desc) ? '' : desc,
      fallbackOutcome: q.fallbackOutcome ?? null,
      ...(ev ? { eventId, eventTitle: ev.title, category: ev.category } : derived ?? {}),
    };
  });
  const questionByOutcome = new Map();
  for (const q of outcomeMeta.questions) {
    for (const id of [...(q.namedOutcomes ?? []), q.fallbackOutcome]) {
      if (id != null) questionByOutcome.set(id, q.question);
    }
  }
  const outcomes = outcomeMeta.outcomes.map((o) => {
    const yes = Number(allMids[`#${o.outcome * 10}`]);
    const rawRule = o.description ?? '';
    const rule = parseRule(rawRule);
    const binaryFields = parseBinaryFields(rawRule);
    const isMarked = /^class:/.test(rule) || blobQuestionIds.has(questionByOutcome.get(o.outcome));
    const isFallbackLeg = o.name === 'Fallback' || fallbackIds.has(o.outcome);
    const bucket = bucketByQuestion.get(questionByOutcome.get(o.outcome));
    // The leg's own description is the bare `index:N`; fall back to its position
    // in namedOutcomes. A band count disagreeing with the question's leg count
    // means a shape we do not understand — leave it unnamed rather than mislabel.
    const bandIndexMatch = /^index:(\d+)$/.exec(rawRule);
    const q = bucket && outcomeMeta.questions.find((x) => x.question === questionByOutcome.get(o.outcome));
    const bandIndex = bandIndexMatch ? Number(bandIndexMatch[1]) : q ? (q.namedOutcomes ?? []).indexOf(o.outcome) : -1;
    const rawBand =
      bucket && q && bucket.bands.length === (q.namedOutcomes ?? []).length ? bucket.bands[bandIndex] : undefined;
    // Hoisted so EVERY band field is gated on the same condition. Gating only
    // displayName/bucketIndex on !isFallbackLeg would let a fallback leg ship
    // orphaned bucketLower/bucketUpper with no index and no label — and
    // diffAndFreeze would carry those bounds into the permanent archive — if HL
    // ever tags the fallback with an `index:N` instead of today's "other".
    const band = rawBand && !isFallbackLeg ? rawBand : undefined;
    return {
      outcomeId: o.outcome, displayName: o.name,
      questionId: questionByOutcome.get(o.outcome) ?? null,
      // Recurring outcomes carry machine config ("class:priceBinary|underlying:BTC|…"
      // on the outcome, or "index:0"/"other" under a blob question), not a human
      // resolution rule — ship '' so the floor renders no rule rather than a fake
      // judge (web's faqPageLd already nulls on empty).
      resolutionText: isMarked ? '' : rule,
      yesPrice: Number.isFinite(yes) ? yes : null, priceAt: nowIso,
      isFallback: isFallbackLeg,
      ...(binaryFields.underlying && { underlying: binaryFields.underlying }),
      ...(Number.isFinite(binaryFields.strike) && { strike: binaryFields.strike }),
      ...(binaryFields.expiryUtc && { expiryUtc: binaryFields.expiryUtc }),
      resolutionSource: isMarked || blobQuestionIds.has(questionByOutcome.get(o.outcome)) ? 'mark' : 'validators',
      ...(band && { displayName: band.label, bucketIndex: band.index }),
      ...(band && band.lower != null && { bucketLower: band.lower }),
      ...(band && band.upper != null && { bucketUpper: band.upper }),
    };
  });
  return { generatedAt: nowIso, questions, outcomes };
}

export function diffAndFreeze(prevCatalog, nextCatalog, prevArchive, nowIso) {
  const nextIds = new Set(nextCatalog.outcomes.map((o) => o.outcomeId));
  const archived = new Set(prevArchive.map((a) => a.outcomeId));
  const archiveAdditions = (prevCatalog?.outcomes ?? [])
    .filter((o) => !o.isFallback && !nextIds.has(o.outcomeId) && !archived.has(o.outcomeId))
    .map((o) => {
      const q = (prevCatalog.questions ?? []).find((q) => q.questionId === o.questionId);
      return {
        outcomeId: o.outcomeId, displayName: o.displayName, questionId: o.questionId,
        ...(q?.eventId && { eventId: q.eventId }),
        resolutionText: o.resolutionText,
        ...(o.underlying && { underlying: o.underlying }),
        ...(Number.isFinite(o.strike) && { strike: o.strike }),
        ...(o.expiryUtc && { expiryUtc: o.expiryUtc }),
        ...(o.bucketIndex != null && { bucketIndex: o.bucketIndex }),
        ...(o.bucketLower != null && { bucketLower: o.bucketLower }),
        ...(o.bucketUpper != null && { bucketUpper: o.bucketUpper }),
        resolutionSource: o.resolutionSource,
        ...(q?.eventTitle && { eventTitle: q.eventTitle }),
        lastPrice: { yes: o.yesPrice, at: o.priceAt },
        settledObservedAt: nowIso,
      };
    });
  const prevById = new Map((prevCatalog?.outcomes ?? []).map((o) => [o.outcomeId, o]));
  const changedPaths = [
    ...nextCatalog.outcomes.filter((o) => !o.isFallback && !prevById.has(o.outcomeId))
      .map((o) => `/market/${o.outcomeId}`),
    ...archiveAdditions.map((a) => `/market/${a.outcomeId}`),
  ];
  return { archiveAdditions, changedPaths };
}
