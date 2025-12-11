#!/usr/bin/env node
// Similar to scripts/2-extract-posts.js but use jinai.ai reader for each blog URL
// Usage: node scripts/2-extract-posts-jinai.js [output-dir]
// Requires: OPENAI_API_KEY env var and Playwright installed.

const fs = require('fs').promises;
const path = require('path');
const playwright = require('playwright');
try { require('dotenv').config(); } catch (e) {}
const { OpenAI } = require('openai');

function ensureUrl(input) { try { return new URL(input).href; } catch (e) { return new URL('http://' + input).href; } }

// Call jinai.ai reader service for a URL. Returns text (string) or null on failure.
async function callJinaiReader(url) {
  try {
    // Prefer POST to the Reader API to get structured JSON and usage metadata.
    const jinaiKey = process.env.JINAI_API_KEY || null;
    let axios = null;
    try { axios = require('axios'); } catch (e) { axios = null; }

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    if (jinaiKey) headers['Authorization'] = `Bearer ${jinaiKey}`;

    // Try POST / with JSON body { url }
    if (axios) {
      try {
        const resp = await axios.post('https://r.jina.ai/', { url }, { headers, timeout: 30000 });
        if (resp && resp.status >= 200 && resp.status < 300 && resp.data) {
          // resp.data often has shape: { code, status, data: { content, links, images }, usage: { ... } }
          const payload = resp.data;
          const dataField = payload.data || payload;
          const text = (dataField && (dataField.content || dataField.text)) ? (dataField.content || dataField.text) : (typeof payload === 'string' ? payload : JSON.stringify(payload));
          const usage = payload.usage || (dataField && dataField.usage) || null;
          return { text: text || null, usage: usage || null };
        }
      } catch (postErr) {
        // fallback to proxy GET if POST fails
      }
    }

    // If POST didn't work or axios unavailable, fallback to the simple GET proxy
    try {
      const proxyBase = 'https://r.jina.ai/https://';
      const target = url.replace(/^https?:\/\//i, '');
      const proxyUrl = proxyBase + target;
      const proxyHeaders = { 'Accept': 'text/plain, application/json' };
      if (jinaiKey) proxyHeaders['Authorization'] = `Bearer ${jinaiKey}`;
      const res = await fetch(proxyUrl, { method: 'GET', headers: proxyHeaders, cache: 'no-store' });
      if (!res.ok) return { text: null, usage: null };
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        const j = await res.json();
        const text = typeof j.text === 'string' ? j.text : (typeof j.content === 'string' ? j.content : JSON.stringify(j));
        const usage = j.usage || null;
        return { text: text || null, usage };
      }
      const txt = await res.text();
      return { text: txt || null, usage: null };
    } catch (fetchErr) {
      return { text: null, usage: null };
    }
  } catch (e) {
    return { text: null, usage: null };
  }
}

async function callGpt5NanoWithReader(client, pageUrl, readerText) {
  const MAX_CHARS = 200000;
  const truncated = readerText && readerText.length > MAX_CHARS ? readerText.slice(0, MAX_CHARS) : (readerText || '');

  const prompt = `You are given the extracted reader text for a blog listing page at ${pageUrl}. Extract up to 5 blog post entries. For each entry return an object with keys: title (string), url (absolute URL), date (ISO date string if present, otherwise null). Return ONLY a JSON array (no surrounding text). If you cannot find dates, use null. Ensure URLs are absolute when possible.`;

  const body = {
    model: 'gpt-5-nano',
    input: `${prompt}\n\nReader output:\n${truncated}`,
    service_tier: 'flex',
    reasoning: { effort: 'high' }
  };

  const r = await client.responses.create(body);
  const j = r;
  // extract text like the other script
  let text = null;
  if (Array.isArray(j.output) && j.output.length) {
    const first = j.output[0];
    if (typeof first === 'string') text = first;
    else if (first.content) {
      if (Array.isArray(first.content)) text = first.content.map(c => c.text || (typeof c === 'string' ? c : '')).join('');
      else if (first.content.text) text = first.content.text;
    } else if (first.data && first.data.text) text = first.data.text;
  }
  if (!text && typeof j.output_text === 'string') text = j.output_text;
  if (!text && j.answer) text = j.answer;
  if (!text) text = JSON.stringify(j);

  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/m);
  const jsonStr = m ? m[0] : text;
  try {
    const parsed = JSON.parse(jsonStr);
    return { posts: parsed, usage: j.usage || null, raw: text };
  } catch (e) {
    try { return { posts: JSON.parse(text), usage: j.usage || null, raw: text }; } catch (e2) { throw new Error('Failed to parse JSON from model output'); }
  }
}

