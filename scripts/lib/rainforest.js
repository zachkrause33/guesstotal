const https = require('https');

const BASE_URL = 'https://api.rainforestapi.com/request';

function rainforestRequest(params) {
  const apiKey = process.env.RAINFOREST_API_KEY;
  if (!apiKey) throw new Error('RAINFOREST_API_KEY not set');

  const qs = new URLSearchParams({ api_key: apiKey, amazon_domain: 'amazon.com', ...params });
  const url = `${BASE_URL}?${qs.toString()}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}

        if (res.statusCode !== 200) {
          const message = json?.request_info?.message || data.substring(0, 200);
          const err = new Error(`Rainforest API ${res.statusCode}: ${message}`);
          err.statusCode = res.statusCode;
          err.notFound = res.statusCode === 400 && /asin|not found|invalid/i.test(message);
          return reject(err);
        }
        if (!json) return reject(new Error('Rainforest API returned invalid JSON'));
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function pickImage(product) {
  if (product.main_image && product.main_image.link) return product.main_image.link;
  if (Array.isArray(product.images) && product.images[0] && product.images[0].link) return product.images[0].link;
  return null;
}

function pickPrice(product) {
  if (product.buybox_winner && product.buybox_winner.price && typeof product.buybox_winner.price.value === 'number') {
    return product.buybox_winner.price.value;
  }
  if (product.price && typeof product.price.value === 'number') return product.price.value;
  return null;
}

async function fetchProduct(asin) {
  let data;
  try {
    data = await rainforestRequest({ type: 'product', asin });
  } catch (err) {
    return { asin, title: null, price: null, imgUrl: null, scraped: false, notFound: !!err.notFound, error: err.message };
  }

  const product = data.product;
  if (!product) return { asin, title: null, price: null, imgUrl: null, scraped: false, notFound: true, error: 'No product in response' };

  return {
    asin,
    title: product.title || null,
    price: pickPrice(product),
    imgUrl: pickImage(product),
    scraped: true,
  };
}

async function searchProducts(searchTerm) {
  const data = await rainforestRequest({ type: 'search', search_term: searchTerm });
  const results = Array.isArray(data.search_results) ? data.search_results : [];

  return results
    .filter(r => r.asin && r.title)
    .map(r => ({
      asin: r.asin,
      title: r.title,
      price: r.price && typeof r.price.value === 'number' ? r.price.value : null,
      imgUrl: r.image || null,
    }))
    .filter(r => r.price && r.price > 5 && r.price < 500);
}

module.exports = { fetchProduct, searchProducts };
