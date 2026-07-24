#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { scrapeProducts, downloadImage, sleep } = require('./lib/scraper');

const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const CONFIG_PATH = path.join(__dirname, '..', 'bundles.config.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'bundles.json');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

const ACCESS_KEY = process.env.AMAZON_ACCESS_KEY;
const SECRET_KEY = process.env.AMAZON_SECRET_KEY;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'guesstotal-20';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── PA-API signing (used when credentials available) ──

function sha256(data) { return crypto.createHash('sha256').update(data, 'utf8').digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }

function signRequest(payload, operation) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const region = 'us-east-1', service = 'ProductAdvertisingAPI';
  const apiPath = `/paapi5/${operation.toLowerCase()}`;
  const headers = {
    'content-encoding': 'amz-1.0', 'content-type': 'application/json; charset=utf-8',
    'host': 'webservices.amazon.com', 'x-amz-date': amzDate,
    'x-amz-target': `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = ['POST', apiPath, '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + SECRET_KEY, dateStamp); k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, path: apiPath };
}

function paApiRequest(operation, body) {
  const payload = JSON.stringify(body);
  const { headers, path: apiPath } = signRequest(payload, operation);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'webservices.amazon.com', path: apiPath, method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`PA-API ${res.statusCode}: ${data}`)));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function fetchViaApi(asins) {
  const results = {};
  const batches = [];
  for (let i = 0; i < asins.length; i += 10) batches.push(asins.slice(i, i + 10));
  for (const batch of batches) {
    try {
      const r = await paApiRequest('GetItems', {
        ItemIds: batch, PartnerTag: PARTNER_TAG, PartnerType: 'Associates', Marketplace: 'www.amazon.com',
        Resources: ['Images.Primary.Large', 'Images.Primary.Medium', 'ItemInfo.Title', 'Offers.Listings.Price'],
      });
      for (const item of (r.ItemsResult?.Items || [])) {
        results[item.ASIN] = {
          title: item.ItemInfo?.Title?.DisplayValue || null,
          price: item.Offers?.Listings?.[0]?.Price?.Amount || null,
          imgUrl: item.Images?.Primary?.Large?.URL || item.Images?.Primary?.Medium?.URL || null,
        };
      }
      if (batches.length > 1) await sleep(1100);
    } catch (err) { console.error(`  PA-API batch failed: ${err.message}`); }
  }
  return results;
}

// ── Scrape cache ──

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ── Comment generation ──

function generateComments(productName, theme) {
  if (!ANTHROPIC_KEY) return null;
  const prompt = `Generate witty game-show-style comments for a price guessing game.
Product: "${productName}" | Theme: "${theme}"
Return a JSON object with keys: exact, hot, warm, cold, ice.
Each value: [emoji, SHORT_TITLE_CAPS, one_sentence_comment].
- exact: amazed at perfect guess. hot: impressed at close guess. warm: encouraging. cold: playful teasing. ice: dramatically funny.
Keep titles 1-2 words ALL CAPS. Comments should be punny and reference the product. Return ONLY valid JSON.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(JSON.parse(data).content[0].text)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function defaultComments(name) {
  const short = name.length > 30 ? name.substring(0, 30) : name;
  return {
    exact: ['👑', 'NAILED IT.', `Perfect on the ${short}! You clearly know your stuff.`],
    hot: ['🔥', 'SO CLOSE.', `Really close on the ${short}. Impressive eye for prices.`],
    warm: ['😅', 'NOT BAD.', `Decent guess on the ${short}. Getting there!`],
    cold: ['❄️', 'OFF TARGET.', `The ${short} had you guessing. Way off on that one.`],
    ice: ['💀', 'WAY OFF.', `You completely missed on the ${short}. Better luck next time.`],
  };
}

// ── Bundle selection from pool ──

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function selectBundlesFromPool(pool, count) {
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const rand = seededRandom(seed);

  const themes = pool.themes;
  const bundles = [];
  const usedProducts = new Set();

  for (let d = 0; d < count; d++) {
    const daySeed = seed + d;
    const dayRand = seededRandom(daySeed);
    const theme = themes[Math.floor(dayRand() * themes.length)];

    const candidates = [];
    for (const cat of theme.categories) {
      if (pool.categories[cat]) {
        for (const p of pool.categories[cat]) {
          if (!usedProducts.has(p.asin)) candidates.push(p);
        }
      }
    }

    // Shuffle candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(dayRand() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const selected = candidates.slice(0, 5);
    selected.forEach(p => usedProducts.add(p.asin));

    const nextTheme = themes[Math.floor(seededRandom(daySeed + 1)() * themes.length)];
    bundles.push({
      id: `${theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${daySeed}`,
      theme: theme.name,
      tagline: theme.tagline,
      emoji: theme.emoji,
      cantMiss: theme.cantMiss,
      tease: `Tomorrow: ${nextTheme.name} ${nextTheme.emoji}`,
      products: selected,
    });
  }

  return bundles;
}

// ── Main ──

async function main() {
  console.log('=== Guess Total Bundle Generator ===\n');

  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const hasApi = ACCESS_KEY && SECRET_KEY;
  const hasAnthropic = !!ANTHROPIC_KEY;

  const totalProducts = Object.values(pool.categories).reduce((a, c) => a + c.length, 0);
  console.log(`Product pool: ${totalProducts} products across ${Object.keys(pool.categories).length} categories`);
  console.log(`Themes:       ${pool.themes.length} theme templates`);
  console.log(`Amazon PA-API: ${hasApi ? 'configured' : 'not configured'}`);
  console.log(`Scraper:       ${hasApi ? 'skipped (using PA-API)' : 'active'}`);
  console.log(`Claude API:    ${hasAnthropic ? 'configured' : 'not configured (using defaults)'}\n`);

  // Generate today + tomorrow bundles from pool
  const bundles = selectBundlesFromPool(pool, 2);
  console.log(`Today:    ${bundles[0].theme} ${bundles[0].emoji}`);
  console.log(`Tomorrow: ${bundles[1].theme} ${bundles[1].emoji}\n`);

  // Also include legacy config bundles for backward compat
  let legacyBundles = [];
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    legacyBundles = config.bundles.map(b => ({
      ...b,
      products: b.products.map(p => ({
        asin: p.asin, teaser: p.teaser, meta: p.meta,
        fallbackName: p.fallbackName, fallbackPrice: p.fallbackPrice,
        fallbackImg: p.fallbackImg, comments: p.comments,
      })),
    }));
  }

  // Collect all ASINs that need data
  const allBundles = [...bundles, ...legacyBundles];
  const allAsins = [...new Set(allBundles.flatMap(b => b.products.map(p => p.asin)))];
  console.log(`Total unique ASINs to fetch: ${allAsins.length}\n`);

  // Load cache and determine which ASINs need refreshing
  const cache = loadCache();
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  const staleAsins = allAsins.filter(asin => {
    const cached = cache[asin];
    if (!cached || !cached.lastUpdated) return true;
    if (!cached.price && !cached.title) return true;
    return (now - new Date(cached.lastUpdated).getTime()) > CACHE_MAX_AGE_MS;
  });
  const freshCount = allAsins.length - staleAsins.length;
  if (freshCount > 0) console.log(`Cache: ${freshCount}/${allAsins.length} ASINs have fresh data (< 7 days old)`);

  let amazonData = {};

  // Fetch product data (only stale ASINs)
  if (staleAsins.length === 0) {
    console.log('All ASINs have fresh cached data — skipping fetch\n');
  } else if (hasApi) {
    console.log(`Fetching ${staleAsins.length} ASINs via Amazon PA-API...`);
    amazonData = await fetchViaApi(staleAsins);
    console.log(`  Got ${Object.keys(amazonData).length}/${staleAsins.length} from API\n`);
  } else {
    console.log(`Scraping ${staleAsins.length} Amazon product pages...`);
    amazonData = await scrapeProducts(staleAsins, 3000);
    console.log();
  }

  // Merge with cache and update cache
  for (const asin of allAsins) {
    const fresh = amazonData[asin];
    if (fresh && (fresh.price || fresh.title || fresh.imgUrl)) {
      cache[asin] = { ...cache[asin], ...fresh, lastUpdated: new Date().toISOString() };
    }
  }
  saveCache(cache);

  // Download images
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  let imgCount = 0;

  for (const asin of allAsins) {
    const data = cache[asin] || amazonData[asin];
    if (data?.imgUrl) {
      const ext = data.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
      const filepath = path.join(IMAGES_DIR, `${asin}.${ext}`);
      if (!fs.existsSync(filepath)) {
        try {
          await downloadImage(data.imgUrl, filepath);
          imgCount++;
          console.log(`  Downloaded image: ${asin}.${ext}`);
        } catch (err) {
          console.log(`  Image download failed for ${asin}: ${err.message}`);
        }
        await sleep(500);
      }
    }
  }
  if (imgCount > 0) console.log(`  Downloaded ${imgCount} new images\n`);

  // Build output bundles
  const output = [];

  for (const bundle of allBundles) {
    const products = [];
    for (const p of bundle.products) {
      const data = cache[p.asin] || amazonData[p.asin] || {};
      const name = data.title || p.fallbackName || p.name || 'Unknown Product';
      const price = data.price || p.fallbackPrice || p.price || 0;

      // Find local image
      let img = p.fallbackImg || p.img || null;
      const exts = ['webp', 'jpg', 'jpeg', 'png'];
      for (const ext of exts) {
        if (fs.existsSync(path.join(IMAGES_DIR, `${p.asin}.${ext}`))) {
          img = `/images/${p.asin}.${ext}`;
          break;
        }
      }

      let comments = p.comments;
      if (!comments && hasAnthropic) {
        console.log(`  Generating comments for ${name.substring(0, 40)}...`);
        comments = await generateComments(name, bundle.theme);
        await sleep(500);
      }
      if (!comments) comments = defaultComments(name);

      products.push({ name, teaser: p.teaser || '', meta: p.meta || '', price, asin: p.asin, img, comments });
    }

    output.push({
      id: bundle.id,
      theme: bundle.theme,
      tagline: bundle.tagline,
      emoji: bundle.emoji,
      tease: bundle.tease,
      products,
    });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));
  const size = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0);

  const meta = {
    generated: new Date().toISOString(),
    bundleCount: output.length,
    productCount: output.reduce((a, b) => a + b.products.length, 0),
    apiUsed: hasApi ? 'pa-api' : 'scraper',
    imagesDownloaded: imgCount,
    cacheSize: Object.keys(cache).length,
  };
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'bundles.meta.json'), JSON.stringify(meta, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Output: public/bundles.json (${size} KB)`);
  console.log(`Bundles: ${output.length} (${bundles.length} from pool + ${legacyBundles.length} legacy)`);
  console.log(`Cache: ${Object.keys(cache).length} products cached`);
}

main().catch(err => { console.error(err); process.exit(1); });
