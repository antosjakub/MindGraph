# Local Asset Setup

This project currently uses network-loaded browser assets for full KaTeX and Marked support.

Current remote asset URLs:

- `https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css`
- `https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js`
- `https://cdn.jsdelivr.net/npm/marked/lib/marked.umd.js`

If you want full math rendering and markdown support without Wi-Fi, vendor those files into the repo and load them locally.

## Files to Download

Download these browser assets from the official projects:

- KaTeX CSS: `katex.min.css`
- KaTeX JS: `katex.min.js`
- Marked JS: `marked.umd.js`

Official references:

- KaTeX browser docs: `https://katex.org/docs/browser`
- KaTeX npm package: `https://www.npmjs.com/package/katex`
- Marked npm package: `https://www.npmjs.com/package/marked`
- Marked repo: `https://github.com/markedjs/marked`

## Suggested Repo Layout

```text
MindGraph/
  vendor/
    katex/
      katex.min.css
      katex.min.js
    marked/
      marked.umd.js
```

## Required HTML Changes

Update `index.html` so these:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
```

become:

```html
<link rel="stylesheet" href="vendor/katex/katex.min.css">
<script src="vendor/katex/katex.min.js"></script>
<script src="vendor/marked/marked.umd.js"></script>
```

Keep:

```html
<link rel="stylesheet" href="style.css">
<script src="app.js"></script>
```

## Notes

- The app already contains fallback rendering logic in `app.js`, so missing KaTeX/Marked files will not completely break the page.
- Full KaTeX-quality math typesetting requires the real KaTeX assets.
- If you switch back to local assets later, verify the script filenames match what you downloaded.
