#!/usr/bin/env node
// Standalone Playwright script to locate /blog or /posts URLs via sitemap
// Usage: node scripts/find-blog.js https://example.com

const playwright = require('playwright');
const zlib = require('zlib');
const fs = require('fs').promises;
const path = require('path');

function ensureUrl(input) {
  try {
    return new URL(input).href;
  } catch (e) {
    return new URL('http://' + input).href;
  }
}

async function fetchWithApi(api, url) {
  const res = await api.get(url);
  if (!res.ok()) return null;
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  if (ct.includes('gzip') || url.toLowerCase().endsWith('.gz')) {
    const body = await res.body();
    try {
      return zlib.gunzipSync(body).toString('utf8');
    } catch (err) {
      // fallback
      return body.toString();
    }
  }
  return await res.text();
}

function extractLocsFromSitemap(xmlText) {
  if (!xmlText) return [];
  const locs = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    locs.push(m[1].trim());
  }
  return Array.from(new Set(locs));
}

function findMatches(urls, patterns, rootOnly = true) {
  const found = new Set();
  for (const u of urls) {
    try {
      const p = new URL(u);
      const pathname = (p.pathname || '/').toLowerCase();
      for (const pat of patterns) {
        const normPat = pat.toLowerCase();
        if (rootOnly) {
          // match exact root path, allow optional trailing slash
          if (pathname === normPat || pathname === normPat + '/') found.add(u);
        } else {
          if (pathname.includes(normPat)) found.add(u);
        }
      }
    } catch (e) {
      for (const pat of patterns) {
        const normPat = pat.toLowerCase();
        if (rootOnly) {
          // fallback simple check
          const pth = u.split('?')[0].split('#')[0].toLowerCase();
          if (pth.endsWith(normPat) || pth.endsWith(normPat + '/')) found.add(u);
        } else {
          if (u.toLowerCase().includes(normPat)) found.add(u);
        }
      }
    }
  }
  return Array.from(found);
}

async function getSitemapCandidates(rootUrl) {
  const u = new URL(rootUrl);
  const base = u.origin;
  return [
    base + '/sitemap.xml',
    base + '/sitemap_index.xml',
    base + '/sitemap.xml.gz',
    base + '/sitemap-index.xml'
  ];
}

async function findSitemapsFromRobots(api, rootUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', rootUrl).href;
    const txt = await fetchWithApi(api, robotsUrl);
    if (!txt) return [];
    const lines = txt.split(/\r?\n/);
    const s = [];
    for (const line of lines) {
      const m = line.match(/^\s*Sitemap:\s*(.+)$/i);
      if (m) s.push(m[1].trim());
    }
    return s;
  } catch (e) {
    return [];
  }
}

async function findFromHomepage(page, rootUrl, patterns) {
  try {
    const res = await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!res || res.status() >= 400) return [];
    const hrefs = await page.$$eval('a[href]', els => els.map(a => a.getAttribute('href')));
    const absolute = hrefs
      .filter(Boolean)
      .map(h => {
        try { return new URL(h, rootUrl).href; } catch (e) { return null; }
      })
      .filter(Boolean);
    return findMatches(absolute, patterns);
  } catch (e) {
    return [];
  }
}

