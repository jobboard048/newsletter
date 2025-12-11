const { z } = require('zod');

function safeParseJsonFromText(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  const candidate = m ? m[0] : text;
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

async function requestStructured(client, prompt, schemaZod, opts = {}) {
  // opts: { model, temperature, maxAttempts, service_tier, reasoning }
  const model = opts.model || 'gpt-5-nano';
  const maxAttempts = opts.maxAttempts || 3;
  const service_tier = opts.service_tier || 'default';
  const reasoning = opts.reasoning || { effort: 'high' };

  function extractUsageFromResp(resp) {
    if (!resp) return null;
    // Common locations where usage may appear depending on SDK version
    const raw = resp.usage || (resp._response && resp._response.body && resp._response.body.usage) || null;

    if (raw && typeof raw === 'object') {
      const input_tokens = (typeof raw.input_tokens === 'number') ? raw.input_tokens : (typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0);
      const output_tokens = (typeof raw.output_tokens === 'number') ? raw.output_tokens : (typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0);
      const total_tokens = (typeof raw.total_tokens === 'number') ? raw.total_tokens : (input_tokens + output_tokens);
      return { input_tokens, output_tokens, total_tokens };
    }

    return null;
  }

  let pRetry = require('p-retry');
  // Some installs or bundlers expose a default property; normalize to the function.
  if (pRetry && typeof pRetry !== 'function' && typeof pRetry.default === 'function') pRetry = pRetry.default;

  class RetryableError extends Error {
    constructor(code, message, props = {}) {
      super(message);
      this.code = code;
      this.raw = props.raw || null;
      this.usage = props.usage || null;
      this.issues = props.issues || null;
    }
  }

  function shortSerialize(obj) {
    try {
      if (!obj) return null;
      // Prefer body if present
      const body = obj._response && obj._response.body ? obj._response.body : obj;
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      return s.length > 2000 ? s.slice(0, 2000) + '...[truncated]' : s;
    } catch (e) {
      return String(obj);
    }
  }

  const attemptFn = async () => {
    try {
      const resp = await client.responses.create({
        model,
        input: prompt,
        service_tier,
        reasoning
      });

      const usage = extractUsageFromResp(resp);

      // Assemble text from common response shapes
      let outText = null;
      if (resp && typeof resp.output_text === 'string' && resp.output_text.trim()) {
        outText = resp.output_text.trim();
      } else if (resp && Array.isArray(resp.output) && resp.output.length) {
        const first = resp.output[0];
        if (first && first.content && Array.isArray(first.content)) {
          outText = first.content.map(c => (c.text || (typeof c === 'string' ? c : ''))).join('\n').trim();
        } else if (typeof first === 'string') {
          outText = first;
        }
      }

      if (!outText) {
        // retryable: no output text — include a short serialized resp for debugging
        const short = shortSerialize(resp);
        throw new RetryableError('parse_failed', 'no output_text returned by model', { raw: short, usage });
      }

      const candidate = safeParseJsonFromText(outText);
      if (!candidate) {
        // retryable: couldn't parse JSON from text
        const short = shortSerialize(resp) || outText;
        throw new RetryableError('parse_failed', 'could not parse JSON from model output', { raw: short || outText, usage });
      }

      // Validate with zod schema
      const result = schemaZod.safeParse(candidate);
      if (result.success) {
        return { data: result.data, raw: outText, usage };
      }

      // validation failed: surface issues on last attempt
      throw new RetryableError('validation_failed', 'zod validation failed', { raw: outText, usage, issues: result.error.issues });
    } catch (err) {
      // If the SDK threw a non-RetryableError (network etc.), wrap as retryable to allow retries
      if (err instanceof RetryableError) throw err;
      const raw = err && err.response ? shortSerialize(err.response) : String(err);
      // Log debug info for the failed attempt
      try { console.error('[requestStructured] SDK call error:', err && err.message ? err.message : err); } catch (e) {}
      throw new RetryableError('request_failed', err && err.message ? err.message : String(err), { raw, usage: null });
    }
  };

  try {
    const res = await pRetry(attemptFn, {
      retries: Math.max(0, maxAttempts - 1),
      factor: 2,
      minTimeout: 500,
      maxTimeout: 5000,
      onFailedAttempt: err => {
        // err is the last thrown error from attemptFn
        try {
          const attempt = err.attemptNumber || err.attempts || (err && err.attempt) || '?';
          const left = err.retriesLeft != null ? err.retriesLeft : '?';
          console.error(`[requestStructured] attempt ${attempt} failed (${err.message}). ${left} retries left.`);
          // If the thrown RetryableError carried raw/usage, print a short version to help debugging
          try {
            if (err && err.raw) console.error('[requestStructured] attempt raw:', typeof err.raw === 'string' ? err.raw.slice(0,2000) : String(err.raw));
            if (err && err.usage) console.error('[requestStructured] attempt usage:', err.usage);
          } catch (e) {}
        } catch (e) {}
      }
    });
    return res;
  } catch (finalErr) {
    // p-retry throws the last error when retries exhausted
    if (finalErr instanceof RetryableError) {
      const obj = { error: finalErr.code || 'request_failed', message: finalErr.message, raw: finalErr.raw || null, usage: finalErr.usage || null };
      if (finalErr.issues) obj.issues = finalErr.issues;
      return obj;
    }
    return { error: 'request_failed', message: finalErr && finalErr.message ? finalErr.message : String(finalErr), raw: String(finalErr), usage: null };
  }
}

module.exports = { requestStructured };
