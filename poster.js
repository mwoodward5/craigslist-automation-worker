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
};

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

async function postToCraigslist({ jobId, adData, proxyConfig, targetCity, updateJobStatus }) {
  const { title, price, description, category, condition, make, model, imageUrls, phoneNumber, email } = adData;
  const cityKey = targetCity || 'orangecounty';
  const baseUrl = CITY_MAP[cityKey] || CITY_MAP['orangecounty'];
  const categoryPath = CATEGORY_MAP[category] || '/post/fso';

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
      await page.authenticate({
        username: proxyConfig.username,
        password: proxyConfig.password,
      });
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

    // Title
    const titleInput = await page.$('input[name="PostingTitle"]');
    if (titleInput) {
      await titleInput.click({ clickCount: 3 });
      await titleInput.type(title || 'Item for Sale');
    }

    // Price
    const priceInput = await page.$('input[name="price"]');
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await priceInput.type(String(price || ''));
    }

    // Description
    const descInput = await page.$('textarea[name="PostingBody"]');
    if (descInput) {
      await descInput.click({ clickCount: 3 });
      await descInput.type(description || '');
    }

    // Postal code
    const zipInput = await page.$('input[name="postal"]');
    if (zipInput) {
      await zipInput.click({ clickCount: 3 });
      await zipInput.type(adData.zip || '92694');
    }

    // Condition
    if (condition) {
      const condSelect = await page.$('select[name="condition"]');
      if (condSelect) {
        const condMap = { 'new': '10', 'like new': '20', 'excellent': '30', 'good': '40', 'fair': '50', 'salvage': '60' };
        const condVal = condMap[condition.toLowerCase()] || '20';
        await page.select('select[name="condition"]', condVal);
      }
    }

    // Make
    if (make) {
      const makeInput = await page.$('input[name="make_manufacturer"]');
      if (makeInput) {
        await makeInput.click({ clickCount: 3 });
        await makeInput.type(make);
      }
    }

    // Model
    if (model) {
      const modelInput = await page.$('input[name="model_name_number"]');
      if (modelInput) {
        await modelInput.click({ clickCount: 3 });
        await modelInput.type(model);
      }
    }

    // Phone number
    if (phoneNumber) {
      const phoneInput = await page.$('input[name="contact_phone"]');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phoneNumber);
      }
    }

    // Click continue button
    const continueBtn = await page.$('button.pickbutton, button[type="submit"]');
    if (continueBtn) {
      await continueBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    // Step 3: Handle map/location page if present
    const mapContinue = await page.$('button.continue, button[value="continue"]');
    if (mapContinue) {
      await mapContinue.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 4: Upload images
    await updateJobStatus(jobId, 'processing', 'uploading_images');
    if (imageUrls && imageUrls.length > 0) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-images-'));

      for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
        try {
          const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
          const imgPath = path.join(tmpDir, `image_${i}.${ext}`);
          await downloadImage(imageUrls[i], imgPath);

          // Find file input and upload
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.uploadFile(imgPath);
            await page.waitForTimeout(3000);
          }

          // Clean up
          fs.unlinkSync(imgPath);
        } catch (imgErr) {
          console.error(`Image ${i} upload failed:`, imgErr.message);
        }
      }

      // Clean up tmp dir
      try { fs.rmdirSync(tmpDir); } catch (e) {}
    }

    // Click done with images
    const doneBtn = await page.$('button.done, a.done, button[value="done with images"]');
    if (doneBtn) {
      await doneBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 5: Publish
    await updateJobStatus(jobId, 'processing', 'publishing');
    const publishBtn = await page.$('button.submit, button[type="submit"]');
    if (publishBtn) {
      await publishBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);

    return { postUrl: finalUrl, success: true };
  } finally {
    await browser.close();
  }
}

module.exports = { postToCraigslist };
