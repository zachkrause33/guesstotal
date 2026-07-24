#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'bundles.config.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'bundles.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

const ACCESS_KEY = process.env.AMAZON_ACCESS_KEY;
const SECRET_KEY = process.env.AMAZON_SECRET_KEY;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'guesstotal-20';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PA_API_HOST = 'webservices.amazon.com';
const PA_API_REGION = 'us-east-1';
const PA_API_SERVICE = 'ProductAdvertisingAPI';

function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSignatureKey(key, dateStamp, region, service) {
  let k = hmac('AWS4' + key, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  return k;
}

function signRequest(payload, operation) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const apiPath = `/paapi5/${operation.toLowerCase()}`;

  const headers = {
    'content-encoding': 'amz-1.0',
    'content-type': 'application/json; charset=utf-8',
    'host': PA_API_HOST,
    'x-amz-date': amzDate,
    'x-amz-target': `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join('');

  const canonicalRequest = [
    'POST', apiPath, '',
    canonicalHeaders, signedHeaders,
    sha256(payload)
  ].join('\n');

  const credentialScope = `${dateStamp}/${PA_API_REGION}/${PA_API_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate,
    credentialScope, sha256(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, PA_API_REGION, PA_API_SERVICE);
  const signature = crypto.createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8').digest('hex');

  headers['Authorization'] = [
    `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ');

  return { headers, path: apiPath };
}

function paApiRequest(operation, body) {
  const payload = JSON.stringify(body);
  const { headers, path: apiPath } = signRequest(payload, operation);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: PA_API_HOST,
      path: apiPath,
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`PA-API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchProductData(asins) {
  const batches = [];
  for (let i = 0; i < asins.length; i += 10) {
    batches.push(asins.slice(i, i + 10));
  }

  const results = {};

  for (const batch of batches) {
    try {
      const response = await paApiRequest('GetItems', {
        ItemIds: batch,
        Resources: [
          'Images.Primary.Large',
          'Images.Primary.Medium',
          'ItemInfo.Title',
          'Offers.Listings.Price',
          'Offers.Listings.SavingBasis',
        ],
        PartnerTag: PARTNER_TAG,
        PartnerType: 'Associates',
        Marketplace: 'www.amazon.com',
      });

      if (response.ItemsResult && response.ItemsResult.Items) {
        for (const item of response.ItemsResult.Items) {
          const asin = item.ASIN;
          const title = item.ItemInfo?.Title?.DisplayValue || null;
          const imgUrl = item.Images?.Primary?.Large?.URL
            || item.Images?.Primary?.Medium?.URL
            || null;
          const price = item.Offers?.Listings?.[0]?.Price?.Amount || null;

          results[asin] = { title, price, imgUrl };
        }
      }

      if (batches.length > 1) {
        await new Promise(r => setTimeout(r, 1100));
      }
    } catch (err) {
      console.error(`  PA-API batch failed: ${err.message}`);
    }
  }

  return results;
}

async function downloadImage(url, asin) {
  const ext = url.match(/\.(\w+)$/)?.[1] || 'jpg';
  const filename = `${asin}.${ext}`;
  const filepath = path.join(IMAGES_DIR, filename);

  if (fs.existsSync(filepath)) {
    const stat = fs.statSync(filepath);
    const age = Date.now() - stat.mtimeMs;
    if (age < 7 * 24 * 60 * 60 * 1000) return `/images/${filename}`;
  }

  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (res2) => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => {
            fs.writeFileSync(filepath, Buffer.concat(chunks));
            resolve(`/images/${filename}`);
          });
        }).on('error', () => resolve(null));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(filepath, Buffer.concat(chunks));
        resolve(`/images/${filename}`);
      });
    }).on('error', () => resolve(null));
  });
}