async function findBlogForRoot(api, browser, root, patterns) {
  // 1) Try known sitemap locations
  const candidates = await getSitemapCandidates(root);
  let allLocs = [];
  for (const c of candidates) {
    const text = await fetchWithApi(api, c).catch(() => null);
    if (text) {
      const locs = extractLocsFromSitemap(text);
      if (locs.length) allLocs = allLocs.concat(locs);
      // If sitemap is an index, it may contain sitemap URLs; try to fetch them too
      if (/sitemapindex/i.test(text)) {
        const nested = extractLocsFromSitemap(text);
        for (const s of nested) {
          const t2 = await fetchWithApi(api, s).catch(() => null);
          if (t2) allLocs = allLocs.concat(extractLocsFromSitemap(t2));
        }
      }
    }
  }

  // 2) Look for sitemaps in robots.txt
  if (allLocs.length === 0) {
    const robotsSitemaps = await findSitemapsFromRobots(api, root);
    for (const s of robotsSitemaps) {
      const t = await fetchWithApi(api, s).catch(() => null);
      if (t) allLocs = allLocs.concat(extractLocsFromSitemap(t));
    }
  }

  // clean
  allLocs = Array.from(new Set(allLocs));

  const matchesFromSitemap = findMatches(allLocs, patterns);

  // 3) If still nothing, open homepage and scan links
  let matchesFromHome = [];
  if (matchesFromSitemap.length === 0) {
    const page = await browser.newPage();
    matchesFromHome = await findFromHomepage(page, root, patterns);
    await page.close();
  }

  return {
    sitemap: matchesFromSitemap,
    homepage: matchesFromHome
  };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/find-blog.js <config.json|configs/sites.json>');
    console.error('Config JSON example: { "url": "https://example.com", "patterns": ["/blog","/posts"] }');
    process.exitCode = 2;
    return;
  }

  // Read JSON config file (can be an object or an array of objects)
  let rawJson;
  try {
    const raw = await fs.readFile(arg, 'utf8');
    rawJson = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read or parse config JSON:', err && err.message ? err.message : err);
    process.exitCode = 2;
    return;
  }

  const configs = Array.isArray(rawJson) ? rawJson : [rawJson];

  const api = await playwright.request.newContext();
  const browser = await playwright.chromium.launch({ headless: true });

  const allResults = [];
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i] || {};
    const inputUrl = cfg.url || cfg.site || cfg.root;
    if (!inputUrl) {
      console.error(`#${i}: missing "url" in config, skipping.`);
      continue;
    }

    const root = ensureUrl(inputUrl);
    const patterns = Array.isArray(cfg.patterns) && cfg.patterns.length ? cfg.patterns : ['/blog', '/posts'];
    const rootOnly = typeof cfg.rootOnly === 'boolean' ? cfg.rootOnly : true;
    console.log(`\n== Site ${i + 1}: ${root} ==`);
    try {
      const res = await findBlogForRoot(api, browser, root, patterns);
      const matches = (res.sitemap && res.sitemap.length) ? res.sitemap : (res.homepage && res.homepage.length ? res.homepage : []);
      const strictMatches = findMatches(matches, patterns, rootOnly);
      for (const m of strictMatches) console.log(m);
      allResults.push({ url: root, patterns, rootOnly, matches: strictMatches });
    } catch (err) {
      console.error(`#${i}: error processing site:`, err && err.message ? err.message : err);
      allResults.push({ url: root, patterns, rootOnly, error: (err && err.message) ? err.message : String(err) });
    }
  }

  await browser.close();
  await api.dispose();

  // Write results to output JSON. Priority: top-level rawJson.output, else use provided outputDir (CLI or config), else next to input file
  try {
    let outputPath = null;
    if (rawJson && rawJson.output && typeof rawJson.output === 'string') {
      outputPath = rawJson.output;
    } else {
      const inPath = process.argv[2];
      const cliOutDir = process.argv[3];
      const cfgOutDir = rawJson && rawJson.outputDir && typeof rawJson.outputDir === 'string' ? rawJson.outputDir : null;
      const base = path.basename(inPath, path.extname(inPath));
      const fileName = base + '.results.json';
      // Default to project's `outputs` directory when no outputDir is provided
      const defaultOutDir = path.resolve(process.cwd(), 'outputs');
      const outDir = cliOutDir || cfgOutDir || defaultOutDir;
      await fs.mkdir(outDir, { recursive: true });
      outputPath = path.join(outDir, fileName);
    }
    await fs.writeFile(outputPath, JSON.stringify(allResults, null, 2), 'utf8');
    console.error(`Results saved to: ${outputPath}`);
  } catch (err) {
    console.error('Failed to write results JSON:', err && err.message ? err.message : err);
  }
}

main().catch(err => {
  console.error('Error:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
