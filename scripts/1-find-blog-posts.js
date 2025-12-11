#!/usr/bin/env node
// Standalone Playwright script to locate /blog or /posts URLs via sitemap
// Usage: node scripts/find-blog.js https://example.com

const playwright = require('playwright');
const zlib = require('zlib');
const fs = require('fs').promises;
const path = require('path');

// Resolve repository root (one level above this `scripts` directory)
const repoRoot = path.resolve(__dirname, '..');

// Helper to turn CLI/config paths into absolute paths.
// By default, resolve relative CLI paths against the current working directory
// and config paths relative to the repo root when appropriate.
function toAbsolute(p, base = process.cwd()) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

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

// Recursively fetch sitemap URLs and return discovered page URLs.
async function fetchSitemapUrls(api, sitemapUrl, visited = new Set(), depth = 0) {
  if (!sitemapUrl || depth > 6) return [];
  try {
    const norm = (new URL(sitemapUrl)).href;
    if (visited.has(norm)) return [];
    visited.add(norm);
    const text = await fetchWithApi(api, norm).catch(() => null);
    if (!text) return [];
    const locs = extractLocsFromSitemap(text || '');
    if (!locs || !locs.length) return [];

    const pageUrls = [];
    for (const l of locs) {
      try {
        const low = l.split('?')[0].toLowerCase();
        // Strict: only recurse when the loc explicitly ends with .xml or .xml.gz
        if (low.endsWith('.xml') || low.endsWith('.xml.gz')) {
          const nested = await fetchSitemapUrls(api, l, visited, depth + 1);
          if (nested && nested.length) pageUrls.push(...nested);
        } else {
          pageUrls.push(l);
        }
      } catch (e) {
        // if URL parsing fails, treat as page URL
        pageUrls.push(l);
      }
    }
    return Array.from(new Set(pageUrls));
  } catch (e) {
    return [];
  }
}

async function findFromHomepage(page, rootUrl, patterns) {
  try {
    // Wait for network idle so client-side JS has run and links rendered
    const res = await page.goto(rootUrl, { waitUntil: 'networkidle', timeout: 30000 });
    if (!res || res.status() >= 400) return [];
    // extra guard: ensure load state and a tiny pause for dynamic content
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Resolve anchors using the DOM href (fully qualified) to capture JS-inserted links
    const absolute = await page.$$eval('a[href]', els => els.map(a => {
      try { return new URL(a.href, document.baseURI).href; } catch (e) { return null; }
    }).filter(Boolean));
    return findMatches(absolute, patterns);
  } catch (e) {
    return [];
  }
}

async function findBlogForRoot(api, browser, root, patterns) {
  // 1) Try known sitemap locations (recursively follow nested sitemaps)
  const candidates = await getSitemapCandidates(root);
  let allLocs = [];
  const visited = new Set();
  for (const c of candidates) {
    const locs = await fetchSitemapUrls(api, c, visited).catch(() => []);
    if (locs && locs.length) allLocs = allLocs.concat(locs);
  }

  // 2) Look for sitemaps in robots.txt
  if (allLocs.length === 0) {
    const robotsSitemaps = await findSitemapsFromRobots(api, root);
    for (const s of robotsSitemaps) {
      const locs = await fetchSitemapUrls(api, s, visited).catch(() => []);
      if (locs && locs.length) allLocs = allLocs.concat(locs);
    }
  }

  // clean
  allLocs = Array.from(new Set(allLocs));

  const matchesFromSitemap = findMatches(allLocs, patterns);

  // 3) Open homepage to scan links (useful for both blog links and social profiles)
  let matchesFromHome = [];
  let socials = { x: [], linkedin: [] };
  try {
    const page = await browser.newPage();
    try {
      matchesFromHome = await findFromHomepage(page, root, patterns);
      // extract social links
      const foundSocials = await getSocialsFromPage(page);
      socials = foundSocials || socials;
    } finally {
      await page.close();
    }
  } catch (e) {
    // ignore homepage errors
  }

  return {
    sitemap: matchesFromSitemap,
    homepage: matchesFromHome,
    socials
  };
}

// Extract social profile links (X/Twitter and LinkedIn) from an already-open Playwright page
async function getSocialsFromPage(page) {
  try {
    // Restrict to footer anchors only: <footer>, [role="contentinfo"], or elements with id/class containing "footer"
    const footerSelector = 'footer a[href], [role="contentinfo"] a[href], [id*="footer"] a[href], [class*="footer"] a[href]';
    const hrefs = await page.$$eval(footerSelector, els => els.map(a => a.href).filter(Boolean));

    const xCandidates = new Set();
    const linkedinCandidates = new Set();

    // Inspect footer hrefs only
    for (const h of hrefs) {
      try {
        const u = new URL(h);
        const host = (u.hostname || '').toLowerCase();
        if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) {
          // path like /handle or /i/...
          const parts = u.pathname.split('/').filter(Boolean);
          if (parts.length) {
            const handle = parts[0];
            if (handle && handle.toLowerCase() !== 'intent' && handle.toLowerCase() !== 'share') {
              const url = `${u.protocol}//${u.hostname}/${handle}`;
              xCandidates.add(url);
            }
          }
        }
        if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
          // keep full profile/company path
          const pathstr = u.pathname.replace(/\/$/, '');
          if (pathstr && (pathstr.startsWith('/in/') || pathstr.startsWith('/company/') || pathstr.startsWith('/pub/')) ) {
            linkedinCandidates.add(`${u.protocol}//${u.hostname}${pathstr}`);
          }
        }
      } catch (e) {
        // ignore
      }
    }

    return {
      x: Array.from(xCandidates),
      linkedin: Array.from(linkedinCandidates)
    };
  } catch (e) {
    return { x: [], linkedin: [] };
  }
}

