#!/usr/bin/env node
// Helper: extract header/footer links from one or more URLs using Playwright

const playwright = require('playwright');

function ensureUrl(input) {
  try { return new URL(input).href; } catch (e) { return new URL('http://' + input).href; }
}

// Collect all anchors inside the page <body> element (absolute http(s) URLs), deduplicated.
async function getBodyLinksFromPage(page) {
  const links = await page.$$eval('body a[href]', els => els.map(a => {
    try {
      const raw = a.getAttribute('href');
      if (!raw) return null;
      const u = new URL(raw, document.baseURI);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.href;
    } catch (e) { return null; }
  }).filter(Boolean));
  return Array.from(new Set(links));
}

// Visit one or more URLs and return deduplicated body links across them.
async function extractBodyLinks(urls) {
  const list = Array.isArray(urls) ? urls.slice() : [urls];
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const linkSet = new Set();
    for (const u of list) {
      const root = ensureUrl(u);
      try {
        const res = await page.goto(root, { waitUntil: 'networkidle', timeout: 30000 });
        if (!res || res.status() >= 400) continue;
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(200);
        const links = await getBodyLinksFromPage(page);
        links.forEach(l => linkSet.add(l));
      } catch (e) {
        // ignore per-site errors
      }
    }
    return Array.from(linkSet);
  } finally {
    await page.close();
    await browser.close();
  }
}

// Given an array of absolute URLs (or a single URL string) and the main page URL,
// return only links that are internal to the main URL (same hostname).
function getInternalLinks(links, mainUrl) {
  if (!links) return [];
  const arr = Array.isArray(links) ? links : [links];
  let host;
  try {
    host = (new URL(mainUrl)).hostname;
  } catch (e) {
    // If mainUrl is not parseable, try to prepend http://
    try { host = (new URL('http://' + mainUrl)).hostname; } catch (e2) { return []; }
  }
  const out = new Set();
  for (const l of arr) {
    try {
      const u = new URL(l);
      if (u.hostname === host) out.add(u.href);
    } catch (e) {
      // ignore invalid
    }
  }
  return Array.from(out);
}

module.exports = { extractBodyLinks, getBodyLinksFromPage, getInternalLinks, extractHeaderFooterLinks, getHeaderFooterLinksFromPage };