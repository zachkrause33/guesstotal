#!/usr/bin/env node
const { execSync } = require('child_process');

const key = process.env.SCRAPER_API_KEY;

console.log('=== GuessTotal Bootstrap ===\n');

if (!key) {
  console.log('No SCRAPER_API_KEY found.\n');
  console.log('Usage:');
  console.log('  SCRAPER_API_KEY=your_key npm run bootstrap\n');
  console.log('Get a free key at https://www.scraperapi.com (1,000 requests/month)\n');
  console.log('Running generate with fallback data only...\n');
  execSync('node scripts/generate-bundles.js', { stdio: 'inherit' });
  return;
}

console.log('Step 1/3: Refreshing prices via ScraperAPI...\n');
try {
  execSync('node scripts/refresh-prices.js', { stdio: 'inherit', env: { ...process.env } });
} catch (e) {
  console.log('\nPrice refresh had errors (continuing anyway)\n');
}

console.log('\nStep 2/3: Discovering new products...\n');
try {
  execSync('node scripts/discover-products.js', { stdio: 'inherit', env: { ...process.env } });
} catch (e) {
  console.log('\nProduct discovery had errors (continuing anyway)\n');
}

console.log('\nStep 3/3: Generating bundles...\n');
execSync('node scripts/generate-bundles.js', { stdio: 'inherit', env: { ...process.env } });

console.log('\n=== Bootstrap Complete ===');
console.log('Your site now has real prices, images, and affiliate links!');
console.log('Deploy to Vercel or run a local server to see it.');
