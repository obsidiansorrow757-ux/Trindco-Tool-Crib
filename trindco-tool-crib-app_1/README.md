# Trindco Tool Crib

CNC tooling inventory: serial #s, cabinet bins, machines T-3 / T-2 / T-1 / T-0, re-order points.
Installable on phones and PCs, and every device shares one live inventory.

## Files
- `index.html`: the whole app
- `netlify/functions/inventory.mjs`: shared live inventory (stored in Netlify Blobs)
- `sw.js`, `manifest.webmanifest`, `icons/`: install + offline support
- `html5-qrcode.min.js`: camera barcode scanning (Apache-2.0, see html5-qrcode-LICENSE.txt)

## Deploy (GitHub + Netlify)
1. Upload everything in this folder to the GitHub repo, with `index.html` at the top level.
2. In Netlify: Projects → Add new project → Import an existing project → GitHub → pick the repo.
   Build command: (empty). Publish directory: `.` (netlify.toml already sets this).
3. Optional PIN: Netlify → Project configuration → Environment variables → add `SHOP_PIN`.
