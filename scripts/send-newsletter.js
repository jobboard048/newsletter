#!/usr/bin/env node
// Send an HTML newsletter file using Resend (https://resend.com)
// Usage: node scripts/send-newsletter.js <html-path> --to you@example.com --from you@yourdomain.com [--subject "..."]

const fs = require('fs').promises;
const path = require('path');

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.error('Usage: node scripts/send-newsletter.js <html-path> --to you@example.com --from you@yourdomain.com [--subject "..."]');
    process.exit(2);
  }

  const htmlPath = argv[0];
  const args = argv.slice(1);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to') opts.to = args[++i];
    if (args[i] === '--from') opts.from = args[++i];
    if (args[i] === '--subject') opts.subject = args[++i];
  }

  if (!opts.to || !opts.from) {
    console.error('Please provide --to and --from');
    process.exit(2);
  }

  let html;
  try { html = await fs.readFile(htmlPath, 'utf8'); } catch (e) { console.error('Failed to read HTML file:', e && e.message ? e.message : e); process.exit(2); }

  // plain-text fallback: strip tags naively
  const text = html.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').slice(0, 2000);

  // Use Resend SDK
  let Resend;
  try {
    Resend = require('resend');
  } catch (e) {
    console.error('Please install the `resend` package (npm install resend)');
    process.exit(1);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Please set RESEND_API_KEY in your environment.');
    process.exit(2);
  }

  const resend = new Resend(apiKey);

  try {
    const sendResult = await resend.emails.send({
      from: opts.from,
      to: opts.to,
      subject: opts.subject || `Newsletter — ${new Date().toISOString().slice(0,10)}`,
      html,
      text,
    });
    console.log('Sent:', sendResult);
  } catch (e) {
    console.error('Failed to send via Resend:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
