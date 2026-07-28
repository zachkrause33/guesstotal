#!/usr/bin/env node
// Refreshes prices and images for all hand-curated scheduled products
// via Rainforest API. Respects the same 7-day cache window as refresh-prices.js.
// Run daily alongside generate-bundles.js in GitHub Actions.

const fs = require('fs');
const path = require('path');

const SCHEDULE_PATH = path.join(__dirname, '..', 'public', 'schedule.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function downloadImage(url, filepath) {
  const https = require('https');
  const http = require('http');
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    lib.get(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(filepath); } catch {}
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      try { fs.unlinkSync(filepath); } catch {}
      reject(err);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Schedule Price Refresh ===\n');

  if (!process.env.RAINFOREST_API_KEY) {
    console.log('No RAINFOREST_API_KEY — skipping');
    return;
  }

  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const { fetchProduct } = require('./lib/rainforest');

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const now = Date.now();
  let updated = 0, skipped = 0, failed = 0;
  const seen = new Set();

  for (const [themeKey, theme] of Object.entries(schedule.themes)) {
    for (const p of theme.products) {
      if (seen.has(p.asin)) continue;
      seen.add(p.asin);

      const age = p.lastRefreshed ? now - new Date(p.lastRefreshed).getTime() : Infinity;
      if (age < CACHE_MAX_AGE_MS) {
        skipped++;
        continue;
      }

      process.stdout.write(`  ${p.asin}  ${p.name.substring(0, 38)}... `);
      const r = await fetchProduct(p.asin);

      if (r.scraped && r.price) {
        p.price = r.price;
        if (r.title) p.name = r.title;
        p.lastRefreshed = new Date().toISOString();

        if (r.imgUrl) {
          const ext = r.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
          const imgPath = path.join(IMAGES_DIR, `${p.asin}.${ext}`);
          if (!fs.existsSync(imgPath)) {
            try {
              await downloadImage(r.imgUrl, imgPath);
              p.img = `/images/${p.asin}.${ext}`;
            } catch {
              p.img = r.imgUrl;
            }
          } else {
            p.img = `/images/${p.asin}.${ext}`;
          }
        }

        console.log(`✓ $${r.price}`);
        updated++;
      } else {
        console.log(`✗ ${r.error || 'no data'}`);
        failed++;
      }

      await sleep(500);
    }
  }

  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2));
  console.log(`\nDone: ${updated} updated, ${skipped} fresh (skipped), ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
