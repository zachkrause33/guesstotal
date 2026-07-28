#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { searchProducts } = require('./lib/rainforest');

const RAINFOREST_API_KEY = process.env.RAINFOREST_API_KEY;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'guesstotal-20';
const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');

// One query per category — Rainforest's search endpoint returns 60-70
// results per query, far more than any category needs. The search
// results already include title/price/image, so no per-product
// enrichment fetch is needed (that would double the credit cost).
const SEARCH_QUERIES = {
  tech: 'fun tech gadgets under 100',
  outdoor: 'outdoor backyard games adults',
  kitchen: 'fun kitchen gadgets',
  fitness: 'fitness accessories trending',
  pets: 'fun dog toys',
  selfcare: 'self care gifts',
  home: 'cool home accessories',
  party: 'party games adults',
  travel: 'travel accessories best sellers',
  gaming: 'best party board games',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function generateTeaser(title) {
  const words = title.split(/[\s,\-–]+/).filter(w => w.length > 2);
  const short = words.slice(0, 3).join(' ');
  return `The ${short}`;
}

function generateMeta(title) {
  const parts = title.split(/[,·\-–|]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 40);
  return parts.slice(0, 4).join(' · ') || title.substring(0, 60);
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

async function discoverCategory(category, query, existingAsins) {
  const products = [];
  const seen = new Set(existingAsins);

  console.log(`  Searching: "${query}"...`);
  try {
    const results = await searchProducts(query);
    let added = 0;
    for (const r of results) {
      if (seen.has(r.asin)) continue;
      seen.add(r.asin);
      products.push(r);
      added++;
    }
    console.log(`    Found ${results.length} products, ${added} new`);
  } catch (err) {
    console.log(`    Failed: ${err.message}`);
  }

  return products;
}

async function main() {
  if (!RAINFOREST_API_KEY) {
    console.error('Error: RAINFOREST_API_KEY environment variable is required.');
    console.error('Sign up at https://www.rainforestapi.com');
    console.error('Then run: RAINFOREST_API_KEY=your_key npm run discover');
    process.exit(1);
  }

  console.log('=== Product Discovery Agent (Rainforest API) ===\n');

  let pool;
  try {
    pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  } catch {
    pool = { categories: {}, themes: [] };
  }

  const categoriesToScan = process.argv[2]
    ? process.argv[2].split(',')
    : Object.keys(SEARCH_QUERIES);

  console.log(`Categories to scan: ${categoriesToScan.join(', ')}`);
  console.log(`Partner tag: ${PARTNER_TAG}\n`);

  const existingAsins = new Set();
  for (const products of Object.values(pool.categories)) {
    for (const p of products) existingAsins.add(p.asin);
  }
  console.log(`Existing products in pool: ${existingAsins.size}\n`);

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

  let totalNew = 0;
  let totalImages = 0;
  const TARGET_PER_CATEGORY = 12;

  for (const category of categoriesToScan) {
    const query = SEARCH_QUERIES[category];
    if (!query) {
      console.log(`Unknown category: ${category}, skipping`);
      continue;
    }

    console.log(`\n── ${category.toUpperCase()} ──`);

    const currentCount = (pool.categories[category] || []).length;
    const needed = TARGET_PER_CATEGORY - currentCount;

    if (needed <= 0) {
      console.log(`  Already have ${currentCount} products, skipping`);
      continue;
    }

    console.log(`  Have ${currentCount}, want ${TARGET_PER_CATEGORY}, need ${needed} more`);

    const discovered = await discoverCategory(category, query, existingAsins);
    const toAdd = discovered.slice(0, needed);

    for (const product of toAdd) {
      if (product.imgUrl) {
        const ext = product.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
        const filepath = path.join(IMAGES_DIR, `${product.asin}.${ext}`);
        if (!fs.existsSync(filepath)) {
          try {
            await downloadImage(product.imgUrl, filepath);
            totalImages++;
            console.log(`      ↓ Image saved: ${product.asin}.${ext}`);
          } catch (err) {
            console.log(`      ↓ Image failed: ${err.message}`);
          }
        }
      }

      cache[product.asin] = {
        title: product.title,
        price: product.price,
        imgUrl: product.imgUrl,
        lastUpdated: new Date().toISOString(),
      };
    }

    if (!pool.categories[category]) pool.categories[category] = [];

    for (const product of toAdd) {
      if (!product.price) continue;
      existingAsins.add(product.asin);
      pool.categories[category].push({
        asin: product.asin,
        teaser: generateTeaser(product.title || 'Mystery Item'),
        meta: generateMeta(product.title || ''),
        fallbackName: product.title || 'Amazon Product',
        fallbackPrice: product.price,
      });
      totalNew++;
    }

    console.log(`  Added ${toAdd.length} new products to ${category}`);
    await sleep(500);
  }

  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  const totalProducts = Object.values(pool.categories).reduce((a, c) => a + c.length, 0);

  console.log(`\n=== Done ===`);
  console.log(`New products added: ${totalNew}`);
  console.log(`Images downloaded: ${totalImages}`);
  console.log(`Total products in pool: ${totalProducts}`);
  console.log(`\nAffiliate link format: https://www.amazon.com/dp/{ASIN}?tag=${PARTNER_TAG}`);
  console.log(`\nNext: run 'npm run generate' to rebuild bundles with new products.`);
}

main().catch(err => { console.error(err); process.exit(1); });
