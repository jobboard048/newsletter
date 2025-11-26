#!/usr/bin/env node
// Validate configs/sites.json and configs/patterns.json
// Usage: node scripts/validate-sites.js [sites.json] [patterns.json]

const fs = require('fs').promises;
const path = require('path');

function isValidUrl(u) {
  try { new URL(u); return true; } catch (e) { return false; }
}

async function main() {
  const sitesPath = process.argv[2] || path.join('configs','sites.json');
  const patternsPath = process.argv[3] || path.join('configs','patterns.json');

  let sites;
  try { sites = JSON.parse(await fs.readFile(sitesPath, 'utf8')); } catch (e) { console.error('Failed to read sites JSON:', e.message || e); process.exit(2); }
  let patterns;
  try { patterns = JSON.parse(await fs.readFile(patternsPath, 'utf8')); } catch (e) { console.error('Failed to read patterns JSON:', e.message || e); process.exit(2); }

  // Validate sites
  if (!Array.isArray(sites) || sites.length === 0) {
    console.error('sites.json must be a non-empty array of URLs.');
    process.exit(2);
  }
  const invalid = sites.filter(s => typeof s !== 'string' || !isValidUrl(s.trim()));
  if (invalid.length) {
    console.error('Invalid URLs in sites.json:');
    for (const i of invalid) console.error(' -', JSON.stringify(i));
    process.exit(2);
  }

  // Validate patterns
  if (!Array.isArray(patterns) || patterns.length === 0) {
    console.error('patterns.json must be a non-empty array of strings.');
    process.exit(2);
  }
  const badPatterns = patterns.filter(p => typeof p !== 'string' || p.trim().length === 0);
  if (badPatterns.length) {
    console.error('Invalid entries in patterns.json:');
    for (const p of badPatterns) console.error(' -', JSON.stringify(p));
    process.exit(2);
  }

  console.log('Sites and patterns look good.');
  console.log(`- sites: ${sites.length}`);
  console.log(`- patterns: ${patterns.length}`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
