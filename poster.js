const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CITY_MAP = {
  'orangecounty': { base: 'https://orangecounty.craigslist.org', code: 'orc' },
  'losangeles': { base: 'https://losangeles.craigslist.org', code: 'lac' },
  'sfbay': { base: 'https://sfbay.craigslist.org', code: 'sfc' },
  'sandiego': { base: 'https://sandiego.craigslist.org', code: 'sdo' },
  'inlandempire': { base: 'https://inlandempire.craigslist.org', code: 'iee' },
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

// Robust helper: wait for selector then return element, throws with context on failure
async function waitAndGet(page, selector, description, timeout = 15000) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    const el = await page.$(selector);
    if (!el) throw new Error(`Element found by waitForSelector but page.$() returned null`);
    return el;
  } catch (err) {
    throw new Error(`Failed to find "${description}" (${selector}): ${err.message}`);
  }
}

// Click the main "continue" / "pickbutton" button on wizard pages
// CL uses: <button class="pickbutton" type="submit" name="go" value="Continue">continue</button>
async function clickContinueButton(page, description = 'continue button') {
  const selectors = [
    'button.pickbutton',
    'button[name="go"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      const isVisible = await btn.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      });
      if (isVisible) {
        console.log(`Clicking ${description} via: ${sel}`);
        await btn.click();
        return true;
      }
    }
  }
  console.log(`No ${description} found, skipping`);
  return false;
}

// Wait for navigation after a click, with fallback
async function safeWaitForNav(page, timeout = 15000) {
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout });
  } catch (e) {
    // Navigation may have already completed or page didn't navigate
    console.log('Navigation wait timed out (may already be done)');
  }
}

// Select a radio button by matching label text (case-insensitive, trimmed)
async function selectRadioByLabelText(page, targetText, description) {
  // CL structure: <label><input type="radio" ...> label text</label>
  const selected = await page.evaluate((target) => {
    const labels = document.querySelectorAll('form.picker label, .selection-list label');
    for (const label of labels) {
      const text = label.textContent.trim().toLowerCase();
      if (text === target.toLowerCase()) {
        const radio = label.querySelector('input[type="radio"]');
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          label.click();
          return text;
        }
      }
    }
    return null;
  }, targetText);

  if (selected) {
    console.log(`Selected ${description}: "${selected}"`);
    return true;
  }

  // Fallback: partial match
  const partial = await page.evaluate((target) => {
    const labels = document.querySelectorAll('form.picker label, .selection-list label');
    for (const label of labels) {
      const text = label.textContent.trim().toLowerCase();
      if (text.includes(target.toLowerCase())) {
        const radio = label.querySelector('input[type="radio"]');
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          label.click();
          return text;
        }
      }
    }
    return null;
  }, targetText);

  if (partial) {
    console.log(`Selected ${description} (partial match): "${partial}"`);
    return true;
  }

  console.log(`Could not find ${description} matching "${targetText}"`);
  return false;
}

