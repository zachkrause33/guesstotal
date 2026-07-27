#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const { scrapeProducts: httpScrape, downloadImage, sleep } = require('./lib/scraper');

let browserScrape;
try {
  browserScrape = require('./lib/browser-scraper').scrapeProducts;
} catch { browserScrape = null; }

const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const CONFIG_PATH = path.join(__dirname, '..', 'bundles.config.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'bundles.json');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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
  const hasAnthropic = !!ANTHROPIC_KEY;

  const totalProducts = Object.values(pool.categories).reduce((a, c) => a + c.length, 0);
  console.log(`Product pool: ${totalProducts} products across ${Object.keys(pool.categories).length} categories`);
  console.log(`Themes:       ${pool.themes.length} theme templates`);
  console.log(`Browser scraper: ${browserScrape ? 'available' : 'not available (install playwright-core)'}`);
  console.log(`Claude API:    ${hasAnthropic ? 'configured' : 'not configured (using defaults)'}\n`);

  const bundles = selectBundlesFromPool(pool, 2);
  console.log(`Today:    ${bundles[0].theme} ${bundles[0].emoji}`);
  console.log(`Tomorrow: ${bundles[1].theme} ${bundles[1].emoji}\n`);

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

  const allBundles = [...bundles, ...legacyBundles];
  const allAsins = [...new Set(allBundles.flatMap(b => b.products.map(p => p.asin)))];
  console.log(`Total unique ASINs: ${allAsins.length}\n`);

  const cache = loadCache();
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

  if (staleAsins.length === 0) {
    console.log('All ASINs have fresh cached data — skipping fetch\n');
  } else if (process.env.RAINFOREST_API_KEY) {
    console.log(`Fetching ${staleAsins.length} ASINs via Rainforest API...`);
    const { fetchProduct } = require('./lib/rainforest');
    for (const asin of staleAsins) {
      const r = await fetchProduct(asin);
      amazonData[asin] = { title: r.title, price: r.price, imgUrl: r.imgUrl, scraped: r.scraped };
      console.log(r.scraped && r.price ? `  ✓ ${asin} $${r.price}` : `  ✗ ${asin} ${r.error || 'no data'}`);
      await sleep(500);
    }
    console.log();
  } else if (browserScrape) {
    console.log(`Scraping ${staleAsins.length} ASINs via headless browser...`);
    amazonData = await browserScrape(staleAsins, IMAGES_DIR);
    const scraped = Object.values(amazonData).filter(d => d.scraped && (d.price || d.title)).length;
    if (scraped === 0) {
      console.log('Browser scraper got no data — trying HTTP scraper as fallback...');
      amazonData = await httpScrape(staleAsins, 3000);
    }
    console.log();
  } else {
    console.log(`Scraping ${staleAsins.length} ASINs via HTTP...`);
    amazonData = await httpScrape(staleAsins, 3000);
    console.log();
  }

  for (const asin of allAsins) {
    const fresh = amazonData[asin];
    if (fresh && (fresh.price || fresh.title || fresh.imgUrl)) {
      cache[asin] = { ...cache[asin], ...fresh, lastUpdated: new Date().toISOString() };
    }
  }
  saveCache(cache);

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

  const output = [];

  for (const bundle of allBundles) {
    const products = [];
    for (const p of bundle.products) {
      const data = cache[p.asin] || amazonData[p.asin] || {};
      const name = data.title || p.fallbackName || p.name || 'Unknown Product';
      const price = data.price || p.fallbackPrice || p.price || 0;

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
    scrapeMethod: browserScrape ? 'browser' : 'http',
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
