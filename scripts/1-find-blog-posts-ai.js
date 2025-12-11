#!/usr/bin/env node
// Function: visit a URL and return all internal links found on the page.
// Usage (CLI): node scripts/1-find-blog-posts-ai.js <url>

const playwright = require('playwright');
const OpenAI = require('openai');

// Configure OpenAI from environment at module top-level (do not read env inside functions)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
const OPENAI_CLIENT = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function ensureUrl(input) {
  try { return new URL(input).href; } catch (_) { return new URL('http://' + input).href; }
}

// scrapeInternalLinks(url: string) => Promise<string[]>
// - Navigates to the URL using Playwright Chromium
// - Scrapes all <a href> inside <body>
// - Normalizes to absolute http(s) URLs, strips hash
// - Filters to same-origin (internal) links
// - Returns a unique list of URLs
async function scrapeInternalLinks(url) {
  const root = ensureUrl(url);
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const res = await page.goto(root, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || res.status() >= 400) return [];
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForTimeout(200);

    const absoluteLinks = await page.$$eval('body a[href]', els => {
      const out = [];
      const base = document.baseURI;
      for (const a of els) {
        try {
          const raw = a.getAttribute('href');
          if (!raw) continue;
          const u = new URL(raw, base);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          u.hash = '';
          out.push(u.href);
        } catch (_) { /* ignore */ }
      }
      return out;
    });

    const uniqueAbs = Array.from(new Set(absoluteLinks));
    const host = new URL(root).hostname;
    const internal = uniqueAbs.filter(href => {
      try { return new URL(href).hostname === host; } catch (_) { return false; }
    });
    return internal;
  } finally {
    await page.close().catch(() => { });
    await browser.close().catch(() => { });
  }
}

// selectContentUrls(urls: string[]) => Promise<string[]>
// Uses OpenAI model "gpt-5-nano" to classify which URLs correspond to
// blog, news, changelog, or events pages. Requires OPENAI_API_KEY.
async function selectContentUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  // Use the top-level OpenAI client if available; do not read env here
  if (!OPENAI_CLIENT) {
    // Fallback heuristic if no API key provided
    const keywords = ['blog', 'news', 'changelog', 'release', 'releases', 'events'];
    const keep = new Set();
    for (const u of urls) {
      const low = String(u).toLowerCase();
      if (keywords.some(k => low.includes('/' + k) || low.endsWith('/' + k) || low.includes(k + '/'))) {
        keep.add(u);
      }
    }
    return Array.from(keep);
  }

  const client = OPENAI_CLIENT;
  const system = "You are an assistant that selects URLs that represent a company's blog, news, changelog, or events pages. Return ONLY a JSON array of URLs.";
  const user = `Given these URLs, return only those that are the company website's root blog, news, changelog, or events pages. For instance, return example.com/changelog but not example.com/changelog/abc. If none match, return an empty array.\n\nURLs:\n${urls.join('\n')}`;
  try {
    if (typeof client.responses?.create === 'function') {
      const resp = await client.responses.create({
        model: OPENAI_MODEL,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      });
      const text = resp?.output_text || '';
      const jsonStart = text.indexOf('[');
      const jsonEnd = text.lastIndexOf(']');
      const slice = jsonStart !== -1 && jsonEnd !== -1 ? text.slice(jsonStart, jsonEnd + 1) : '[]';
      const result = JSON.parse(slice);
      return Array.isArray(result) ? result : [];
    }
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0
    });
    const text = completion?.choices?.[0]?.message?.content || '[]';
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    const slice = jsonStart !== -1 && jsonEnd !== -1 ? text.slice(jsonStart, jsonEnd + 1) : '[]';
    const result = JSON.parse(slice);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    const keywords = ['blog', 'news', 'changelog', 'release', 'releases', 'events'];
    const keep = new Set();
    for (const u of urls) {
      const low = String(u).toLowerCase();
      if (keywords.some(k => low.includes('/' + k) || low.endsWith('/' + k) || low.includes(k + '/'))) {
        keep.add(u);
      }
    }
    return Array.from(keep);
  }
}

// truncateToFirstDirectory(urls: string[]) => string[]
// For each URL, keep only the origin and the first path segment (if any),
// normalize trailing slash, and return unique results.
function truncateToFirstDirectory(urls) {
  const out = new Set();
  for (const raw of urls || []) {
    try {
      const u = new URL(raw);
      const segments = (u.pathname || '/').split('/').filter(Boolean);
      const path = segments.length ? `/${segments[0]}/` : '/';
      out.add(u.origin + path);
    } catch (e) {
      // ignore invalid URLs
    }
  }
  return Array.from(out);
}

function getSmallestDenominatorUrls(urls) {
  // Remove duplicates first
  const uniqueUrls = Array.from(new Set(urls));

  // Sort URLs to make comparison easier
  uniqueUrls.sort();

  const result = [];

  for (let i = 0; i < uniqueUrls.length; i++) {
    let url = uniqueUrls[i];
    let isSubPath = false;

    for (let j = 0; j < uniqueUrls.length; j++) {
      if (i === j) continue;

      // If another URL starts with this URL + "/", then this URL is a parent
      if (uniqueUrls[j].startsWith(url + '/')) {
        isSubPath = true;
        break;
      }
    }

    // Only include if it's a "smallest denominator" (not a subpath of another)
    if (!isSubPath) {
      // Check if any existing result is a subpath of this URL
      for (let k = result.length - 1; k >= 0; k--) {
        if (url.startsWith(result[k] + '/')) {
          result.splice(k, 1); // remove the parent, keep the smaller one
        }
      }

      result.push(url);
    }
  }

  return result;
}



(async () => {
  // const urls = await scrapeInternalLinks('https://connectly.ai');
  const urls = await scrapeInternalLinks('https://withtandem.com');
  console.log(urls);
  const truncated = await truncateToFirstDirectory(urls);
  const selected = await selectContentUrls(truncated);
  console.log(selected);
  // const smallestDenominatorUrls = getSmallestDenominatorUrls(selected);
  // console.log(smallestDenominatorUrls);
})();
