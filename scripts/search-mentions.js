#!/usr/bin/env node
// Visit extracted posts and search for mentions of tech companies or VC funds.
// Usage: node scripts/search-mentions.js [input] [output] [lists-json]
// - input: path to combined JSON (`outputs/extracted-posts/all_extracted_posts.json`) OR directory `outputs/extracted-posts`
// - output: path to write results JSON (default: outputs/extracted-posts/mentions_results.json)
// - lists-json: optional JSON file with { companies: [...], funds: [...] }

const fs = require('fs').promises;
const path = require('path');
const playwright = require('playwright');

function loadDefaultLists() {
  return {
    companies: [
      'Google','Microsoft','Apple','Amazon','Meta','IBM','Intel','Nvidia','Samsung','Oracle',
      'Uber','Airbnb','Stripe','Shopify','Salesforce','Tiktok','Twitter','Snapchat','Pinterest'
    ],
    funds: [
      'Sequoia','Andreessen Horowitz','a16z','Accel','Benchmark','Index Ventures','Greylock',
      'Bessemer','Kleiner Perkins','Union Square Ventures','Lightspeed','Founders Fund','GV','Insight'
    ]
  };
}

function normalizeName(n) { return (n || '').toLowerCase().replace(/\s+/g,' ').trim(); }

async function gatherInputUrls(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isDirectory()) {
    const files = await fs.readdir(inputPath);
    const urls = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await fs.readFile(path.join(inputPath, f), 'utf8'));
        if (Array.isArray(j.extracted)) {
          for (const p of j.extracted) if (p && p.url) urls.push({ url: p.url, sourceFile: f });
        } else if (Array.isArray(j.results)) {
          // handle combined format
          for (const r of j.results) {
            if (r && Array.isArray(r.extracted)) for (const p of r.extracted) if (p && p.url) urls.push({ url: p.url, sourceFile: f });
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }
    return urls;
  } else if (stat.isFile()) {
    const data = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const urls = [];
    if (Array.isArray(data.results)) {
      for (const r of data.results) if (r && Array.isArray(r.extracted)) for (const p of r.extracted) if (p && p.url) urls.push({ url: p.url, sourceFile: inputPath });
    } else if (Array.isArray(data)) {
      for (const entry of data) if (entry && Array.isArray(entry.extracted)) for (const p of entry.extracted) if (p && p.url) urls.push({ url: p.url, sourceFile: inputPath });
    } else if (Array.isArray(data.extracted)) {
      for (const p of data.extracted) if (p && p.url) urls.push({ url: p.url, sourceFile: inputPath });
    }
    return urls;
  } else {
    return [];
  }
}

function findSnippets(text, needle) {
  const snippets = [];
  const low = text.toLowerCase();
  const n = needle.toLowerCase();
  let idx = low.indexOf(n);
  while (idx !== -1) {
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + n.length + 80);
    snippets.push(text.slice(start, end).replace(/\s+/g,' '));
    idx = low.indexOf(n, idx + 1);
  }
  return snippets;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputArg = argv[0] || path.join('outputs','extracted-posts');
  const outArg = argv[1] || path.join('outputs','extracted-posts','mentions_results.json');
  const listsArg = argv[2] || null;

  let lists = loadDefaultLists();
  if (listsArg) {
    try { lists = Object.assign(lists, JSON.parse(await fs.readFile(listsArg, 'utf8'))); } catch (e) { console.error('Failed to load lists JSON, using defaults'); }
  }

  // Normalize lists
  const companies = Array.from(new Set((lists.companies || []).map(normalizeName))).filter(Boolean);
  const funds = Array.from(new Set((lists.funds || []).map(normalizeName))).filter(Boolean);

  console.error(`Using ${companies.length} companies and ${funds.length} funds to search.`);

  const urls = await gatherInputUrls(inputArg);
  console.error(`Found ${urls.length} article URLs to scan.`);

  if (!urls.length) {
    console.error('No URLs found. Ensure input points to your extracted-posts directory or combined JSON.');
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];
  for (let i=0;i<urls.length;i++) {
    const item = urls[i];
    const url = item.url;
    console.error(`[${i+1}/${urls.length}] Visiting ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // extract visible text
      const text = await page.evaluate(() => {
        const body = document.body;
        if (!body) return '';
        return (body.innerText || '').replace(/\s+/g, ' ');
      });

      const entry = { url, sourceFile: item.sourceFile || null, companies: [], funds: [] };

      const lowText = (text || '').toLowerCase();
      for (const c of companies) {
        if (lowText.includes(c)) {
          entry.companies.push({ name: c, snippets: findSnippets(text, c) });
        }
      }
      for (const f of funds) {
        if (lowText.includes(f)) {
          entry.funds.push({ name: f, snippets: findSnippets(text, f) });
        }
      }

      results.push(entry);
    } catch (e) {
      console.error('Error visiting', url, e && e.message ? e.message : e);
      results.push({ url, sourceFile: item.sourceFile || null, error: e && e.message ? e.message : String(e) });
    }
  }

  await page.close();
  await browser.close();

  // Write results
  try {
    await fs.mkdir(path.dirname(outArg), { recursive: true });
    await fs.writeFile(outArg, JSON.stringify({ generated_at: new Date().toISOString(), counts: { urls: urls.length }, results }, null, 2), 'utf8');
    console.error(`Saved mentions results to ${outArg}`);
  } catch (e) {
    console.error('Failed to write output:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
