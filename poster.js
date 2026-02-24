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

const CATEGORY_MAP = {
  'for-sale-by-owner': '/post/fso',
  'electronics': '/post/fso',
  'general': '/post/fso',
  'computer': '/post/syp',
  'furniture': '/post/fuo',
  'auto-parts': '/post/pta',
  'cell-phones': '/post/mob',
  'housing': '/post/reo',
  'real-estate': '/post/reo',
};

async function downloadImage(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

// Screenshot images from a source URL (Zillow, Redfin, etc)
async function screenshotImagesFromUrl(sourceUrl, tmpDir, maxImages = 8) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const imagePaths = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(sourceUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try to find and click the main listing image to open gallery
    const mainImg = await page.$('img[src*="zillowstatic"], img[src*="photos"], img[src*="cdn"], .media-stream-photo img, [data-testid="hero-image"] img, .carousel-photo img');
    if (mainImg) {
      await mainImg.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Screenshot the main visible property photo area
    // First attempt: screenshot each visible large image
    const imgElements = await page.$$('img[src*="zillowstatic"], img[src*="photos.rdc"], img[src*="ssl.cdn-redfin"], img[src*="crmls"], .media-stream img, .photo-viewer img');
    
    for (let i = 0; i < Math.min(imgElements.length, maxImages); i++) {
      try {
        const imgSrc = await imgElements[i].evaluate(el => el.src);
        if (imgSrc && imgSrc.startsWith('http') && !imgSrc.includes('data:')) {
          const ext = imgSrc.match(/\.(jpg|jpeg|png|webp)/i)?.[1] || 'jpg';
          const destPath = path.join(tmpDir, `screenshot_${i}.${ext}`);
          await downloadImage(imgSrc, destPath);
          imagePaths.push(destPath);
          console.log(`Captured image ${i} from src: ${imgSrc.substring(0, 80)}`);
        }
      } catch (e) {
        console.log(`Image ${i} src capture failed, trying screenshot`);
      }
    }

    // Fallback: if no images found via src, screenshot the full page top area
    if (imagePaths.length === 0) {
      const screenshotPath = path.join(tmpDir, 'screenshot_0.jpg');
      await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1280, height: 700 } });
      imagePaths.push(screenshotPath);
      console.log('Fallback: used full page screenshot');
    }
  } finally {
    await browser.close();
  }
  return imagePaths;
}

async function postToCraigslist({ jobId, adData, proxyConfig, targetCity, updateJobStatus }) {
  const { title, price, description, category, condition, make, model, imageUrls, phoneNumber, email, sourceUrl } = adData;
  const cityKey = targetCity || 'orangecounty';
  const baseUrl = CITY_MAP[cityKey] || CITY_MAP['orangecounty'];
  const categoryPath = CATEGORY_MAP[category] || CATEGORY_MAP[category?.toLowerCase()] || '/post/fso';

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,900',
  ];
  if (proxyConfig && proxyConfig.host) {
    const proxyUrl = `${proxyConfig.host}:${proxyConfig.port}`;
    launchArgs.push(`--proxy-server=${proxyUrl}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs,
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    if (proxyConfig && proxyConfig.username) {
      await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Step 1: Navigate to CL posting page
    await updateJobStatus(jobId, 'processing', 'navigating');
    const postUrl = `${baseUrl}${categoryPath}`;
    console.log('Navigating to:', postUrl);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Fill the posting form
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

    const continueBtn = await page.$('button.pickbutton, button[type="submit"]');
    if (continueBtn) {
      await continueBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    const mapContinue = await page.$('button.continue, button[value="continue"]');
    if (mapContinue) {
      await mapContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 3: Handle images
    await updateJobStatus(jobId, 'processing', 'uploading_images');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-images-'));
    let imagePaths = [];

    // Option A: Download from provided imageUrls
    if (imageUrls && imageUrls.length > 0) {
      for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
        try {
          const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
          const imgPath = path.join(tmpDir, `image_${i}.${ext}`);
          await downloadImage(imageUrls[i], imgPath);
          imagePaths.push(imgPath);
        } catch (e) { console.error(`Image ${i} download failed:`, e.message); }
      }
    }

    // Option B: Screenshot images from source URL (Zillow, Redfin, etc)
    if (imagePaths.length === 0 && sourceUrl) {
      console.log('No imageUrls provided, screenshotting from sourceUrl:', sourceUrl);
      await updateJobStatus(jobId, 'processing', 'screenshotting_source');
      try {
        imagePaths = await screenshotImagesFromUrl(sourceUrl, tmpDir, 8);
        console.log(`Captured ${imagePaths.length} images from source URL`);
      } catch (e) {
        console.error('Screenshot from source URL failed:', e.message);
      }
    }

    // Upload images to Craigslist
    for (const imgPath of imagePaths) {
      try {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.uploadFile(imgPath);
          await page.waitForTimeout(3000);
        }
        fs.unlinkSync(imgPath);
      } catch (e) { console.error('Image upload failed:', e.message); }
    }
    try { fs.rmdirSync(tmpDir); } catch (e) {}

    // Click done with images
    const doneBtn = await page.$('button.done, a.done, button[value="done with images"]');
    if (doneBtn) {
      await doneBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 4: Publish
    await updateJobStatus(jobId, 'processing', 'publishing');
    const publishBtn = await page.$('button.submit, button[type="submit"]');
    if (publishBtn) {
      await publishBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);

    // Capture the confirmation/result URL
    const finalUrl = page.url();
    // Try to get the actual post URL from the confirmation page
    let postUrl2 = finalUrl;
    const confirmLink = await page.$('a[href*="/d/"], a.manageable-ad-link, a[href*="craigslist.org"]');
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