async function cleanPageHtml(page) {
  return await page.evaluate(() => {
    const selectors = ['header', 'footer', 'nav', '[role="banner"]', '[role="contentinfo"]', '.site-header', '.site-footer', '.header', '.footer', '.masthead'];
    for (const s of selectors) document.querySelectorAll(s).forEach(el => el.remove());
    document.querySelectorAll('script, style, noscript').forEach(e => e.remove());
    return document.documentElement.innerHTML;
  });
}

async function main() {
  const outDirArg = process.argv[2];
  const outDir = path.join(process.cwd(), outDirArg || path.join('outputs', 'extracted-posts-jinai'));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('Please set OPENAI_API_KEY in your environment.'); process.exit(2); }
  const client = new OpenAI({ apiKey });
  const jinaiKey = process.env.JINAI_API_KEY || null;
  if (!jinaiKey) console.error('Warning: JINAI_API_KEY not set — jinai.ai reader calls may fail or be rate-limited.');

  const inPath = path.join(process.cwd(), 'outputs', 'find-blog-posts', 'find-blog-posts.json');
  let data;
  try { data = JSON.parse(await fs.readFile(inPath, 'utf8')); } catch (e) { console.error('Failed to read finder output:', e && e.message ? e.message : e); process.exit(2); }

  if (outDir) await fs.mkdir(outDir, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  const api = await playwright.request.newContext();

  const totals = {};
  // pricing env vars (per 1,000,000 tokens for OpenAI; per-request for Jinai optional)
  const priceInputPer1M = Number(process.env.TOKEN_PRICE_INPUT_PER_1M || process.env.PRICE_PER_1M_INPUT || 0);
  const priceOutputPer1M = Number(process.env.TOKEN_PRICE_OUTPUT_PER_1M || process.env.PRICE_PER_1M_OUTPUT || 0);
  const jinaiPricePerRequest = Number(process.env.JINAI_PRICE_PER_REQUEST || 0);
  if (jinaiPricePerRequest) totals.jinai_cost = (totals.jinai_cost || 0) + 0; // ensure field exists

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const matches = Array.isArray(entry.matches) ? entry.matches : [];
    if (!matches.length) continue;

    for (let j = 0; j < matches.length; j++) {
      const blogUrl = ensureUrl(matches[j]);
      console.error(`Processing (jinai): ${blogUrl}`);
      try {
        // Attempt to use jinai reader (returns { text, usage })
        const jinaiRes = await callJinaiReader(blogUrl);
        const jinaiText = jinaiRes && typeof jinaiRes.text === 'string' ? jinaiRes.text : null;
        const jinaiUsage = jinaiRes && jinaiRes.usage ? jinaiRes.usage : null;
        let readerUsed = jinaiText ? 'jinai' : 'none';
        let readerRaw = jinaiText;

        // If jinai failed to provide text, fall back to cleaned HTML via Playwright
        if (!jinaiText) {
          readerUsed = 'cleaned_html';
          const page = await browser.newPage();
          await page.goto(blogUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          readerRaw = await cleanPageHtml(page);
          await page.close();
        }

        // Measure reader output size
        const readerChars = readerRaw ? readerRaw.length : 0;
        const readerBytes = readerRaw ? Buffer.byteLength(readerRaw, 'utf8') : 0;

        // Call OpenAI with the reader output
        const result = await callGpt5NanoWithReader(client, blogUrl, readerRaw);
        const posts = result.posts;
        const usage = result.usage || null;

        // Compute OpenAI token usage and estimated cost
        let costInput = 0, costOutput = 0, costTotal = 0;
        if (usage) {
          const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0);
          const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0);
          const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
          totals.input_tokens = (totals.input_tokens || 0) + inputTokens;
          totals.output_tokens = (totals.output_tokens || 0) + outputTokens;
          if (totalTokens !== null) totals.total_tokens = (totals.total_tokens || 0) + totalTokens;
          const numericFields = Object.entries(usage).filter(([k, v]) => typeof v === 'number');
          const parts = {};
          for (const [k, v] of numericFields) {
            parts[k] = v;
            if (!['input_tokens','output_tokens','prompt_tokens','completion_tokens','total_tokens'].includes(k)) totals[k] = (totals[k] || 0) + v;
          }
          console.error('OpenAI usage details:', JSON.stringify(parts));

          // estimate cost using env pricing (per 1M tokens)
          costInput = priceInputPer1M ? (inputTokens / 1000000) * priceInputPer1M : 0;
          costOutput = priceOutputPer1M ? (outputTokens / 1000000) * priceOutputPer1M : 0;
          costTotal = costInput + costOutput;
          // attach to totals
          totals.cost_input = (totals.cost_input || 0) + costInput;
          totals.cost_output = (totals.cost_output || 0) + costOutput;
          totals.cost_total = (totals.cost_total || 0) + costTotal;
          // if jinai per-request price configured, add it
          if (jinaiPricePerRequest) {
            totals.jinai_cost = (totals.jinai_cost || 0) + jinaiPricePerRequest;
          }
        }

        // Compute jinai usage/cost if reader provided usage metadata
        let jinaiCostFromUsage = 0;
        if (jinaiUsage && typeof jinaiUsage === 'object') {
          // Detect numeric token-like fields and aggregate them into totals with `jinai_` prefix
          const jinaiNumericFields = Object.entries(jinaiUsage).filter(([k, v]) => typeof v === 'number');
          for (const [k, v] of jinaiNumericFields) {
            const key = `jinai_${k}`;
            totals[key] = (totals[key] || 0) + v;
          }

          // Prefer explicit token counts if present for cost estimation
          const jinaiTokens = Number(jinaiUsage.tokens || jinaiUsage.total_tokens || jinaiUsage.token_count || jinaiUsage.tokens_used || 0) || 0;
          const jinaiPricePer1M = Number(process.env.JINAI_PRICE_PER_1M || 0);
          if (jinaiTokens && jinaiPricePer1M) {
            jinaiCostFromUsage = (jinaiTokens / 1000000) * jinaiPricePer1M;
            totals.jinai_cost = (totals.jinai_cost || 0) + jinaiCostFromUsage;
            totals.jinai_tokens = (totals.jinai_tokens || 0) + jinaiTokens;
          }
        } else if (jinaiPricePerRequest) {
          // fallback fixed per-request price; apply when jinaiUsage missing
          totals.jinai_cost = (totals.jinai_cost || 0) + jinaiPricePerRequest;
        }

        if (outDir) {
          const base = blogUrl.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').replace(/_+$/, '');
          const outPath = path.join(outDir, `posts_jinai_${base}.json`);
          const saveObj = {
            source: blogUrl,
            reader_source: readerUsed,
            reader_raw: readerRaw ? (readerRaw.length > 20000 ? readerRaw.slice(0,20000) + '...[truncated]' : readerRaw) : null,
            reader_size_chars: readerChars,
            reader_size_bytes: readerBytes,
            extracted: posts,
            usage,
            ai_cost: { cost_input: costInput, cost_output: costOutput, cost_total: costTotal }
          };
          if (jinaiUsage) saveObj.jinai_usage = jinaiUsage;
          // include jinai cost: prefer computed per-token, else per-request fallback
          if (typeof jinaiCostFromUsage === 'number' && jinaiCostFromUsage > 0) saveObj.jinai_cost = jinaiCostFromUsage;
          else if (jinaiPricePerRequest) saveObj.jinai_cost = jinaiPricePerRequest;

          await fs.writeFile(outPath, JSON.stringify(saveObj, null, 2), 'utf8');
          console.error(`Saved extracted posts to ${outPath}`);
          // Log per-request summary: reader size and estimated cost
          const jinaiCostNote = jinaiPricePerRequest ? ` + jinai=$${jinaiPricePerRequest.toFixed(6)}` : '';
          console.error(`[AI] ${blogUrl} — reader_chars=${readerChars} reader_bytes=${readerBytes} — estimated AI cost: $${costTotal.toFixed(8)} (in=$${costInput.toFixed(8)} out=$${costOutput.toFixed(8)})${jinaiCostNote}`);
        }

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
      for (const [k, v] of Object.entries(totals)) console.error(`- ${k}: ${v}`);
      if (!grandTotalPresent) {
        const sumAll = Object.values(totals).reduce((a, b) => a + b, 0);
        console.error(`- grand_sum_of_numeric_fields: ${sumAll}`);
      }

      // If jinai totals exist, print a dedicated summary
      if (typeof totals.jinai_cost === 'number' || typeof totals.jinai_tokens === 'number') {
        console.error('\n=== Jina.ai usage summary (aggregated) ===');
        if (typeof totals.jinai_tokens === 'number') console.error(`- jinai_tokens: ${totals.jinai_tokens}`);
        if (typeof totals.jinai_cost === 'number') console.error(`- jinai_cost (estimated USD): $${totals.jinai_cost.toFixed(6)}`);
        // Also surface any other jinai_ prefixed numeric fields
        for (const [k, v] of Object.entries(totals)) {
          if (k.startsWith('jinai_') && !['jinai_cost','jinai_tokens'].includes(k)) console.error(`- ${k}: ${v}`);
        }
      }
    }
  } catch (e) { console.error('Failed to print aggregated usage summary:', e && e.message ? e.message : e); }
}

main().catch(err => { console.error('Fatal error:', err && err.message ? err.message : err); process.exit(1); });
