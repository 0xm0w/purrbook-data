# purrbook-data

[![snapshot](https://github.com/0xm0w/purrbook-data/actions/workflows/snapshot.yml/badge.svg)](https://github.com/0xm0w/purrbook-data/actions/workflows/snapshot.yml)

Public Hyperliquid (HIP-4) prediction-market catalog snapshots and a permanent
settlement archive. This is the data plane behind [purrbook.xyz](https://purrbook.xyz)'s
crawl surface — the site renders from these files whenever its live indexer is
unreachable, so the market pages, sitemap, and llms.txt never go dark.

## Data files

| File | What it is | Update behavior |
|---|---|---|
| `catalog.json` | Every live HIP-4 question and outcome: names, verbatim resolution rules, YES-side mid prices with per-run timestamps | Overwritten by the pipeline (~10-minute cadence) |
| `archive.json` | Permanent record of settled outcomes: identity, resolution rule, last observed price, and when settlement was observed | Append-only — entries are never rewritten or removed |
| `meta/overlay.json` | Display curation (event groupings, competition labels) mirrored from the Purrbook indexer | On curation changes |

## Consuming

Fetch raw from `main` — no auth, no rate ceremony:

```
https://raw.githubusercontent.com/0xm0w/purrbook-data/main/catalog.json
https://raw.githubusercontent.com/0xm0w/purrbook-data/main/archive.json
```

Raw CDN propagation from commit is typically seconds. `generatedAt` and every
price's `priceAt` tell you exactly how fresh what you're holding is.

## Honesty guarantees

- Every price carries its observation timestamp — nothing is presented fresher
  than it is.
- Resolution rules are the venue's text, verbatim — never paraphrased. Markets
  whose on-chain description is machine metadata carry an empty rule rather
  than a fabricated one.
- Archive entries never claim a **winner** — only observed prices and the rule.
  Settlement outcomes belong to the venue's resolution, not to inference.
- Non-tradable fallback legs are flagged (`isFallback`) and never archived.

## How it runs

A zero-dependency Node script (`snapshot.mjs` / `run.mjs`) executes on a
GitHub Actions schedule, reading Hyperliquid's public info API and committing
diffs as `purrbook-snapshot`. When an outcome leaves the live catalog, it is
frozen into the archive in the same run — settlements are captured the moment
they happen, unattended. A small Cloudflare Worker (`tools/watchdog/`)
re-dispatches the workflow if GitHub's scheduler drifts.

The pipeline owns `main`. Human commits are limited to the writer/tooling code
via PR; the data files are machine-written.

## License

Code is [MIT](LICENSE). The JSON data files record public Hyperliquid market
facts.
