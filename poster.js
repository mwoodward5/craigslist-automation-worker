const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CITY_MAP = {
  'orangecounty': 'https://orangecounty.craigslist.org',
  'losangeles': 'https://losangeles.craigslist.org',
  'sfbay': 'https://sfbay.craigslist.org',
  'sandiego': 'https://sandiego.craigslist.org',
  'inlandempire': 'https://inlandempire.craigslist.org',
};

// Map category to the radio button label text on CL wizard "choose type" page
const TYPE_MAP = {
  'for-sale-by-owner': 'for sale by owner',
  'electronics': 'for sale by owner',
  'general': 'for sale by owner',
  'computer': 'for sale by owner',
  'furniture': 'for sale by owner',
  'auto-parts': 'for sale by owner',
  'cell-phones': 'for sale by owner',
  'housing': 'housing offered',
  'real-estate': 'for sale by owner',
};

async function downloadImage(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = await res.buffer();
  if (buffer.length < 5000) throw new Error(`Image too small (${buffer.length} bytes)`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

async function postToCraigslist({ jobId, adData, proxyConfig, targetCity, updateJobStatus }) {
  const { title, price, description, category, condition, make, model, imageUrls, phoneNumber, email, sourceUrl } = adData;
  const cityKey = targetCity || 'orangecounty';
  const baseUrl = CITY_MAP[cityKey] || CITY_MAP['orangecounty'];
  const postingType = TYPE_MAP[category] || TYPE_MAP[category?.toLowerCase()] || 'for sale by owner';

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,900'];
  if (proxyConfig && proxyConfig.host) {
    launchArgs.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs, defaultViewport: { width: 1280, height: 900 } });

  try {
    const page = await browser.newPage();
    if (proxyConfig && proxyConfig.username) {
      await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Step 1: Go to CL homepage and click "post an ad"
    await updateJobStatus(jobId, 'processing', 'navigating');
    console.log('Navigating to:', baseUrl);
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Click "post an ad" link
    const postLink = await page.$('a#post, a[href*="post.craigslist.org"]');
    if (postLink) {
      await postLink.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      console.log('No post link found, trying direct nav');
      await page.goto(baseUrl + '/post', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After post click URL:', page.url());

    // Step 2: Handle "copy from previous" page - click skip
    const skipBtn = await page.$('button[name="skip"], input[value="skip"]');
    if (skipBtn) {
      await skipBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After skip URL:', page.url());

    // Step 3: Choose area - just click continue (default is correct area)
    const areaContinue = await page.$('button[name="go"], input[value="continue"]');
    if (areaContinue) {
      await areaContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After area URL:', page.url());

    // Step 4: Choose type - select radio button matching postingType
    await updateJobStatus(jobId, 'processing', 'selecting_type');
    const typeLabels = await page.$$('label');
    for (const label of typeLabels) {
      const text = await label.evaluate(el => el.textContent.trim().toLowerCase());
      if (text === postingType) {
        await label.click();
        console.log('Selected type:', text);
        break;
      }
    }
    const typeContinue = await page.$('button[name="go"], input[value="continue"]');
    if (typeContinue) {
      await typeContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After type URL:', page.url());

    // Step 5: Choose category - click first matching or default
    const catLabels = await page.$$('label');
    let catFound = false;
    const catKeywords = (category || 'general').toLowerCase();
    for (const label of catLabels) {
      const text = await label.evaluate(el => el.textContent.trim().toLowerCase());
      if (text.includes(catKeywords) || text.includes('general') || text.includes('real estate')) {
        await label.click();
        console.log('Selected category:', text);
        catFound = true;
        break;
      }
    }
    if (!catFound && catLabels.length > 0) {
      await catLabels[0].click();
      console.log('Selected first available category');
    }
    const catContinue = await page.$('button[name="go"], input[value="continue"]');
    if (catContinue) {
      await catContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After category URL:', page.url());

    // Step 6: Fill the posting form
    await updateJobStatus(jobId, 'processing', 'filling_form');
    const titleInput = await page.$('input[name="PostingTitle"]');
    if (titleInput) { await titleInput.click({ clickCount: 3 }); await titleInput.type(title || 'Item for Sale'); }
    const priceInput = await page.$('input[name="price"]');
    if (priceInput) { await priceInput.click({ clickCount: 3 }); await priceInput.type(String(price || '')); }
    const descInput = await page.$('textarea[name="PostingBody"]');
    if (descInput) { await descInput.click({ clickCount: 3 }); await descInput.type(description || ''); }
    const zipInput = await page.$('input[name="postal"]');
    if (zipInput) { await zipInput.click({ clickCount: 3 }); await zipInput.type(adData.zip || adData.zipCode || '92694'); }
    if (condition) {
      const condSelect = await page.$('select[name="condition"]');
      if (condSelect) {
        const condMap = { 'new': '10', 'like new': '20', 'excellent': '30', 'good': '40', 'fair': '50', 'salvage': '60' };
        await page.select('select[name="condition"]', condMap[condition.toLowerCase()] || '20');
      }
    }
    if (make) { const el = await page.$('input[name="make_manufacturer"]'); if (el) { await el.click({ clickCount: 3 }); await el.type(make); } }
    if (model) { const el = await page.$('input[name="model_name_number"]'); if (el) { await el.click({ clickCount: 3 }); await el.type(model); } }
    if (phoneNumber) { const el = await page.$('input[name="contact_phone"]'); if (el) { await el.click({ clickCount: 3 }); await el.type(phoneNumber); } }
    console.log('Form filled, submitting...');

    const continueBtn = await page.$('button.pickbutton, button[type="submit"], input[type="submit"]');
    if (continueBtn) {
      await continueBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    console.log('After form submit URL:', page.url());

    // Handle map/location page if it appears
    const mapContinue = await page.$('button.continue, button[value="continue"], input[value="continue"]');
    if (mapContinue) {
      await mapContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 7: Handle images
    await updateJobStatus(jobId, 'processing', 'uploading_images');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-images-'));
    let imagePaths = [];

    // Download from provided imageUrls (from Firecrawl scraping)
    if (imageUrls && imageUrls.length > 0) {
      console.log(`Downloading ${imageUrls.length} images from imageUrls`);
      for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
        try {
          const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
          const imgPath = path.join(tmpDir, `image_${i}.${ext}`);
          await downloadImage(imageUrls[i], imgPath);
          imagePaths.push(imgPath);
          console.log(`Downloaded image ${i}: ${imageUrls[i].substring(0, 80)}`);
        } catch (e) { console.error(`Image ${i} download failed:`, e.message); }
      }
    }
    console.log(`Total images to upload: ${imagePaths.length}`);

    // Upload images to Craigslist
    for (const imgPath of imagePaths) {
      try {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.uploadFile(imgPath);
          await page.waitForTimeout(3000);
          console.log(`Uploaded: ${imgPath}`);
        }
        fs.unlinkSync(imgPath);
      } catch (e) { console.error('Image upload failed:', e.message); }
    }
    try { fs.rmdirSync(tmpDir); } catch (e) {}

    // Click done with images
    const doneBtn = await page.$('button.done, a.done, button[value="done with images"], input[value="done with images"]');
    if (doneBtn) {
      await doneBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log('After images URL:', page.url());

    // Step 8: Publish
    await updateJobStatus(jobId, 'processing', 'publishing');
    const publishBtn = await page.$('button.submit, button[type="submit"], input[type="submit"]');
    if (publishBtn) {
      await publishBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    let postUrl2 = finalUrl;
    const confirmLink = await page.$('a[href*="/d/"], a.manageable-ad-link');
    if (confirmLink) {
      postUrl2 = await confirmLink.evaluate(el => el.href) || finalUrl;
    }
    console.log('Final URL:', finalUrl, 'Post URL:', postUrl2);
    return { postUrl: postUrl2, success: true };
  } finally {
    await browser.close();
  }
}

module.exports = { postToCraigslist };
