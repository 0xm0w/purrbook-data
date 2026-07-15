// Fires IndexNow (Bing-class; Google learns via sitemap lastmod) and the
// Vercel revalidate endpoint for changed paths. Never fails the run: the
// snapshot commit is the product; notifications are best-effort accelerants.
import { readFileSync } from 'node:fs';

const { changedPaths, structural } = JSON.parse(readFileSync('.run-summary', 'utf8'));
const BASE = 'https://purrbook.xyz';
const key = process.env.INDEXNOW_KEY;
const token = process.env.REVALIDATE_TOKEN;
const paths = structural ? [...changedPaths, '/sitemap.xml', '/llms.txt'] : [];
if (paths.length === 0) { console.log('no structural change — no pings'); process.exit(0); }

try {
  if (key) {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'purrbook.xyz', key, keyLocation: `${BASE}/${key}.txt`, urlList: paths.map((p) => BASE + p) }),
    });
    console.log('indexnow:', res.status);
  }
} catch (e) { console.log('indexnow failed (non-fatal):', String(e)); }

try {
  if (token) {
    const res = await fetch(`${BASE}/revalidate`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ paths }),
    });
    console.log('revalidate:', res.status);
  }
} catch (e) { console.log('revalidate failed (non-fatal):', String(e)); }
