Find blog/posts URLs via sitemap (Playwright)

Overview
- `scripts/find-blog.js` is a standalone Node.js script that uses Playwright's API and a headless browser to find `/blog` or `/posts` URLs by checking the site's sitemap and, as a fallback, the homepage links.

Install
- Ensure you have Node.js (16+ recommended) and npm installed.
- From the project root, install Playwright (this will also install browser binaries):

```powershell
npm install --save-dev playwright
npx playwright install --with-deps
```

Usage
```powershell
# Provide a JSON config file path as the single argument
# Basic
node scripts/find-blog.js config.json

# Example config.json
#{
  "url": "https://example.com",
  "patterns": ["/blog", "/posts"]
}

# Example output
# Found in sitemap:
#  - https://example.com/blog
```

How it works
- Tries common sitemap locations (`/sitemap.xml`, `/sitemap_index.xml`, `.gz` variants).
- If not found, reads `robots.txt` for `Sitemap:` entries.
- Parses `<loc>` entries from sitemap XML (simple extraction).
- If sitemap search fails, opens homepage and scans anchor `href`s for `/blog` or `/posts`.

Notes
- This script uses a simple XML `<loc>` extraction (regex). For more robust XML handling use a proper XML parser like `xml2js`.
- You can add an npm script in your `package.json`, e.g.:

```json
"scripts": {
  "find-blog": "node scripts/find-blog.js"
}
```

Output

- Default directory: When you run the script without specifying an output path, results are saved into the project's `outputs/` directory (created if missing). The default filename is `<input-basename>.results.json`. Example: `configs/sites.json` -> `outputs/sites.results.json`.
- CLI override: pass an output directory as the second CLI argument. Example:

```powershell
node scripts/find-blog.js configs\sites.json outputs
```

- Config options: you can also set `output` (explicit file path) or `outputDir` (directory) in the top-level JSON config. `output` takes precedence.

- Result format: the JSON file is an array of objects with `{ url, patterns, rootOnly, matches }` or `{ url, patterns, rootOnly, error }` entries.

Security & Ethics
- Only scan sites you have permission to crawl.
- Respect `robots.txt` and site rate limits when integrating into large crawls.

**Extract Posts (OpenAI)**

- Purpose: Use `scripts/extract-posts.js` to visit the blog pages discovered by `find-blog.js`, remove common header/footer sections, and use the OpenAI Responses API (`gpt-5-nano`) to extract up to 5 blog post entries (title, url, date) from each page.
- Requirements:
  - Set an environment variable `OPENAI_API_KEY` with your API key before running the script.
  - Node 18+ is recommended (provides global `fetch`). If running older Node, install `undici` (`npm install undici`) so the script can use `fetch`.
  - Playwright must be installed and browsers available (`npm install --save-dev playwright` + `npx playwright install --with-deps`).

- Example: set API key (PowerShell) and run extractor (default reads `outputs/sites.results.json` and writes results into `outputs/`):

```powershell
$env:OPENAI_API_KEY = "sk-...your-key..."
node .\scripts\extract-posts.js
```

 - Using a `.env` file: you can store `OPENAI_API_KEY` in a `.env` file at the project root. The extractor will auto-load it if you have the `dotenv` package installed. Example `.env`:

```
OPENAI_API_KEY=sk-...your-key...
```

Install `dotenv` (optional):

```powershell
npm install dotenv --save
```

- Example: provide explicit input results file and output directory:

```powershell
node .\scripts\extract-posts.js .\outputs\sites.results.json .\outputs
```

- Output: the script writes per-site JSON files named like `posts_<site-identifier>.json` to the chosen output directory. Each file contains `{ source: <page-url>, extracted: [ { title, url, date }, ... ] }`.

- Notes:
  - The extractor truncates large pages before sending HTML to the model and attempts to parse JSON returned by the model. If the model output is not valid JSON the script will fail to parse.
  - Be mindful of API usage and cost when running the extractor over many sites.
