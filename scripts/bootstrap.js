#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!scriptMatch) { console.error('Could not find script block'); process.exit(1); }

const js = scriptMatch[1];

const bundlesStart = js.indexOf('const BUNDLES=[');
if (bundlesStart === -1) { console.error('Could not find BUNDLES array'); process.exit(1); }

let depth = 0, start = js.indexOf('[', bundlesStart), i = start;
for (; i < js.length; i++) {
  if (js[i] === '[') depth++;
  else if (js[i] === ']') { depth--; if (depth === 0) break; }
}
const bundlesStr = js.substring(start, i + 1);

const BUNDLES = eval(bundlesStr);
console.log(`Found ${BUNDLES.length} bundles with ${BUNDLES.reduce((a, b) => a + b.products.length, 0)} products total`);

const imagesDir = path.join(__dirname, '..', 'public', 'images');
fs.mkdirSync(imagesDir, { recursive: true });

const config = { bundles: [] };

for (const bundle of BUNDLES) {
  const configBundle = {
    id: bundle.id,
    theme: bundle.theme,
    tagline: bundle.tagline,
    emoji: bundle.emoji,
    tease: bundle.tease,
    products: []
  };

  for (const p of bundle.products) {
    let imgPath = null;

    if (p.img && p.img.startsWith('data:')) {
      const match = p.img.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const filename = `${p.asin}.${ext}`;
        const buffer = Buffer.from(match[2], 'base64');
        fs.writeFileSync(path.join(imagesDir, filename), buffer);
        imgPath = `/images/${filename}`;
        console.log(`  Extracted ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
      }
    }

    configBundle.products.push({
      asin: p.asin,
      teaser: p.teaser,
      meta: p.meta,
      fallbackName: p.name,
      fallbackPrice: p.price,
      fallbackImg: imgPath,
      comments: p.comments
    });
  }

  config.bundles.push(configBundle);
}

fs.writeFileSync(
  path.join(__dirname, '..', 'bundles.config.json'),
  JSON.stringify(config, null, 2)
);
console.log(`\nWrote bundles.config.json with ${config.bundles.length} bundles`);

const bundles = config.bundles.map(b => ({
  id: b.id,
  theme: b.theme,
  tagline: b.tagline,
  emoji: b.emoji,
  tease: b.tease,
  products: b.products.map(p => ({
    name: p.fallbackName,
    teaser: p.teaser,
    meta: p.meta,
    price: p.fallbackPrice,
    asin: p.asin,
    img: p.fallbackImg,
    comments: p.comments
  }))
}));

fs.writeFileSync(
  path.join(__dirname, '..', 'public', 'bundles.json'),
  JSON.stringify(bundles)
);
console.log(`Wrote public/bundles.json (${(JSON.stringify(bundles).length / 1024).toFixed(0)} KB)`);
