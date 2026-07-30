// GENERATED from packages/shared/src/priceBucket.ts by scripts/emit-price-bucket.mjs — DO NOT EDIT.
// Mirrored verbatim into 0xm0w/purrbook-data, whose snapshot writer is
// zero-dependency and cannot compile TypeScript. Regenerate with:
//   node scripts/emit-price-bucket.mjs --write
/**
 * Hyperliquid HIP-4 `priceBucket` questions: "where does BTC close?", expressed
 * as N thresholds and N+1 mutually exclusive bands. Unlike a price binary, the
 * market spec lives on the QUESTION and each leg carries only `index:N` — see
 * the 2026-07-26 spec for why that shape once made these markets invisible.
 *
 * THIS FILE MUST NEVER IMPORT ANYTHING. It is compiled standalone and mirrored
 * into the public purrbook-data repo, whose snapshot writer is zero-dependency.
 * A test in priceBucket.test.ts enforces this.
 */
const BUCKET_RE = /^class:priceBucket\|underlying:([^|]+)\|expiry:([^|]+)\|priceThresholds:([^|]+)\|period:([^|]+)$/;
/**
 * Parses a question description. Returns null for anything that is not a
 * well-formed bucket spec — including thresholds that are not strictly
 * ascending, which would make the bands overlap or invert. Callers treat null
 * as "unparsed" and take the degraded path rather than guessing.
 */
export function parseBucketSpec(questionDescription) {
    const match = BUCKET_RE.exec(questionDescription);
    if (!match)
        return null;
    const rawThresholds = match[3].split(',').map((raw) => raw.trim());
    // Number('') is 0, not NaN — reject a blank token BEFORE Number() runs, or
    // an empty element (e.g. a leading/trailing comma: `priceThresholds:,62715`)
    // parses as a real threshold of 0. That's not just wrong, it's dangerously
    // wrong: [0, 62715] is still strictly ascending, so the ascending-order
    // check below never catches it and the spec parses "successfully" with a
    // fabricated $0 band boundary — see composeSnapshot's settleFraction fix
    // for the same hazard one file over.
    if (rawThresholds.some((raw) => raw === ''))
        return null;
    const thresholds = rawThresholds.map((raw) => Number(raw));
    if (thresholds.length === 0)
        return null;
    if (!thresholds.every((value) => Number.isFinite(value)))
        return null;
    for (let i = 1; i < thresholds.length; i += 1) {
        if (thresholds[i] <= thresholds[i - 1])
            return null;
    }
    return {
        underlying: match[1],
        expiry: match[2],
        thresholds,
        period: match[4],
    };
}
/** Exact rendering — a rounded threshold would misstate the level that decides the money. */
function money(value) {
    // en-US's default maximumFractionDigits is 3, which would round a threshold
    // like 1234.56789 to $1,234.568 — silently misstating the level that decides
    // the money. 20 is the max Intl allows; it preserves every input digit while
    // still applying thousands separators.
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 20 })}`;
}
export function bandsFor(spec) {
    const t = spec.thresholds;
    if (t.length === 0)
        return [];
    const bands = [{ index: 0, upper: t[0], label: `Below ${money(t[0])}` }];
    for (let i = 1; i < t.length; i += 1) {
        bands.push({
            index: i,
            lower: t[i - 1],
            upper: t[i],
            label: `${money(t[i - 1])} – ${money(t[i])}`,
        });
    }
    bands.push({ index: t.length, lower: t[t.length - 1], label: `Above ${money(t[t.length - 1])}` });
    return bands;
}
/**
 * Stable across daily re-mints: derived from underlying + period only, never
 * the session's expiry or its outcome ids. One canonical URL accrues SEO while
 * the membership behind it rotates.
 */
export function bucketEventId(spec) {
    return `${spec.underlying.toLowerCase()}-range-${spec.period.toLowerCase()}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * Titles the session currently sitting behind the stable id. Dated from the
 * spec's own expiry in UTC. A malformed or out-of-range expiry drops the date
 * rather than inventing one.
 */
export function bucketEventTitle(spec) {
    const base = `${spec.underlying} Price Range · ${spec.period.toUpperCase()}`;
    const match = /^(\d{4})(\d{2})(\d{2})-\d{4}$/.exec(spec.expiry);
    if (!match)
        return base;
    const month = Number(match[2]);
    if (month < 1 || month > 12)
        return base;
    const day = Number(match[3]);
    if (day < 1 || day > 31)
        return base;
    return `${base} (${MONTHS[month - 1]} ${day})`;
}
/** "20260726-0600" -> "2026-07-26 06:00 UTC". Local copy: this file cannot import expiry.ts. */
function formatBucketExpiry(expiry) {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(expiry);
    if (!match)
        return expiry;
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC`;
}
/**
 * `band.upper` is absent only on the open-above band, which is never the one
 * being read here — but the `Band` type can't express that cross-field
 * invariant, so `bucketResolutionText` can't get TypeScript to narrow it for
 * free. A real check beats a silent assertion: if a hand-built `Band` ever
 * violates the invariant, this fails loudly instead of asserting past it (an
 * `as`/`!` would either lie about the type or get flagged as pointless by the
 * lint rule that requires proof, not assertion, of non-nullability).
 */
function requireBound(value) {
    if (value == null)
        throw new Error('priceBucket: band is missing an expected bound');
    return value;
}
/**
 * Show the judge (product rule #2). Deliberately never asserts `<` versus `≤`:
 * boundary inclusivity at an exact threshold is unverified (spec §1.2), so the
 * raw Hyperliquid spec is quoted and HyperCore mark-at-expiry is named instead.
 */
export function bucketResolutionText(spec, band, rawQuestionDescription) {
    const where = band.lower == null
        ? `below ${money(requireBound(band.upper))}`
        : band.upper == null
            ? `above ${money(band.lower)}`
            : `between ${money(band.lower)} and ${money(band.upper)}`;
    return (`Resolves YES if ${spec.underlying} settles ${where} at ${formatBucketExpiry(spec.expiry)}. ` +
        `Settles to the ${spec.underlying} mark price on HyperCore. ` +
        `Hyperliquid's market spec: ${rawQuestionDescription}`);
}
