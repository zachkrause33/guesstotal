const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

async function scrapeProductPage(page, asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500 + Math.random() * 1500);

    const data = await page.evaluate(() => {
      let price = null;
      const priceWhole = document.querySelector('.a-price-whole');
      const priceFraction = document.querySelector('.a-price-fraction');
      if (priceWhole && priceFraction) {
        price = parseFloat(`${priceWhole.textContent.replace(/[^0-9]/g, '')}.${priceFraction.textContent.replace(/[^0-9]/g, '')}`);
      }
      if (!price) {
        const priceEl = document.querySelector('[data-asin-price]');
        if (priceEl) price = parseFloat(priceEl.getAttribute('data-asin-price'));
      }
      if (!price) {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
          try {
            const j = JSON.parse(s.textContent);
            if (j.offers?.price) { price = parseFloat(j.offers.price); break; }
            if (j.offers?.lowPrice) { price = parseFloat(j.offers.lowPrice); break; }
          } catch {}
        }
      }
      if (!price) {
        const match = document.body.innerHTML.match(/"priceAmount"\s*:\s*"?([\d.]+)"?/);
        if (match) price = parseFloat(match[1]);
      }

      let title = null;
      const titleEl = document.getElementById('productTitle');
      if (titleEl) title = titleEl.textContent.trim();
      if (!title) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) title = ogTitle.content;
      }

      let imgUrl = null;
      const landingImg = document.getElementById('landingImage');
      if (landingImg) imgUrl = landingImg.src;
      if (!imgUrl) {
        const imgFront = document.getElementById('imgBlkFront');
        if (imgFront) imgUrl = imgFront.src;
      }
      if (!imgUrl) {
        const ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg) imgUrl = ogImg.content;
      }
      if (!imgUrl) {
        const match = document.body.innerHTML.match(/"hiRes"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/);
        if (match) imgUrl = match[1].replace(/\\u002F/g, '/');
      }

      return { price, title, imgUrl };
    });

    if (data.imgUrl && (data.imgUrl.includes('_SX') || data.imgUrl.includes('_SY') || data.imgUrl.includes('_AC_'))) {
      data.imgUrl = data.imgUrl.replace(/\._[^.]+\./, '._AC_SL500_.');
    }

    return { asin, ...data, scraped: true };
  } catch (err) {
    return { asin, title: null, price: null, imgUrl: null, scraped: false, error: err.message };
  }
}

async function scrapeProducts(asins, imagesDir) {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  const results = {};
  let successCount = 0;

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    console.log(`  [browser] Scraping ${asin} (${i + 1}/${asins.length})...`);

    results[asin] = await scrapeProductPage(page, asin);
    const r = results[asin];

    if (r.scraped && (r.price || r.title)) {
      successCount++;
      console.log(`    ✓ ${r.title ? r.title.substring(0, 50) : 'no title'}... $${r.price || '?'}`);

      if (r.imgUrl && imagesDir) {
        const ext = r.imgUrl.match(/\.(jpg|png|webp|jpeg)/i)?.[1] || 'jpg';
        const filepath = path.join(imagesDir, `${asin}.${ext}`);
        if (!fs.existsSync(filepath)) {
          try {
            const imgPage = await context.newPage();
            const response = await imgPage.goto(r.imgUrl, { timeout: 15000 });
            if (response && response.ok()) {
              const buffer = await response.body();
              fs.writeFileSync(filepath, buffer);
              console.log(`    ↓ Downloaded image: ${asin}.${ext}`);
            }
            await imgPage.close();
          } catch (err) {
            console.log(`    ↓ Image download failed: ${err.message}`);
          }
        }
      }
    } else if (r.scraped) {
      console.log(`    ~ Page loaded but no data extracted`);
    } else {
      console.log(`    ✗ Failed: ${r.error}`);
    }

    if (successCount === 0 && i >= 4) {
      console.log(`\n  First ${i + 1} scrapes all failed — Amazon is blocking. Stopping browser scraper.`);
      break;
    }

    if (i < asins.length - 1) {
      await page.waitForTimeout(2000 + Math.random() * 3000);
    }
  }

  await browser.close();
  console.log(`  Browser scrape results: ${successCount}/${Object.keys(results).length} successful`);
  return results;
}

module.exports = { scrapeProducts };
