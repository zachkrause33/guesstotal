#!/usr/bin/env node
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./lib/scraper');

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'guesstotal-20';
const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');

const SEARCH_QUERIES = {
  tech: [
    'fun tech gadgets under 100',
    'cool desk gadgets',
    'unique tech gifts',
  ],
  outdoor: [
    'outdoor backyard games adults',
    'lawn games set',
    'beach games family',
  ],
  kitchen: [
    'fun kitchen gadgets',
    'quirky kitchen tools',
    'trending kitchen accessories',
  ],
  fitness: [
    'fitness accessories trending',
    'gym accessories under 50',
    'portable fitness gear',
  ],
  pets: [
    'fun dog toys',
    'dog accessories trending',
    'pet gadgets',
  ],
  selfcare: [
    'self care gifts',
    'spa accessories home',
    'relaxation gadgets',
  ],
  home: [
    'cool home accessories',
    'home gadgets trending',
    'LED room decor',
  ],
  party: [
    'party games adults',
    'outdoor party accessories',
    'fun party supplies',
  ],
  travel: [
    'travel accessories best sellers',
    'travel gadgets 2026',
    'airplane travel essentials',
  ],
  gaming: [
    'best party board games',
    'fun card games adults',
    'trending board games',
  ],
};

function scraperApiFetch(url) {
  if (!SCRAPER_API_KEY) throw new Error('SCRAPER_API_KEY not set');
  const apiUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=us`;

  return new Promise((resolve, reject) => {
    const mod = apiUrl.startsWith('https') ? https : http;
    const req = mod.get(apiUrl, { timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`ScraperAPI ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractSearchResults(html) {
  const products = [];
  const asinPattern = /data-asin="(B[A-Z0-9]{9})"/g;
  const seen = new Set();
  let match;

  while ((match = asinPattern.exec(html)) !== null) {
    const asin = match[1];
    if (seen.has(asin)) continue;
    seen.add(asin);

    const chunk = html.substring(Math.max(0, match.index - 2000), match.index + 3000);

    let title = null;
    const titleMatch = chunk.match(/class="a-size-[^"]*a-color-base a-text-normal"[^>]*>\s*<span[^>]*>([^<]+)/s)
      || chunk.match(/class="a-size-base-plus a-color-base a-text-normal"[^>]*>([^<]+)/)
      || chunk.match(/class="a-text-normal"[^>]*>\s*<span[^>]*>([^<]+)/s)
      || chunk.match(/alt="([^"]{15,200})"/);
    if (titleMatch) title = titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'");

    let price = null;
    const priceMatch = chunk.match(/class="a-price-whole">(\d+)<.*?class="a-price-fraction">(\d+)/s)
      || chunk.match(/\$(\d+\.\d{2})/);
    if (priceMatch) {
      price = priceMatch[2] && !priceMatch[0].includes('$')
        ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`)
        : parseFloat(priceMatch[1] || priceMatch[0].replace('$', ''));
    }

    let imgUrl = null;
    const imgMatch = chunk.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (imgMatch) {
      imgUrl = imgMatch[1].replace(/\._[^.]+\./, '._AC_SL500_.');
    }

    if (title && price && price > 5 && price < 500) {
      products.push({ asin, title, price, imgUrl });
    }
  }

  return products;
}

function extractProductPage(html, asin) {
  let price = null;
  const pricePatterns = [
    /"priceAmount"\s*:\s*"?([\d.]+)"?/,
    /class="a-price-whole">(\d+)<.*?class="a-price-fraction">(\d+)/s,
    /data-asin-price="([\d.]+)"/,
  ];
  for (const p of pricePatterns) {
    const m = html.match(p);
    if (m) {
      price = m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
      if (price > 0 && price < 10000) break;
      price = null;
    }
  }

  let title = null;
  const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/)
    || html.match(/<title>\s*(?:Amazon\.com\s*:\s*)?(.+?)(?:\s*:\s*(?:Amazon|Everything).*)?<\/title>/);
  if (titleMatch) title = titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'");

  let imgUrl = null;
  const imgMatch = html.match(/"hiRes"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/)
    || html.match(/id="landingImage"[^>]*src="([^"]+)"/)
    || html.match(/property="og:image"[^>]*content="([^"]+)"/);
  if (imgMatch) {
    imgUrl = imgMatch[1].replace(/\\u002F/g, '/');
    if (imgUrl.includes('_SX') || imgUrl.includes('_SY') || imgUrl.includes('_AC_')) {
      imgUrl = imgUrl.replace(/\._[^.]+\./, '._AC_SL500_.');
    }
  }

  return { asin, title, price, imgUrl };
}

function generateTeaser(title) {
  const words = title.split(/[\s,\-–]+/).filter(w => w.length > 2);
  const short = words.slice(0, 3).join(' ');
  return `The ${short}`;
}

function generateMeta(title, price) {
  const parts = title.split(/[,·\-–|]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 40);
  return parts.slice(0, 4).join(' · ') || title.substring(0, 60);
}

async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 15000 }, (res) => {
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

async function discoverCategory(category, queries, existingAsins) {
  const products = [];
  const seen = new Set(existingAsins);

  for (const query of queries) {
    console.log(`  Searching: "${query}"...`);
    try {
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss`;
      const html = await scraperApiFetch(url);
      const results = extractSearchResults(html);

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
    await sleep(2000);
  }

  return products;
}

async function enrichProduct(product) {
  console.log(`    Enriching ${product.asin}: ${(product.title || '').substring(0, 40)}...`);
  try {
    const url = `https://www.amazon.com/dp/${product.asin}`;
    const html = await scraperApiFetch(url);
    const data = extractProductPage(html, product.asin);

    if (data.price) product.price = data.price;
    if (data.title) product.title = data.title;
    if (data.imgUrl) product.imgUrl = data.imgUrl;

    console.log(`      ✓ $${product.price} | ${product.title?.substring(0, 40)}`);
  } catch (err) {
    console.log(`      ✗ ${err.message}`);
  }
  await sleep(2000);
}

async function main() {
  if (!SCRAPER_API_KEY) {
    console.error('Error: SCRAPER_API_KEY environment variable is required.');
    console.error('Sign up for free at https://www.scraperapi.com (1,000 free requests/month)');
    console.error('Then run: SCRAPER_API_KEY=your_key npm run discover');
    process.exit(1);
  }

  console.log('=== Product Discovery Agent ===\n');

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
    const queries = SEARCH_QUERIES[category];
    if (!queries) {
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

    const discovered = await discoverCategory(category, queries, existingAsins);

    const toAdd = discovered.slice(0, needed);

    for (const product of toAdd) {
      await enrichProduct(product);

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
      existingAsins.add(product.asin);
      pool.categories[category].push({
        asin: product.asin,
        teaser: generateTeaser(product.title || 'Mystery Item'),
        meta: generateMeta(product.title || '', product.price || 0),
        fallbackName: product.title || 'Amazon Product',
        fallbackPrice: product.price || 0,
      });
      totalNew++;
    }

    console.log(`  Added ${toAdd.length} new products to ${category}`);
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
