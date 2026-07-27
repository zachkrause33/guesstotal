#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { fetchProduct } = require('./lib/rainforest');

const RAINFOREST_API_KEY = process.env.RAINFOREST_API_KEY;
const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return downloadImage(nextUrl, filepath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ws = fs.createWriteStream(filepath);
      res.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (!RAINFOREST_API_KEY) {
    console.error('Error: RAINFOREST_API_KEY environment variable is required.');
    console.error('Sign up at https://www.rainforestapi.com');
    console.error('Then run: RAINFOREST_API_KEY=your_key npm run refresh-prices');
    process.exit(1);
  }

  console.log('=== Price & Image Refresh (Rainforest API) ===\n');

  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const allAsins = [];
  for (const products of Object.values(pool.categories)) {
    for (const p of products) {
      if (!allAsins.includes(p.asin)) allAsins.push(p.asin);
    }
  }

  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const stale = allAsins.filter(asin => {
    const c = cache[asin];
    if (!c || !c.lastUpdated) return true;
    return (now - new Date(c.lastUpdated).getTime()) > CACHE_MAX_AGE_MS;
  });

  console.log(`Total products: ${allAsins.length}`);
  console.log(`Stale (>7 days): ${stale.length}`);
  console.log(`Fresh: ${allAsins.length - stale.length}\n`);

  if (stale.length === 0) {
    console.log('All prices are fresh!');
    return;
  }

  let updated = 0;
  let images = 0;
  let failed = 0;
  let deadAsins = [];

  for (let i = 0; i < stale.length; i++) {
    const asin = stale[i];
    console.log(`[${i + 1}/${stale.length}] ${asin}...`);

    const result = await fetchProduct(asin);

    if (result.scraped && result.price) {
      const oldPrice = cache[asin]?.price;
      cache[asin] = { title: result.title, price: result.price, imgUrl: result.imgUrl, lastUpdated: new Date().toISOString() };

      for (const products of Object.values(pool.categories)) {
        for (const p of products) {
          if (p.asin === asin) p.fallbackPrice = result.price;
        }
      }

      const diff = oldPrice ? ` (was $${oldPrice})` : '';
      console.log(`  ✓ $${result.price}${diff}`);
      updated++;

      if (result.imgUrl) {
        const ext = result.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
        const filepath = path.join(IMAGES_DIR, `${asin}.${ext}`);
        if (!fs.existsSync(filepath)) {
          try {
            await downloadImage(result.imgUrl, filepath);
            images++;
            console.log(`  ↓ Image: ${asin}.${ext}`);
          } catch {}
        }
      }
    } else if (result.notFound) {
      console.log(`  ✗ Invalid/delisted ASIN: ${result.error}`);
      deadAsins.push(asin);
      failed++;
    } else {
      console.log(`  ✗ ${result.error}`);
      failed++;
    }

    if (i < stale.length - 1) await sleep(500);
  }

  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Prices updated: ${updated}`);
  console.log(`Images downloaded: ${images}`);
  console.log(`Failed: ${failed}`);
  if (deadAsins.length) {
    console.log(`\nConfirmed invalid ASINs (consider removing from products.pool.json):`);
    deadAsins.forEach(a => console.log(`  - ${a}`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