// Delay helper (replaces deprecated waitForTimeout)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = await res.buffer();
  if (buffer.length < 5000) throw new Error(`Image too small (${buffer.length} bytes)`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

// Detect which wizard stage we're on by checking body class or page title
async function detectStage(page) {
  return await page.evaluate(() => {
    const body = document.body;
    const classes = body.className || '';
    // CL sets body classes like: "cl-posting-process post type"
    // Stages: copyfromanother, subarea, hood, type, cat, edit, geoverify, editimage, preview, finalize
    const stages = ['copyfromanother', 'subarea', 'hood', 'type', 'cat', 'edit', 'geoverify', 'editimage', 'preview', 'finalize'];
    for (const s of stages) {
      if (classes.includes(s)) return s;
    }
    // Fallback: check the page title
    const title = document.title.toLowerCase();
    if (title.includes('choose type')) return 'type';
    if (title.includes('choose category')) return 'cat';
    if (title.includes('choose nearest area') || title.includes('choose area')) return 'subarea';
    if (title.includes('choose neighborhood')) return 'hood';
    if (title.includes('copy from')) return 'copyfromanother';
    if (title.includes('edit posting') || title.includes('posting details')) return 'edit';
    if (title.includes('add images')) return 'editimage';
    if (title.includes('verify')) return 'geoverify';
    if (title.includes('preview')) return 'preview';
    return 'unknown';
  });
}

async function postToCraigslist({ jobId, adData, proxyConfig, targetCity, updateJobStatus }) {
  const { title, price, description, category, condition, make, model, imageUrls, phoneNumber, email, sourceUrl } = adData;
  const cityKey = targetCity || 'orangecounty';
  const cityInfo = CITY_MAP[cityKey] || CITY_MAP['orangecounty'];
  const baseUrl = cityInfo.base;
  const areaCode = cityInfo.code;
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

    // =========================================================
    // Step 1: Navigate directly to the CL posting wizard for the target area
    // The current CL flow: https://post.craigslist.org/c/{areaCode} → wizard
    // =========================================================
    await updateJobStatus(jobId, 'processing', 'navigating');
    const postUrl = `https://post.craigslist.org/c/${areaCode}`;
    console.log('Navigating directly to posting wizard:', postUrl);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
    console.log('Wizard URL:', page.url());

    // Detect which stage we landed on and navigate accordingly
    let stage = await detectStage(page);
    console.log('Detected initial stage:', stage);

    // =========================================================
    // Handle login redirect if needed
    // =========================================================
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.craigslist.org/login')) {
      console.log('Login required — attempting to log in');
      await updateJobStatus(jobId, 'processing', 'logging_in');

      const loginEmail = email || adData.clEmail || process.env.CL_EMAIL;
      const loginPassword = adData.clPassword || process.env.CL_PASSWORD;

      if (!loginEmail || !loginPassword) {
        throw new Error('Login required but no credentials provided (set CL_EMAIL/CL_PASSWORD env vars or pass in adData)');
      }

      const emailInput = await page.$('input[name="inputEmailHandle"]');
      if (emailInput) {
        await emailInput.type(loginEmail);
        const pwInput = await page.$('input[name="inputPassword"]');
        if (pwInput) {
          await pwInput.type(loginPassword);
          const loginBtn = await page.$('button[type="submit"]');
          if (loginBtn) {
            await loginBtn.click();
            await safeWaitForNav(page);
            await delay(3000);
          }
        }
      }
      console.log('After login URL:', page.url());
      stage = await detectStage(page);
      console.log('Stage after login:', stage);
    }

    // =========================================================
    // Step 2: Handle "copy from previous" page if it appears
    // =========================================================
    if (stage === 'copyfromanother') {
      console.log('On copy-from-another page, looking for skip/new option');
      // Try clicking "create a new posting" or skip
      const newPostLink = await page.$('a[href*="new"], button[name="skip"]');
      if (newPostLink) {
        await newPostLink.click();
        await safeWaitForNav(page);
        await delay(2000);
      } else {
        // Just click continue to skip past it
        await clickContinueButton(page, 'skip copy-from-another');
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after skip:', stage);
    }

    // =========================================================
    // Step 3: Handle subarea selection if it appears
    // =========================================================
    if (stage === 'subarea') {
      console.log('On subarea selection page');
      await updateJobStatus(jobId, 'processing', 'selecting_area');
      // Select first subarea by default (or try to match)
      const firstRadio = await page.$('form.picker input[type="radio"]');
      if (firstRadio) {
        await firstRadio.click();
        console.log('Selected first subarea');
      }
      if (await clickContinueButton(page, 'subarea continue')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after subarea:', stage);
    }

    // =========================================================
    // Step 3b: Handle neighborhood (hood) selection if it appears
    // =========================================================
    if (stage === 'hood') {
      console.log('On neighborhood selection page');
      const firstRadio = await page.$('form.picker input[type="radio"]');
      if (firstRadio) {
        await firstRadio.click();
      }
      if (await clickContinueButton(page, 'hood continue')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after hood:', stage);
    }

    // =========================================================
    // Step 4: Choose type (e.g. "for sale by owner")
    // CL structure: form.picker > ul.selection-list > li > label > input[type="radio"][name="id"]
    // =========================================================
    if (stage === 'type') {
      await updateJobStatus(jobId, 'processing', 'selecting_type');
      console.log(`Selecting posting type: "${postingType}"`);
      await selectRadioByLabelText(page, postingType, 'posting type');
      if (await clickContinueButton(page, 'type continue')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after type:', stage);
    }

    // =========================================================
    // Step 5: Choose category
    // Same form.picker structure with radio buttons
    // =========================================================
    if (stage === 'cat') {
      await updateJobStatus(jobId, 'processing', 'selecting_category');
      const catKeyword = (category || 'general').toLowerCase();
      console.log(`Selecting category matching: "${catKeyword}"`);

      // Try exact match first, then partial, then keywords
      let found = await selectRadioByLabelText(page, catKeyword, 'category');
      if (!found) {
        // Try common category mappings
        const catAliases = {
          'electronics': 'electronics',
          'computer': 'computers',
          'furniture': 'furniture',
          'auto-parts': 'auto parts',
          'cell-phones': 'cell phones',
          'general': 'general',
          'for-sale-by-owner': 'general',
          'bicycles': 'bicycles',
          'bikes': 'bicycles',
          'bicycle': 'bicycles',
          'sporting': 'sporting goods',
          'tools': 'tools',
          'appliances': 'appliances',
          'clothing': 'clothing',
          'collectibles': 'collectibles',
          'real-estate': 'real estate',
        };
        const alias = catAliases[catKeyword] || catKeyword;
        if (alias !== catKeyword) {
          found = await selectRadioByLabelText(page, alias, 'category (alias)');
        }
      }
      if (!found) {
        // Select first available category as fallback
        const firstRadio = await page.$('form.picker input[type="radio"]');
        if (firstRadio) {
          await page.evaluate(() => {
            const radio = document.querySelector('form.picker input[type="radio"]');
            if (radio) {
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              const label = radio.closest('label');
              if (label) label.click();
            }
          });
          console.log('Selected first available category as fallback');
        }
      }

      if (await clickContinueButton(page, 'category continue')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after category:', stage);
    }

    // =========================================================
    // Step 6: Fill the posting form (stage: edit)
    // CL form fields: PostingTitle, price, PostingBody, postal, condition, etc.
    // =========================================================
    if (stage === 'edit') {
      await updateJobStatus(jobId, 'processing', 'filling_form');
      console.log('Filling posting form...');

      // Wait for the form to be fully loaded
      await page.waitForSelector('input[name="PostingTitle"], #PostingTitle', { timeout: 15000 }).catch(() => {
        console.log('Warning: PostingTitle field not found within timeout');
      });

      // Title
      await fillField(page, 'input[name="PostingTitle"]', title || 'Item for Sale', 'title');
      // Price
      await fillField(page, 'input[name="price"]', String(price || ''), 'price');
      // Description
      await fillField(page, 'textarea[name="PostingBody"]', description || '', 'description');
      // Zip code
      await fillField(page, 'input[name="postal"]', adData.zip || adData.zipCode || '92694', 'zip');

      // Condition dropdown
      if (condition) {
        const condSelect = await page.$('select[name="condition"]');
        if (condSelect) {
          const condMap = { 'new': '10', 'like new': '20', 'excellent': '30', 'good': '40', 'fair': '50', 'salvage': '60' };
          const condValue = condMap[condition.toLowerCase()] || '20';
          await page.select('select[name="condition"]', condValue);
          console.log('Set condition:', condition, '→', condValue);
        }
      }

      // Make / Manufacturer
      if (make) await fillField(page, 'input[name="make_manufacturer"]', make, 'make');
      // Model
      if (model) await fillField(page, 'input[name="model_name_number"]', model, 'model');
      // Phone
      if (phoneNumber) await fillField(page, 'input[name="contact_phone"]', phoneNumber, 'phone');

      console.log('Form filled, submitting...');

      // Submit the form — CL uses button.pickbutton on form pages too
      if (await clickContinueButton(page, 'form submit')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after form submit:', stage);
    }

    // =========================================================
    // Step 6b: Handle geoverify / map page if it appears
    // =========================================================
    if (stage === 'geoverify') {
      console.log('On geo-verify / map page');
      await updateJobStatus(jobId, 'processing', 'verifying_location');
      if (await clickContinueButton(page, 'geoverify continue')) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after geoverify:', stage);
    }

    // =========================================================
    // Step 7: Handle images (stage: editimage)
    // =========================================================
    if (stage === 'editimage') {
      await updateJobStatus(jobId, 'processing', 'uploading_images');
      console.log('On image upload page');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-images-'));
      let imagePaths = [];

      if (imageUrls && imageUrls.length > 0) {
        console.log(`Downloading ${imageUrls.length} images`);
        for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
          try {
            const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
            const imgPath = path.join(tmpDir, `image_${i}.${ext}`);
            await downloadImage(imageUrls[i], imgPath);
            imagePaths.push(imgPath);
            console.log(`Downloaded image ${i + 1}/${imageUrls.length}`);
          } catch (e) {
            console.error(`Image ${i} download failed:`, e.message);
          }
        }
      }
      console.log(`Total images to upload: ${imagePaths.length}`);

      // Upload images one at a time
      for (const imgPath of imagePaths) {
        try {
          // CL image upload uses an <input type="file"> element
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.uploadFile(imgPath);
            // Wait for upload to process
            await delay(3000);
            console.log(`Uploaded: ${path.basename(imgPath)}`);
          } else {
            console.log('No file input found on image page');
          }
          fs.unlinkSync(imgPath);
        } catch (e) {
          console.error('Image upload failed:', e.message);
          try { fs.unlinkSync(imgPath); } catch (_) {}
        }
      }
      try { fs.rmdirSync(tmpDir); } catch (_) {}

      // Click "done with images" — CL uses various selectors for this
      const doneSelectors = [
        'button.done',
        'button[value="done with images"]',
        'input[value="done with images"]',
        'a.done',
        'button.pickbutton',
        'button[type="submit"]',
      ];
      let doneClicked = false;
      for (const sel of doneSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const text = await btn.evaluate(el => el.textContent?.trim().toLowerCase() || el.value?.toLowerCase() || '');
          console.log(`Found done button: ${sel} (text: "${text}")`);
          await btn.click();
          doneClicked = true;
          break;
        }
      }
      if (doneClicked) {
        await safeWaitForNav(page);
        await delay(2000);
      }
      stage = await detectStage(page);
      console.log('Stage after images:', stage);
    }

    // =========================================================
    // Step 8: Preview page → publish
    // =========================================================
    if (stage === 'preview') {
      await updateJobStatus(jobId, 'processing', 'publishing');
      console.log('On preview page, clicking publish');

      // CL preview page has a publish/submit button
      const publishSelectors = [
        'button.pickbutton',
        'button[type="submit"]',
        'input[type="submit"]',
      ];
      for (const sel of publishSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const text = await btn.evaluate(el => el.textContent?.trim() || el.value || '');
          console.log(`Clicking publish via ${sel} (text: "${text}")`);
          await btn.click();
          await safeWaitForNav(page);
          break;
        }
      }
      await delay(3000);
      stage = await detectStage(page);
      console.log('Stage after publish:', stage);
    }

    // =========================================================
    // Step 9: Extract final URL / confirmation
    // =========================================================
    const finalUrl = page.url();
    let postUrl2 = finalUrl;

    // Try to find a link to the actual posting
    const confirmLink = await page.$('a[href*="/d/"], a.manageable-ad-link, a[href*="craigslist.org"][href*="/"]');
    if (confirmLink) {
      postUrl2 = await confirmLink.evaluate(el => el.href) || finalUrl;
    }

    console.log('Final URL:', finalUrl);
    console.log('Post URL:', postUrl2);
    console.log('Final stage:', stage);

    return { postUrl: postUrl2, success: true };
  } finally {
    await browser.close();
  }
}

// Helper to safely fill a form field (clear + type)
async function fillField(page, selector, value, fieldName) {
  if (!value) return;
  const el = await page.$(selector);
  if (el) {
    await el.click({ clickCount: 3 }); // Select all existing text
    await el.type(value);
    console.log(`Filled ${fieldName}: "${value.substring(0, 50)}${value.length > 50 ? '...' : ''}"`);
  } else {
    console.log(`Field not found: ${fieldName} (${selector})`);
  }
}

module.exports = { postToCraigslist };
