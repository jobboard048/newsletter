#!/usr/bin/env node
// Visit recent posts, extract title/description/content, ask OpenAI to score usefulness,
// and write a ranked JSON list sorted by score.
// Usage: node scripts/rank-posts.js [recent-json-path]
// Default recent-json-path: outputs/recent-posts/recent_posts.json

const fs = require('fs').promises;
const path = require('path');
const playwright = require('playwright');
try { require('dotenv').config(); } catch (e) {}
const { OpenAI } = require('openai');
const { requestStructured } = require('./utils/ai');
const { z } = require('zod');

// Truncate long content before sending to the model to keep requests bounded.
const MAX_CONTENT_CHARS = 3000;

const rankingSchema = z.object({ score: z.number().int().min(1).max(10), summary: z.string() });

async function extractFromPage(page, url) {
  // Return { title, description, content }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    throw new Error(`Navigation failed: ${e.message}`);
  }

  // Title
  let title = '';
  try { title = (await page.title()) || ''; } catch (e) { title = ''; }

  // Meta description
  let description = '';
  try {
    description = await page.$eval('meta[name="description"]', el => el.getAttribute('content'))
      .catch(async () => {
        // try og:description
        return await page.$eval('meta[property="og:description"]', el => el.getAttribute('content')).catch(() => '');
      });
    if (!description) description = '';
  } catch (e) { description = ''; }

  // Try to extract main article content from <article> or <main>, else fallback to body text
  let content = '';
  try {
    content = await page.$eval('article', el => el.innerText).catch(async () => {
      return await page.$eval('main', el => el.innerText).catch(async () => {
        return await page.$eval('body', el => el.innerText).catch(() => '');
      });
    });
  } catch (e) {
    content = '';
  }

  // Try to extract a publish date from common locations: time[datetime], meta tags, or date-like text
  let date = null;
  try {
    // time[datetime]
    date = await page.$eval('time[datetime]', el => el.getAttribute('datetime')).catch(() => null);
    if (!date) {
      // meta published_time / article:published_time / og:published_time
      date = await page.$eval('meta[property="article:published_time"]', el => el.getAttribute('content')).catch(() => null);
    }
    if (!date) {
      date = await page.$eval('meta[property="og:published_time"]', el => el.getAttribute('content')).catch(() => null);
    }
    if (!date) {
      date = await page.$eval('meta[name="pubdate"]', el => el.getAttribute('content')).catch(() => null);
    }
    if (!date) {
      date = await page.$eval('meta[name="publish_date"]', el => el.getAttribute('content')).catch(() => null);
    }
    if (!date) {
      date = await page.$eval('meta[name="date"]', el => el.getAttribute('content')).catch(() => null);
    }
    if (!date) {
      // fallback: first <time> innerText
      date = await page.$eval('time', el => el.innerText).catch(() => null);
    }
    if (date && typeof date === 'string') {
      date = date.trim();
      const parsed = Date.parse(date);
      if (!isNaN(parsed)) {
        date = new Date(parsed).toISOString();
      }
    }
  } catch (e) {
    date = null;
  }

  // Normalize and trim
  title = (title || '').trim();
  description = (description || '').trim();
  content = (content || '').replace(/\s+/g, ' ').trim();

  return { title, description, content, date };
}

