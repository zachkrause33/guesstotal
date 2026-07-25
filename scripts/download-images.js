#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { scrapeProduct, downloadImage, sleep } = require('./lib/scraper');

const POOL_PATH = path.join(__dirname, '..', 'products.pool.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const CACHE_PATH = path.join(__dirname, '..', 'public', 'scrape-cache.json');

async function main() {
  console.log('=== Image Downloader ===');
  console.log('Run this from your own computer (not a server) for best results.\n');

  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const allAsins = [];
  for (const products of Object.values(pool.categories)) {
    for (const p of products) allAsins.push(p.asin);
  }
  const uniqueAsins = [...new Set(allAsins)];

  const missing = uniqueAsins.filter(asin => {
    return !['webp', 'jpg', 'jpeg', 'png'].some(ext =>
      fs.existsSync(path.join(IMAGES_DIR, `${asin}.${ext}`))
    );
  });

  console.log(`Total products: ${uniqueAsins.length}`);
  console.log(`Already have images: ${uniqueAsins.length - missing.length}`);
  console.log(`Missing images: ${missing.length}\n`);

  if (missing.length === 0) {
    console.log('All images already downloaded!');
    return;
  }

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

  let downloaded = 0;
  let failed = 0;
  let pricesUpdated = 0;

  for (let i = 0; i < missing.length; i++) {
    const asin = missing[i];
    console.log(`[${i + 1}/${missing.length}] Scraping ${asin}...`);

    const result = await scrapeProduct(asin);

    if (result.scraped && result.imgUrl) {
      const ext = result.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
      const filepath = path.join(IMAGES_DIR, `${asin}.${ext}`);
      try {
        await downloadImage(result.imgUrl, filepath);
        downloaded++;
        console.log(`  ✓ Image saved: ${asin}.${ext}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ Image download failed: ${err.message}`);
      }
    } else {
      failed++;
      console.log(`  ✗ ${result.error || 'No image found'}`);
    }

    if (result.scraped && (result.price || result.title)) {
      cache[asin] = { ...cache[asin], ...result, lastUpdated: new Date().toISOString() };
      pricesUpdated++;
    }

    if (i < missing.length - 1) {
      const delay = 3000 + Math.floor(Math.random() * 4000);
      await sleep(delay);
    }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Downloaded: ${downloaded} images`);
  console.log(`Failed: ${failed}`);
  console.log(`Prices cached: ${pricesUpdated}`);
  console.log(`\nNext: run 'npm run generate' to rebuild bundles with new images and prices.`);
}

main().catch(err => { console.error(err); process.exit(1); });
