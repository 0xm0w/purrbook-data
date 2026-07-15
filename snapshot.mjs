// snapshot.mjs — zero-dependency snapshot writer. Pure core + thin CLI.
// Prices come from allMids: coin '#'+(outcomeId*10) is the YES leg
// (verified against live data 2026-07-16; Task 2 Step 2 re-checks fixtures).
export function parseRule(description) {
  const i = description.lastIndexOf(' metadata=');
  return i === -1 ? description : description.slice(0, i);
}

export function buildCatalog(outcomeMeta, allMids, overlay, nowIso) {
  if (!Array.isArray(outcomeMeta?.outcomes) || !Array.isArray(outcomeMeta?.questions)) {
    throw new Error('malformed outcomeMeta');
  }
  const eventByOutcome = new Map(
    (overlay.markets ?? []).filter((m) => m.eventId).map((m) => [m.outcomeId, m.eventId]),
  );
  const questions = outcomeMeta.questions.map((q) => {
    // A question's eventId: any member outcome carrying one in the overlay.
    const memberIds = [...(q.namedOutcomes ?? []), q.fallbackOutcome].filter((x) => x != null);
    const eventId = memberIds.map((id) => eventByOutcome.get(id)).find(Boolean) ?? null;
    const ev = eventId ? overlay.events?.[eventId] : null;
    return {
      questionId: q.question, name: q.name, description: parseRule(q.description ?? ''),
      fallbackOutcome: q.fallbackOutcome ?? null,
      ...(ev && { eventId, eventTitle: ev.title, category: ev.category }),
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
    return {
      outcomeId: o.outcome, displayName: o.name,
      questionId: questionByOutcome.get(o.outcome) ?? null,
      resolutionText: parseRule(o.description ?? ''),
      yesPrice: Number.isFinite(yes) ? yes : null, priceAt: nowIso,
      isFallback: o.name === 'Fallback',
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
