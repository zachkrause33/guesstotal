#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./lib/scraper');

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');

function scraperApiFetch(url) {
  if (!SCRAPER_API_KEY) throw new Error('SCRAPER_API_KEY not set');
  const apiUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=us`;

  return new Promise((resolve, reject) => {
    const mod = apiUrl.startsWith('https') ? https : require('http');
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

function extractPrice(html) {
  const patterns = [
    /"priceAmount"\s*:\s*"?([\d.]+)"?/,
    /class="a-price-whole">(\d+)<.*?class="a-price-fraction">(\d+)/s,
    /data-asin-price="([\d.]+)"/,
    /"lowPrice"\s*:\s*"?([\d.]+)"?/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const val = m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
      if (val > 0 && val < 10000) return val;
    }
  }
  return null;
}

function extractImage(html) {
  const patterns = [
    /"hiRes"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/,
    /id="landingImage"[^>]*src="([^"]+)"/,
    /property="og:image"[^>]*content="([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      let url = m[1].replace(/\\u002F/g, '/');
      if (url.includes('_SX') || url.includes('_SY') || url.includes('_AC_')) {
        url = url.replace(/\._[^.]+\./, '._AC_SL500_.');
      }
      return url;
    }
  }
  return null;
}

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
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

async function main() {
  if (!SCRAPER_API_KEY) {
    console.error('Error: SCRAPER_API_KEY environment variable is required.');
    console.error('Sign up free at https://www.scraperapi.com (1,000 requests/month)');
    console.error('Then run: SCRAPER_API_KEY=your_key npm run refresh-prices');
    process.exit(1);
  }

  console.log('=== Price & Image Refresh ===\n');

  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

  const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const allAsins = [];
  const asinToCategory = {};
  for (const [cat, products] of Object.entries(pool.categories)) {
    for (const p of products) {
      if (!allAsins.includes(p.asin)) {
        allAsins.push(p.asin);
        asinToCategory[p.asin] = cat;
      }
    }
  }

  const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const stale = allAsins.filter(asin => {
    const c = cache[asin];
    if (!c || !c.lastUpdated) return true;
    return (now - new Date(c.lastUpdated).getTime()) > CACHE_MAX_AGE_MS;
  });

  console.log(`Total products: ${allAsins.length}`);
  console.log(`Stale (>3 days): ${stale.length}`);
  console.log(`Fresh: ${allAsins.length - stale.length}\n`);

  if (stale.length === 0) {
    console.log('All prices are fresh!');
    return;
  }

  let updated = 0;
  let images = 0;
  let failed = 0;

  for (let i = 0; i < stale.length; i++) {
    const asin = stale[i];
    console.log(`[${i + 1}/${stale.length}] ${asin}...`);

    try {
      const html = await scraperApiFetch(`https://www.amazon.com/dp/${asin}`);
      const price = extractPrice(html);
      const imgUrl = extractImage(html);

      if (price) {
        const oldPrice = cache[asin]?.price;
        cache[asin] = { ...cache[asin], price, imgUrl, lastUpdated: new Date().toISOString() };

        for (const products of Object.values(pool.categories)) {
          for (const p of products) {
            if (p.asin === asin) p.fallbackPrice = price;
          }
        }

        const diff = oldPrice ? ` (was $${oldPrice})` : '';
        console.log(`  ✓ $${price}${diff}`);
        updated++;
      } else {
        console.log(`  ~ Page loaded but no price found`);
      }

      if (imgUrl) {
        const ext = imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
        const filepath = path.join(IMAGES_DIR, `${asin}.${ext}`);
        if (!fs.existsSync(filepath)) {
          try {
            await downloadImage(imgUrl, filepath);
            images++;
            console.log(`  ↓ Image: ${asin}.${ext}`);
          } catch {}
        }
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ ${err.message}`);
    }

    if (i < stale.length - 1) await sleep(2000);
  }

  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Prices updated: ${updated}`);
  console.log(`Images downloaded: ${images}`);
  console.log(`Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