async function askAiForScore(client, post) {
  const textForModel = [
    `URL: ${post.url}`,
    `Title: ${post.title || ''}`,
    `Description: ${post.description || ''}`,
    `Content (truncated): ${post.content ? post.content.slice(0, MAX_CONTENT_CHARS) : ''}`
  ].join('\n\n');

  const instruction = `You are an expert assistant that rates how useful a blog post is for tech professionals in their daily work (engineering, devops, product, data, ML). ` +
    `Return a JSON object with two keys: "score" (integer 1-10, 10 = extremely useful) and "summary" (a short 1-2 sentence actionable insight). ` +
    `Do not return any other text. Be concise and precise.`;

  const prompt = instruction + '\n\n' + textForModel + '\n\nRespond with JSON matching the schema.';

  const res = await requestStructured(client, prompt, rankingSchema, { maxAttempts: 3, temperature: 0.2 });
  if (res && res.data) {
    return { score: res.data.score, summary: res.data.summary, raw: res.raw, usage: res.usage };
  }
  const msg = res && res.error ? `AI structured output failed: ${res.error}` : 'AI structured output failed';
  return { score: null, summary: msg, raw: res && res.raw ? res.raw : null, usage: res && res.usage ? res.usage : null };
}
async function main() {
  const recentPath = process.argv[2] || path.join('outputs','recent-posts','recent_posts.json');
  let recent;
  try {
    recent = JSON.parse(await fs.readFile(recentPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read recent posts JSON:', e && e.message ? e.message : e);
    process.exit(2);
  }

  const postsList = Array.isArray(recent.posts) ? recent.posts : [];
  if (!postsList.length) {
    console.error('No posts found in recent_posts.json');
    process.exit(0);
  }

  // Prepare OpenAI client
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Please set OPENAI_API_KEY in environment.');
    process.exit(2);
  }
  const client = new OpenAI({ apiKey });

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];
  // Aggregate token usage across AI calls
  const totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (let i = 0; i < postsList.length; i++) {
    const p = postsList[i];
    const url = p.url;
    console.error(`[${i+1}/${postsList.length}] Visiting ${url}`);
    try {
      const extracted = await extractFromPage(page, url);
      const item = {
        url,
        title: extracted.title || p.title || '',
        description: extracted.description || p.description || p.meta || '',
        content: extracted.content || '',
        // Prefer extracted date (ISO if parsed), else try common fields from input JSON
        date: extracted.date || p.date || p.pubDate || p.published || p.pub_date || null,
        // Preserve original date fields from the `recent_posts.json` input for bookkeeping
        source_date: p.date || null,
        source_detected_date: p._detected_date || null,
      };

      // Ask AI for score and summary
      const ai = await askAiForScore(client, item);
      item.ai_score = (typeof ai.score === 'number') ? Number(ai.score) : null;
      item.ai_summary = ai.summary || '';
      item.ai_raw = ai.raw || null;
      // Aggregate usage if present and show per-request token costs
      if (ai.usage) {
        const u = ai.usage;
        const inTokens = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
        const outTokens = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
        const tot = typeof u.total_tokens === 'number' ? u.total_tokens : (inTokens + outTokens);

        // Pricing env vars (per 1,000,000 tokens, USD). Accept multiple env names for convenience.
        const priceInputPer1M = Number(process.env.TOKEN_PRICE_INPUT_PER_1M || process.env.PRICE_PER_1M_INPUT || 0);
        const priceOutputPer1M = Number(process.env.TOKEN_PRICE_OUTPUT_PER_1M || process.env.PRICE_PER_1M_OUTPUT || 0);
        const costInput = priceInputPer1M ? (inTokens / 1000000) * priceInputPer1M : 0;
        const costOutput = priceOutputPer1M ? (outTokens / 1000000) * priceOutputPer1M : 0;
        const costTotal = costInput + costOutput;

        // Log per-request token usage and estimated cost
        console.error(`[AI] ${url} — tokens: input=${inTokens} output=${outTokens} total=${tot} — estimated cost: $${costTotal.toFixed(8)}`);

        // attach usage & cost to item for later inspection
        item.ai_usage = { input_tokens: inTokens, output_tokens: outTokens, total_tokens: tot, cost_input: costInput, cost_output: costOutput, cost_total: costTotal };

        totals.input_tokens += inTokens;
        totals.output_tokens += outTokens;
        totals.total_tokens += tot;
      }

      results.push(item);
    } catch (e) {
      console.error('Failed to process', url, e && e.message ? e.message : e);
      results.push({ url, title: p.title || '', description: '', content: '', ai_score: 0, ai_summary: `error: ${e && e.message ? e.message : e}` });
    }
    // small delay to be polite (and avoid rate spikes)
    await new Promise(r => setTimeout(r, 300));
  }

  await page.close();
  await browser.close();

  // Sort by ai_score desc
  results.sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));

  // Save ranked posts into a dedicated outputs/ranked-posts directory
  const rankedDir = path.resolve(process.cwd(), 'outputs', 'ranked-posts');
  await fs.mkdir(rankedDir, { recursive: true });
  const outPath = path.join(rankedDir, 'ranked_posts.json');
  try {
    const payload = { generated_at: new Date().toISOString(), source: recentPath, totals, results };
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Wrote ranked posts to ${outPath}`);
  } catch (e) {
    console.error('Failed to write output file:', e && e.message ? e.message : e);
    process.exit(1);
  }

  // Report aggregated token usage and estimated cost (if price env vars are set)
  try {
    const inputTokens = totals.input_tokens || 0;
    const outputTokens = totals.output_tokens || 0;
    const totalTokens = totals.total_tokens || (inputTokens + outputTokens);

    console.error('\n=== OpenAI token usage summary (aggregated) ===');
    console.error(`- input_tokens: ${inputTokens}`);
    console.error(`- output_tokens: ${outputTokens}`);
    console.error(`- total_tokens: ${totalTokens}`);

    // Pricing env vars (per 1,000,000 tokens, USD). Accept multiple env names for convenience.
    const priceInputPer1M = Number(process.env.TOKEN_PRICE_INPUT_PER_1M || process.env.PRICE_PER_1M_INPUT || 0);
    const priceOutputPer1M = Number(process.env.TOKEN_PRICE_OUTPUT_PER_1M || process.env.PRICE_PER_1M_OUTPUT || 0);

    if (priceInputPer1M || priceOutputPer1M) {
      const costInput = (inputTokens / 1000000) * priceInputPer1M;
      const costOutput = (outputTokens / 1000000) * priceOutputPer1M;
      const costTotal = (costInput || 0) + (costOutput || 0);
      console.error('\n=== Estimated cost (USD) ===');
      if (priceInputPer1M) console.error(`- input cost (@ ${priceInputPer1M}/1M): $${costInput.toFixed(6)}`);
      if (priceOutputPer1M) console.error(`- output cost (@ ${priceOutputPer1M}/1M): $${costOutput.toFixed(6)}`);
      console.error(`- total cost estimate: $${costTotal.toFixed(6)}`);
    } else {
      console.error('\nNo pricing env vars set. To estimate cost, set one or more of:');
      console.error('- TOKEN_PRICE_INPUT_PER_1M (USD per 1,000,000 input tokens)');
      console.error('- TOKEN_PRICE_OUTPUT_PER_1M (USD per 1,000,000 output tokens)');
    }
  } catch (e) {
    console.error('Failed to print token usage summary:', e && e.message ? e.message : e);
  }

  // Close OpenAI client if it exposes dispose (compatibility)
  if (typeof client.close === 'function') try { await client.close(); } catch (e) {}
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
