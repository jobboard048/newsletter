# Configs

This folder contains lightweight configuration used by the `scripts/find-blog.js` script.

Files
- `sites.json` — an array of site root URLs to scan. Example:

```
["https://cursor.com/","https://composio.dev/","https://wisprflow.ai/"]
```

- `patterns.json` — an array of path fragments to look for on each site (defaults to `["/blog","/posts"]`). Example:

```
["/blog","/posts"]
```

How the `find-blog.js` script uses these files
- Usage: `node scripts/find-blog.js <sites.json> [patterns.json] [outputDir]`
- If `patterns.json` isn't passed on the CLI, `find-blog.js` will try `configs/patterns.json`, then fall back to `['/blog','/posts']`.
- Output by default goes to `outputs/find-blog-results/<sitesBasename>.results.json`.

Examples

Default run (uses `configs/sites.json` and `configs/patterns.json`):

```powershell
node .\scripts\find-blog.js .\configs\sites.json
```

Provide explicit patterns and output directory:

```powershell
node .\scripts\find-blog.js .\configs\sites.json .\configs\patterns.json .\outputs\find-blog-results
```

Legacy formats
- The script remains backward-compatible with the older config shape (array of objects or single object). Prefer the new simple formats above for clarity.