async function main() {
  // Always use the repository configs/sites.json as the input list of sites
  const sitesArg = path.join(repoRoot, 'configs', 'sites.json');
  // Optional patterns file may be provided as the first CLI argument
  const patternsArg = process.argv[2] ? toAbsolute(process.argv[2]) : null;

  // Read sites file (array of URLs) or legacy config
  let sitesRaw;
  try {
    const raw = await fs.readFile(sitesArg, 'utf8');
    sitesRaw = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read or parse sites JSON:', err && err.message ? err.message : err);
    process.exitCode = 2;
    return;
  }

  // Read patterns file if provided, else try default location or use built-in defaults
  let patterns = ['/blog', '/posts'];
  if (patternsArg) {
    try {
      const pRaw = JSON.parse(await fs.readFile(patternsArg, 'utf8'));
      if (Array.isArray(pRaw) && pRaw.length) patterns = pRaw;
    } catch (e) {
      console.error('Failed to read patterns JSON, using defaults:', e && e.message ? e.message : e);
    }
    } else {
    // try configs/patterns.json next to repo
    try {
      const pPath = path.join(repoRoot, 'configs', 'patterns.json');
      const pRaw = JSON.parse(await fs.readFile(pPath, 'utf8'));
      if (Array.isArray(pRaw) && pRaw.length) patterns = pRaw;
    } catch (e) {
      // ignore, keep defaults
    }
  }

  // Normalize into configs array of objects { url, patterns }
  let configs;
  if (Array.isArray(sitesRaw) && sitesRaw.length && typeof sitesRaw[0] === 'string') {
    configs = sitesRaw.map(u => ({ url: u, patterns }));
  } else if (Array.isArray(sitesRaw) && sitesRaw.length && typeof sitesRaw[0] === 'object') {
    // legacy format: array of objects
    configs = sitesRaw.map(cfg => ({ url: cfg.url || cfg.site || cfg.root, patterns: Array.isArray(cfg.patterns) && cfg.patterns.length ? cfg.patterns : patterns, rootOnly: typeof cfg.rootOnly === 'boolean' ? cfg.rootOnly : true }));
  } else if (typeof sitesRaw === 'object' && sitesRaw !== null) {
    // single object
    const cfg = sitesRaw;
    const urls = cfg.sites || cfg.urls || cfg.list || [];
    if (Array.isArray(urls) && urls.length) {
      configs = urls.map(u => ({ url: u, patterns: cfg.patterns && cfg.patterns.length ? cfg.patterns : patterns }));
    } else {
      configs = [{ url: cfg.url || cfg.site || cfg.root, patterns: cfg.patterns || patterns, rootOnly: typeof cfg.rootOnly === 'boolean' ? cfg.rootOnly : true }];
    }
  } else {
    console.error('Unrecognized sites JSON format. Expect array of URLs or array of objects.');
    process.exitCode = 2;
    return;
  }

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
        allResults.push({ url: root, patterns, matches: strictMatches, socials: res.socials || { x: [], linkedin: [] } });
    } catch (err) {
      console.error(`#${i}: error processing site:`, err && err.message ? err.message : err);
      allResults.push({ url: root, patterns, error: (err && err.message) ? err.message : String(err) });
    }
  }

  await browser.close();
  await api.dispose();

  // Write results to output JSON. Priority: top-level rawJson.output, else use provided outputDir (CLI or config), else next to input file
  try {
    let outputPath = null;
    // allow sites JSON to specify output path for legacy configs
    if (sitesRaw && typeof sitesRaw === 'object' && sitesRaw.output && typeof sitesRaw.output === 'string') {
      outputPath = sitesRaw.output;
    } else {
      const inPath = sitesArg;
      // CLI usage: node scripts/1-find-blog-posts.js <sites.json> [patterns.json] [outputDir]
      const cliOutDir = process.argv[4] ? toAbsolute(process.argv[4]) : null;
      const cfgOutDir = (sitesRaw && sitesRaw.outputDir && typeof sitesRaw.outputDir === 'string') ? (path.isAbsolute(sitesRaw.outputDir) ? sitesRaw.outputDir : path.join(repoRoot, sitesRaw.outputDir)) : null;
      // Save results to ./outputs/find-blog-posts/find-blog-posts.json by default
      const fileName = 'find-blog-posts.json';
      const defaultOutDir = path.resolve(repoRoot, 'outputs', 'find-blog-posts');
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

main()