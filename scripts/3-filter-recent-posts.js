#!/usr/bin/env node
// Filter extracted posts to those published within a given window (default 24 hours)
// Usage: node scripts/filter-recent-posts.js [input] [output] [hours]
// - input: path to directory `outputs/extracted-posts` or combined JSON file
// - output: path to write results JSON (default: outputs/recent-posts/recent_posts.json)
// - hours: lookback window in hours (default: 24)

const fs = require('fs').promises;
const path = require('path');

function parseDateString(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  if (typeof s === 'number') {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const tryParse = Date.parse(s);
  if (!isNaN(tryParse)) return new Date(tryParse);
  return null;
}

function extractDateFromPost(p) {
  if (!p || typeof p !== 'object') return null;
  const keys = ['date','published','published_at','publishedAt','published_date','iso_date','date_published','created_at','datetime'];
  for (const k of keys) {
    if (p[k]) {
      const d = parseDateString(p[k]);
      if (d) return d;
    }
  }
  if (p.meta && p.meta.date) {
    const d = parseDateString(p.meta.date);
    if (d) return d;
  }
  if (p.jsonld && p.jsonld.datePublished) {
    const d = parseDateString(p.jsonld.datePublished);
    if (d) return d;
  }
  return null;
}

async function gatherPosts(inputPath) {
  const stat = await fs.stat(inputPath);
  const posts = [];
  if (stat.isDirectory()) {
    const files = await fs.readdir(inputPath);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(inputPath, f), 'utf8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item && Array.isArray(item.extracted)) for (const p of item.extracted) posts.push(Object.assign({ _sourceFile: f }, p));
            else if (item && item.url) posts.push(Object.assign({ _sourceFile: f }, item));
          }
        } else if (Array.isArray(data.extracted)) {
          for (const p of data.extracted) posts.push(Object.assign({ _sourceFile: f }, p));
        } else if (Array.isArray(data.results)) {
          for (const r of data.results) if (r && Array.isArray(r.extracted)) for (const p of r.extracted) posts.push(Object.assign({ _sourceFile: f }, p));
        } else if (data && data.url) {
          posts.push(Object.assign({ _sourceFile: f }, data));
        }
      } catch (e) {
      }
    }
  } else if (stat.isFile()) {
    const data = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && Array.isArray(item.extracted)) for (const p of item.extracted) posts.push(p);
        else if (item && item.url) posts.push(item);
      }
    } else if (Array.isArray(data.extracted)) {
      for (const p of data.extracted) posts.push(p);
    } else if (Array.isArray(data.results)) {
      for (const r of data.results) if (r && Array.isArray(r.extracted)) for (const p of r.extracted) posts.push(p);
    } else if (data && data.url) {
      posts.push(data);
    }
  }
  return posts;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputArg = argv[0] || path.join('outputs','extracted-posts');
  const outArg = argv[1] || path.join('outputs','recent-posts','recent_posts.json');
  const hours = Number(argv[2] || 1000);

  let posts = [];
  try {
    posts = await gatherPosts(inputArg);
  } catch (e) {
    console.error('Failed to read input:', e && e.message ? e.message : e);
    process.exit(1);
  }

  const now = Date.now();
  const windowMs = Math.max(0, hours) * 60 * 60 * 1000;
  const cutoff = now - windowMs;

  const recent = [];
  for (const p of posts) {
    const d = extractDateFromPost(p);
    if (!d) continue;
    if (d.getTime() >= cutoff) {
      recent.push(Object.assign({ _detected_date: d.toISOString() }, p));
    }
  }

  try {
    await fs.mkdir(path.dirname(outArg), { recursive: true });
    const out = { generated_at: new Date().toISOString(), window_hours: hours, count: recent.length, posts: recent };
    await fs.writeFile(outArg, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
    console.error(`Wrote ${recent.length} recent posts to ${outArg}`);
  } catch (e) {
    console.error('Failed to write output:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
