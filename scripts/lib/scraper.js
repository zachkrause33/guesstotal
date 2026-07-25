const https = require('https');
const http = require('http');

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchPage(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const ua = randomUA();
    const req = mod.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'DNT': '1',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        return fetchPage(res.headers.location, attempt).then(resolve).catch(reject);
      }
      if (res.statusCode === 503 && attempt < 2) {
        const delay = (attempt + 1) * 3000;
        return sleep(delay).then(() => fetchPage(url, attempt + 1)).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
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
    /class="a-price-whole">(\d+)<.*?class="a-price-fraction">(\d+)</s,
    /\$(\d+\.\d{2})<\/span>\s*<\/span>\s*<\/div>\s*<div[^>]*id="corePrice/s,
    /"price"\s*:\s*"?\$?([\d.]+)"?/,
    /priceblock_ourprice[^>]*>\s*\$?([\d.]+)/,
    /price_inside_buybox[^>]*>\s*\$?([\d.]+)/,
    /a-color-price[^>]*>\s*\$?([\d.]+)/,
    /"lowPrice"\s*:\s*"?([\d.]+)"?/,
    /data-asin-price="([\d.]+)"/,
    /twister-plus-price-data-price="([\d.]+)"/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      if (m[2] !== undefined) return parseFloat(`${m[1]}.${m[2]}`);
      const val = parseFloat(m[1]);
      if (val > 0 && val < 10000) return val;
    }
  }
  return null;
}

function extractTitle(html) {
  const patterns = [
    /id="productTitle"[^>]*>\s*([^<]+)/,
    /<title>\s*(?:Amazon\.com\s*:\s*)?(.+?)(?:\s*:\s*(?:Amazon|Everything Else).*)?<\/title>/,
    /"name"\s*:\s*"([^"]{10,200})"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  }
  return null;
}

function extractImage(html) {
  const patterns = [
    /id="landingImage"[^>]*src="([^"]+)"/,
    /id="imgBlkFront"[^>]*src="([^"]+)"/,
    /"hiRes"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/,
    /"large"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/,
    /property="og:image"[^>]*content="([^"]+)"/,
    /data-old-hires="([^"]+)"/,
    /"mainUrl"\s*:\s*"([^"]+\.(?:jpg|png|webp)[^"]*)"/,
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

async function scrapeProduct(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  try {
    const html = await fetchPage(url);
    const price = extractPrice(html);
    const title = extractTitle(html);
    const imgUrl = extractImage(html);
    return { asin, title, price, imgUrl, scraped: true };
  } catch (err) {
    return { asin, title: null, price: null, imgUrl: null, scraped: false, error: err.message };
  }
}

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'User-Agent': randomUA() },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location, filepath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const fs = require('fs');
      const ws = fs.createWriteStream(filepath);
      res.pipe(ws);
      ws.on('finish', () => resolve(filepath));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeProducts(asins, delayMs = 3000) {
  const results = {};
  let successCount = 0;
  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    console.log(`  Scraping ${asin} (${i + 1}/${asins.length})...`);
    results[asin] = await scrapeProduct(asin);
    const r = results[asin];
    if (r.scraped && (r.price || r.title)) {
      successCount++;
      console.log(`    ✓ ${r.title ? r.title.substring(0, 50) : 'no title'}... $${r.price || '?'}`);
    } else if (r.scraped) {
      console.log(`    ~ Page loaded but no data extracted`);
    } else {
      console.log(`    ✗ Failed: ${r.error}`);
    }

    if (successCount === 0 && i >= 4 && i < asins.length - 1) {
      console.log(`\n  First ${i + 1} scrapes all failed — Amazon is blocking this IP. Skipping remaining.`);
      break;
    }
    if (i < asins.length - 1) await sleep(delayMs + Math.floor(Math.random() * 2000));
  }
  console.log(`  Scrape results: ${successCount}/${Object.keys(results).length} successful`);
  return results;
}

module.exports = { scrapeProduct, scrapeProducts, downloadImage, sleep };
