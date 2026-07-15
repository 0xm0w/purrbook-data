import { readFileSync, writeFileSync } from 'node:fs';
import { buildCatalog, diffAndFreeze } from './snapshot.mjs';

const HL = 'https://api.hyperliquid.xyz/info';
async function info(type) {
  const res = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }) });
  if (!res.ok) throw new Error(`HL ${type}: ${res.status}`);
  return res.json();
}
const nowIso = new Date().toISOString();
const [outcomeMeta, allMids] = await Promise.all([info('outcomeMeta'), info('allMids')]);
const overlay = JSON.parse(readFileSync('meta/overlay.json', 'utf8'));
const prevCatalog = JSON.parse(readFileSync('catalog.json', 'utf8'));
const prevArchive = JSON.parse(readFileSync('archive.json', 'utf8'));
const next = buildCatalog(outcomeMeta, allMids, overlay, nowIso);
const { archiveAdditions, changedPaths } = diffAndFreeze(prevCatalog, next, prevArchive, nowIso);
// Meaningful change = listings/settlements OR first-ever snapshot. Prices move
// every run; committing every 10 min is fine (that IS the freshness product),
// but skip when byte-identical modulo timestamps AND no structural change:
const structural = archiveAdditions.length > 0 || changedPaths.length > 0
  || prevCatalog.generatedAt === null;
// Write order is crash-safety: archive.json FIRST, then catalog.json. If we
// crash between the two, the old catalog.json still contains the settled
// outcome, so the next run re-detects the settlement — and the archived-id
// guard in diffAndFreeze refuses the duplicate (data preserved; only that
// settlement's one-time notify signal is skipped).
// Writing catalog.json first would drop the outcome from prevCatalog before
// it was ever archived: the frozen settlement would be permanently lost.
if (archiveAdditions.length) {
  writeFileSync('archive.json', JSON.stringify([...prevArchive, ...archiveAdditions], null, 2) + '\n');
}
writeFileSync('catalog.json', JSON.stringify(next, null, 2) + '\n');
const summary = `snapshot: ${nowIso} (+${changedPaths.length - archiveAdditions.length} listed, ${archiveAdditions.length} settled)`;
writeFileSync('.run-summary', JSON.stringify({ summary, changedPaths, structural }) + '\n');
console.log(summary);