async function generateComments(productName, theme) {
  if (!ANTHROPIC_KEY) return null;

  const prompt = `Generate witty, short game-show-style comments for a price guessing game product.

Product: "${productName}"
Theme: "${theme}"

Return a JSON object with 5 keys: exact, hot, warm, cold, ice.
Each value is an array of 3 strings: [emoji, SHORT_TITLE, one_sentence_comment].

- exact: player guessed perfectly. Be amazed.
- hot: very close guess. Be impressed.
- warm: decent guess. Be encouraging.
- cold: pretty far off. Be playful.
- ice: way off. Be dramatic/funny.

Keep titles to 1-2 words ALL CAPS. Comments should be punny and reference the product.
Return ONLY the JSON object, no markdown.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text || '';
          const comments = JSON.parse(text);
          resolve(comments);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Guess Total Bundle Generator ===\n');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const hasAmazonApi = ACCESS_KEY && SECRET_KEY;
  const hasAnthropicApi = !!ANTHROPIC_KEY;

  console.log(`Amazon PA-API: ${hasAmazonApi ? 'configured' : 'not configured (using fallback data)'}`);
  console.log(`Claude API:    ${hasAnthropicApi ? 'configured' : 'not configured (using existing comments)'}`);
  console.log(`Bundles:       ${config.bundles.length}`);
  console.log(`Products:      ${config.bundles.reduce((a, b) => a + b.products.length, 0)}\n`);

  let amazonData = {};

  if (hasAmazonApi) {
    const allAsins = [...new Set(
      config.bundles.flatMap(b => b.products.map(p => p.asin))
    )];
    console.log(`Fetching ${allAsins.length} products from Amazon PA-API...`);
    amazonData = await fetchProductData(allAsins);
    const found = Object.keys(amazonData).length;
    console.log(`  Got data for ${found}/${allAsins.length} products\n`);
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const bundles = [];
  let updatedPrices = 0;
  let updatedImages = 0;
  let generatedComments = 0;

  for (const bundle of config.bundles) {
    console.log(`Processing: ${bundle.theme}`);
    const products = [];

    for (const p of bundle.products) {
      const amazon = amazonData[p.asin];
      let name = p.fallbackName;
      let price = p.fallbackPrice;
      let img = p.fallbackImg;

      if (amazon) {
        if (amazon.title) name = amazon.title;
        if (amazon.price) { price = amazon.price; updatedPrices++; }

        if (amazon.imgUrl) {
          const downloaded = await downloadImage(amazon.imgUrl, p.asin);
          if (downloaded) { img = downloaded; updatedImages++; }
        }
      }

      let comments = p.comments;
      if (hasAnthropicApi && !comments) {
        console.log(`  Generating comments for ${name}...`);
        const generated = await generateComments(name, bundle.theme);
        if (generated) { comments = generated; generatedComments++; }
      }

      if (!comments) {
        comments = {
          exact: ['👑', 'NAILED IT.', `Perfect guess on the ${name}!`],
          hot: ['🔥', 'SO CLOSE.', `Really close on the ${name}. Impressive!`],
          warm: ['😅', 'NOT BAD.', `Decent guess on the ${name}.`],
          cold: ['❄️', 'OFF TARGET.', `The ${name} had you guessing.`],
          ice: ['💀', 'WAY OFF.', `You completely missed on the ${name}.`],
        };
      }

      products.push({ name, teaser: p.teaser, meta: p.meta, price, asin: p.asin, img, comments });
    }

    bundles.push({
      id: bundle.id,
      theme: bundle.theme,
      tagline: bundle.tagline,
      emoji: bundle.emoji,
      tease: bundle.tease,
      products,
    });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(bundles));
  const size = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0);

  console.log(`\n=== Done ===`);
  console.log(`Output: public/bundles.json (${size} KB)`);
  if (hasAmazonApi) {
    console.log(`Updated prices: ${updatedPrices}`);
    console.log(`Updated images: ${updatedImages}`);
  }
  if (generatedComments > 0) {
    console.log(`Generated comments: ${generatedComments}`);
  }

  const meta = {
    generated: new Date().toISOString(),
    bundleCount: bundles.length,
    productCount: bundles.reduce((a, b) => a + b.products.length, 0),
    amazonApiUsed: hasAmazonApi,
    pricesUpdated: updatedPrices,
    imagesUpdated: updatedImages,
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'public', 'bundles.meta.json'),
    JSON.stringify(meta, null, 2)
  );
}

main().catch(err => { console.error(err); process.exit(1); });
