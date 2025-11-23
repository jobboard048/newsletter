#!/usr/bin/env node
// Visit blog pages from a results JSON, clean header/footer, and ask gpt-5-nano to extract up to 5 post links (title/url/date).
// Usage: node scripts/extract-posts.js <results-json> [output-dir]
// Requires: OPENAI_API_KEY env var and Playwright installed. Node 18+ recommended for global fetch.

const fs = require('fs').promises;
const path = require('path');
const playwright = require('playwright');
// Optionally load environment variables from a .env file if `dotenv` is installed
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed; it's optional. The script will still read from process.env.
}

const { OpenAI } = require('openai');

function ensureUrl(input) {
  try { return new URL(input).href; } catch (e) { return new URL('http://' + input).href; }
}

async function cleanPageHtml(page) {
  // Remove common header/footer selectors and return cleaned HTML
  return await page.evaluate(() => {
    const selectors = ['header', 'footer', 'nav', '[role="banner"]', '[role="contentinfo"]', '.site-header', '.site-footer', '.header', '.footer', '.masthead'];
    for (const s of selectors) {
      document.querySelectorAll(s).forEach(el => el.remove());
    }
    // Also remove elements that are very small (likely utility links)
    document.querySelectorAll('script, style, noscript').forEach(e => e.remove());
    return document.documentElement.innerHTML;
  });
}

async function callGpt5Nano(client, pageUrl, cleanedHtml) {
  const MAX_CHARS = 200000; // safety limit
  const truncated = cleanedHtml.length > MAX_CHARS ? cleanedHtml.slice(0, MAX_CHARS) : cleanedHtml;

  const prompt = `You are given the cleaned HTML for a blog listing page at ${pageUrl}. Extract up to 5 blog post entries. For each entry return an object with keys: title (string), url (absolute URL), date (ISO date string if present, otherwise null). Return ONLY a JSON array (no surrounding text). If you cannot find dates, use null. Ensure URLs are absolute when possible.`;

  const body = {
    model: 'gpt-5-nano',
    input: `${prompt}\n\nHTML:\n${truncated}`
  };

  const r = await client.responses.create(body);
  const j = r;
  // Responses API shape can vary; try to extract text output safely
  let text = null;
  if (Array.isArray(j.output) && j.output.length) {
    const first = j.output[0];
    if (typeof first === 'string') text = first;
    else if (first.content) {
      if (Array.isArray(first.content)) {
        text = first.content.map(c => c.text || (typeof c === 'string' ? c : '')).join('');
      } else if (first.content.text) text = first.content.text;
    } else if (first.data && first.data.text) text = first.data.text;
  }
  if (!text && typeof j.output_text === 'string') text = j.output_text;
  if (!text && j.answer) text = j.answer;
  if (!text) text = JSON.stringify(j);

  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/m);
  let jsonStr = m ? m[0] : text;
  try {
    const parsed = JSON.parse(jsonStr);
    return { posts: parsed, usage: j.usage || null };
  } catch (e) {
    try { return { posts: JSON.parse(text), usage: j.usage || null }; } catch (e2) {
      throw new Error('Failed to parse JSON from model output');
    }
  }
}

async function main() {
  const inPath = process.argv[2] || path.join('outputs','sites.results.json');
  const outDirArg = process.argv[3];
  // Default to a dedicated extracted posts folder inside outputs
  const outDir = outDirArg || path.join(process.cwd(), 'outputs', 'extracted-posts');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Please set OPENAI_API_KEY in your environment.');
    process.exit(2);
  }

  const client = new OpenAI({ apiKey });

  let data;
  try { data = JSON.parse(await fs.readFile(inPath, 'utf8')); } catch (e) { console.error('Failed to read results JSON:', e.message); process.exit(2); }

  await fs.mkdir(outDir, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  const api = await playwright.request.newContext();

  // Aggregate usage counters across the whole run
  const totals = {};

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const root = entry.url;
    const matches = Array.isArray(entry.matches) ? entry.matches : [];
    if (!matches.length) continue;

    for (let j = 0; j < matches.length; j++) {
      const blogUrl = ensureUrl(matches[j]);
      console.error(`Processing: ${blogUrl}`);
      try {
        const page = await browser.newPage();
        await page.goto(blogUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const cleaned = await cleanPageHtml(page);
        await page.close();

        const result = await callGpt5Nano(client, blogUrl, cleaned).catch(err => { throw err; });
        const posts = result.posts;
        const usage = result.usage || null;

        if (usage) {
          // Prefer canonical fields: input_tokens/output_tokens (or prompt_tokens/completion_tokens)
          const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0);
          const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0);
          const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : null;

          // Update totals for canonical names
          totals.input_tokens = (totals.input_tokens || 0) + inputTokens;
          totals.output_tokens = (totals.output_tokens || 0) + outputTokens;
          if (totalTokens !== null) totals.total_tokens = (totals.total_tokens || 0) + totalTokens;

          // Also aggregate any other numeric usage fields for completeness
          const numericFields = Object.entries(usage).filter(([k, v]) => typeof v === 'number');
          const parts = {};
          for (const [k, v] of numericFields) {
            parts[k] = v;
            if (!['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens'].includes(k)) {
              totals[k] = (totals[k] || 0) + v;
            }
          }

          console.error('OpenAI usage details:', JSON.stringify(parts));
          console.error(`OpenAI tokens - input_tokens: ${inputTokens}, output_tokens: ${outputTokens}${totalTokens !== null ? `, total_tokens: ${totalTokens}` : ''}`);

          const sumIO = inputTokens + outputTokens;
          if (totalTokens !== null) {
            if (sumIO !== totalTokens) {
              console.error(`Note: input_tokens + output_tokens = ${sumIO} does NOT equal total_tokens = ${totalTokens}. Showing both values.`);
            }
          } else {
            console.error(`Note: total_tokens not present; input+output = ${sumIO}`);
          }
        }

        const base = blogUrl.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').replace(/_+$/, '');
        const outPath = path.join(outDir, `posts_${base}.json`);
        await fs.writeFile(outPath, JSON.stringify({ source: blogUrl, extracted: posts, usage }, null, 2), 'utf8');
        console.error(`Saved extracted posts to ${outPath}`);
      } catch (err) {
        console.error(`Error processing ${blogUrl}:`, err && err.message ? err.message : err);
      }
    }
  }

  await api.dispose();
  await browser.close();
  // Print aggregated totals
  try {
    if (Object.keys(totals).length) {
      console.error('\n=== OpenAI usage summary (aggregated) ===');
      let grandTotalPresent = typeof totals.total_tokens === 'number';
      for (const [k, v] of Object.entries(totals)) {
        console.error(`- ${k}: ${v}`);
      }
      if (!grandTotalPresent) {
        const sumAll = Object.values(totals).reduce((a, b) => a + b, 0);
        console.error(`- grand_sum_of_numeric_fields: ${sumAll}`);
      }
    }
  } catch (e) {
    console.error('Failed to print aggregated usage summary:', e && e.message ? e.message : e);
  }
}

main().catch(err => { console.error('Fatal error:', err && err.message ? err.message : err); process.exit(1); });
