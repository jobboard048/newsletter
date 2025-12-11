#!/usr/bin/env node
// Visit extracted posts and search for mentions of tech companies or VC funds.
// Usage: node scripts/search-mentions.js [input] [output] [lists-json]
// - input: path to combined JSON (`outputs/extracted-posts/all_extracted_posts.json`) OR directory `outputs/extracted-posts`
// - output: path to write results JSON (default: outputs/extracted-posts/mentions_results.json)
// - lists-json: optional JSON file with { companies: [...], funds: [...] }

const fs = require('fs').promises;
const path = require('path');
const playwright = require('playwright');
try { require('dotenv').config(); } catch (e) {}
const { OpenAI } = require('openai');
const { requestStructured } = require('./utils/ai');
const { z } = require('zod');

// Default lists removed: this script uses OpenAI exclusively for company/fund detection.

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

  if (listsArg) {
    try {
      console.error('Note: --lists-json provided but default lists are disabled; AI will be used exclusively.');
    } catch (e) {}
  }

  const urls = await gatherInputUrls(inputArg);
  console.error(`Found ${urls.length} article URLs to scan.`);

  if (!urls.length) {
    console.error('No URLs found. Ensure input points to your extracted-posts directory or combined JSON.');
    process.exit(1);
  }

  // Require OpenAI API key — this script uses the model exclusively to detect company/fund names
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required. This script uses OpenAI to detect company and fund names; default lists are disabled.');
    process.exit(2);
  }
  const client = new OpenAI({ apiKey });

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Zod schema for AI response
  const aiSchema = z.object({ companies: z.array(z.string()).optional(), funds: z.array(z.string()).optional() });

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

      // If OpenAI client is available, ask it to extract company and fund names mentioned in the article.
      if (client) {
        const prompt = `Extract all unique tech company names and VC/fund names mentioned in the following article text. ` +
          `Return a JSON object with two arrays: \"companies\" and \"funds\". Only return JSON, nothing else.\n\n` +
          `Article text:\n"""\n${text.slice(0, 20000)}\n"""\n\n` +
          `Notes: normalize names (do not include extra punctuation), include company names (products/brands owned by companies may be included), and include well-known VC funds.`;

        try {
          const aiRes = await requestStructured(client, prompt, aiSchema, { maxAttempts: 3, temperature: 0.2 });
          if (aiRes && aiRes.data) {
            const aiCompanies = Array.isArray(aiRes.data.companies) ? aiRes.data.companies : [];
            const aiFunds = Array.isArray(aiRes.data.funds) ? aiRes.data.funds : [];
            for (const c of aiCompanies) {
              const name = (c || '').trim();
              if (!name) continue;
              entry.companies.push({ name, snippets: findSnippets(text, name) });
            }
            for (const f of aiFunds) {
              const name = (f || '').trim();
              if (!name) continue;
              entry.funds.push({ name, snippets: findSnippets(text, name) });
            }
            // Optionally log AI raw output for debugging
            if (aiRes.raw) entry.ai_raw = aiRes.raw;
          } else {
            console.error('AI extraction failed or returned no data; falling back to static lists.');
            // fallback to static lists below
          }
        } catch (e) {
          console.error('AI extraction error:', e && e.message ? e.message : e);
        }
      }

      // If AI returned empty arrays, leave companies/funds empty (we do not use static lists)

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
