#!/usr/bin/env node
// Generate an HTML/plain-text newsletter from outputs/ranked-posts/ranked_posts.json
// Usage: node scripts/generate-newsletter.js [count] [out-dir]

const fs = require('fs').promises;
const path = require('path');
const Handlebars = require('handlebars');

async function main() {
  const count = Number(process.argv[2]) || 5;
  const outDir = process.argv[3] || path.join('outputs','newsletters');

  const rankedPath = path.join('outputs','ranked-posts','ranked_posts.json');
  let ranked;
  try { ranked = JSON.parse(await fs.readFile(rankedPath, 'utf8')); } catch (e) {
    console.error('Failed to read ranked_posts.json:', e && e.message ? e.message : e);
    process.exit(2);
  }

  const posts = Array.isArray(ranked.results) ? ranked.results.slice(0, count) : [];
  if (!posts.length) {
    console.error('No posts found in ranked_posts.json');
    process.exit(0);
  }

  // Load template
  const templatePath = path.join('templates','newsletter.hbs');
  let tplSrc;
  try { tplSrc = await fs.readFile(templatePath, 'utf8'); } catch (e) {
    console.error('Failed to read template:', e && e.message ? e.message : e);
    process.exit(2);
  }
  const tpl = Handlebars.compile(tplSrc);

  const subject = `Top ${posts.length} reads — ${new Date().toISOString().slice(0,10)}`;
  const intro = `Curated highlights from the week: ${posts.length} useful posts for engineers.`;

  const html = tpl({ subject, intro, posts });

  // Plain text: simple fallback
  const textLines = [];
  textLines.push(subject);
  textLines.push('');
  textLines.push(intro);
  textLines.push('');
  posts.forEach((p, idx) => {
    textLines.push(`${idx+1}. ${p.title}`);
    if (p.source_date) textLines.push(`   Date: ${p.source_date}`);
    if (p.ai_summary) textLines.push(`   ${p.ai_summary}`);
    textLines.push(`   ${p.url}`);
    textLines.push('');
  });
  textLines.push('---');
  textLines.push('Manage your subscription preferences in your account.');

  const text = textLines.join('\n');

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const htmlPath = path.join(outDir, `newsletter_${stamp}.html`);
  const txtPath = path.join(outDir, `newsletter_${stamp}.txt`);
  const metaPath = path.join(outDir, `newsletter_${stamp}.json`);

  await fs.writeFile(htmlPath, html, 'utf8');
  await fs.writeFile(txtPath, text, 'utf8');
  await fs.writeFile(metaPath, JSON.stringify({ generated_at: new Date().toISOString(), subject, count: posts.length, source: rankedPath }, null, 2), 'utf8');

  console.log('Wrote:', htmlPath);
  console.log('Wrote:', txtPath);
  console.log('Wrote:', metaPath);
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
