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
  'bicycles': 'for sale by owner',
  'bikes': 'for sale by owner',
  'bicycle': 'for sale by owner',
  'sporting': 'for sale by owner',
  'tools': 'for sale by owner',
  'appliances': 'for sale by owner',
  'clothing': 'for sale by owner',
  'collectibles': 'for sale by owner',
  'housing': 'housing offered',
  'real-estate': 'for sale by owner',
  'services': 'service offered',
  'service': 'service offered',
};

// Default logger (overridden when called from server.js)
const defaultLogger = { log: console.log, error: console.error };

// Delay helper
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Robust helper: wait for selector then return element
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

// Find the main "continue" / "pickbutton" button on wizard pages
async function findContinueButton(page) {
  const selectors = ['button.pickbutton', 'button[name="go"]', 'button[type="submit"]', 'input[type="submit"]'];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      const isVisible = await btn.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      });
      if (isVisible) return btn;
    }
  }
  return null;
}

// Safe page.evaluate with retries — the core fix for stale context errors.
// After CL navigation, the execution context can take time to stabilize.
// This retries page.evaluate() calls instead of failing immediately.
async function safeEvaluate(page, fn, args, log = defaultLogger, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (args !== undefined) {
        return await page.evaluate(fn, args);
      }
      return await page.evaluate(fn);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('Cannot find context') || msg.includes('Execution context') || msg.includes('Protocol error')) {
        log.log(`safeEvaluate attempt ${attempt}/${retries} failed: ${msg.substring(0, 80)}`);
        if (attempt < retries) {
          await delay(1000 + attempt * 500); // increasing backoff: 1.5s, 2s, 2.5s, 3s
          continue;
        }
      }
      throw e; // Non-context error or exhausted retries — rethrow
    }
  }
}

// Navigate to a new page by clicking, then wait for it to fully stabilize.
// CL's wizard does full-page navigations that destroy the execution context.
// We must wait until the NEW page's context is fully ready before returning.
async function clickAndNavigate(page, clickFn, description = 'navigation', timeout = 25000, log = defaultLogger) {
  const urlBefore = page.url();
  log.log(`Clicking for ${description} (current URL: ${urlBefore})...`);
  
  // Click the button — don't await navigation events, they race with context destruction
  try {
    await clickFn();
  } catch (e) {
    // Click itself can throw if the page navigates during the click — that's OK
    log.log(`Click threw (expected during navigation): ${e.message.substring(0, 80)}`);
  }
  
  // Give the browser time to start the navigation
  await delay(1000);
  
  // Poll until URL changes (CL wizard always changes the ?s= param)
  const start = Date.now();
  let urlChanged = false;
  while (Date.now() - start < timeout) {
    try {
      const currentUrl = page.url();
      if (currentUrl !== urlBefore) {
        log.log(`URL changed to: ${currentUrl}`);
        urlChanged = true;
        break;
      }
    } catch (e) {
      // page.url() can throw during navigation — just wait
    }
    await delay(500);
  }
  
  if (!urlChanged) {
    log.log(`WARNING: URL did not change after ${timeout}ms`);
  }
  
  // Critical: wait for the NEW page's execution context to be ready.
  // After CL navigation, the old context is destroyed and a new one is created.
  // We must wait until page.evaluate() actually works.
  log.log('Waiting for new page context to stabilize...');
  await delay(2000); // Give CL's JS time to initialize
  
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      // This is the real test — can we run JS in the page?
      const title = await page.evaluate(() => document.title);
      log.log(`Page context ready (attempt ${attempt}): "${title}"`);
      return; // Success — context is usable
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('context') || msg.includes('destroyed') || msg.includes('Protocol error') || msg.includes('Cannot find')) {
        log.log(`Context not ready yet (attempt ${attempt}/8): ${msg.substring(0, 60)}`);
        await delay(1000 + attempt * 500); // 1.5s, 2s, 2.5s, 3s, 3.5s, 4s, 4.5s, 5s
      } else {
        throw e; // Unexpected error
      }
    }
  }
  
  // If we get here, context never stabilized — log but don't throw,
  // let the caller's safeEvaluate handle the retry
  log.log('WARNING: Page context did not stabilize after 8 attempts, proceeding anyway');
}

// Select a radio button by matching label text (case-insensitive, trimmed)
// IMPORTANT: On CL wizard pages, clicking a radio label can IMMEDIATELY trigger
// form submission/navigation. So we ONLY check the radio — we do NOT click the label.
// The actual form submission is handled separately by findContinueButton + clickAndNavigate.
async function selectRadioByLabelText(page, targetText, description, log = defaultLogger) {
  // Step 1: Just CHECK the radio button — NO click, NO change event dispatch.
  // CL's JS listens for both click and change events and auto-submits the form,
  // which navigates the page and destroys the execution context.
  // We only set .checked = true, then the continue button handles submission.
  const selected = await safeEvaluate(page, (target) => {
    const labels = document.querySelectorAll('form.picker label, .selection-list label');
    for (const label of labels) {
      const text = label.textContent.trim().toLowerCase();
      if (text === target.toLowerCase()) {
        const radio = label.querySelector('input[type="radio"]');
        if (radio) {
          radio.checked = true;
          // DO NOT dispatch events or click — CL auto-submits on these
          return text;
        }
      }
    }
    return null;
  }, targetText, log);

  if (selected) {
    log.log(`Selected ${description}: "${selected}"`);
    return true;
  }

  // Fallback: partial match
  const partial = await safeEvaluate(page, (target) => {
    const labels = document.querySelectorAll('form.picker label, .selection-list label');
    for (const label of labels) {
      const text = label.textContent.trim().toLowerCase();
      if (text.includes(target.toLowerCase())) {
        const radio = label.querySelector('input[type="radio"]');
        if (radio) {
          radio.checked = true;
          // DO NOT dispatch events or click
          return text;
        }
      }
    }
    return null;
  }, targetText, log);

  if (partial) {
    log.log(`Selected ${description} (partial match): "${partial}"`);
    return true;
  }

  log.log(`Could not find ${description} matching "${targetText}"`);
  return false;
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

// Detect which wizard stage we're on — uses safeEvaluate for resilience
async function detectStage(page, log = defaultLogger) {
  return await safeEvaluate(page, () => {
    const body = document.body;
    const classes = body.className || '';
    const stages = ['copyfromanother', 'subarea', 'hood', 'type', 'cat', 'edit', 'geoverify', 'editimage', 'preview', 'finalize'];
    for (const s of stages) {
      if (classes.includes(s)) return s;
    }
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
  }, undefined, log);
}

// Capture debug info from current page for error context
async function capturePageDebug(page, log) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '(unknown)');
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '(unavailable)');
    log.error(`[DEBUG] URL: ${url}`);
    log.error(`[DEBUG] Title: ${title}`);
    log.error(`[DEBUG] Body: ${bodyText}`);
    const screenshotPath = path.join(os.tmpdir(), `cl-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    log.error(`[DEBUG] Screenshot saved: ${screenshotPath}`);
  } catch (e) {
    log.error('[DEBUG] Failed to capture page debug:', e.message);
  }
}

async function postToCraigslist({ jobId, adData, proxyConfig, targetCity, credentials, updateJobStatus, logger }) {
  const log = logger || defaultLogger;
  const { title, price, description, category, condition, make, model, imageUrls, phoneNumber, email, sourceUrl } = adData;
  const cityKey = targetCity || 'orangecounty';
  const cityInfo = CITY_MAP[cityKey] || CITY_MAP['orangecounty'];
  const baseUrl = cityInfo.base;
  const areaCode = cityInfo.code;
  const postingType = TYPE_MAP[(category || '').toLowerCase()] || TYPE_MAP[category] || 'for sale by owner';

  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--window-size=1280,900', '--disable-blink-features=AutomationControlled',
    '--disable-features=site-per-process', // Prevent cross-process iframes from creating context issues
  ];
  if (proxyConfig && proxyConfig.host) {
    launchArgs.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs, defaultViewport: { width: 1280, height: 900 } });

  try {
    const page = await browser.newPage();

    // Evade bot detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    if (proxyConfig && proxyConfig.username) {
      await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // =========================================================
    // Step 1: Navigate directly to the CL posting wizard
    // =========================================================
    await updateJobStatus(jobId, 'processing', 'navigating');
    const postUrl = `https://post.craigslist.org/c/${areaCode}`;
    log.log('Navigating directly to posting wizard:', postUrl);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
    log.log('Wizard URL:', page.url());

    let stage = await detectStage(page, log);
    log.log('Detected initial stage:', stage);

    // =========================================================
    // Handle login redirect if needed
    // =========================================================
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.craigslist.org/login')) {
      log.log('Login required — attempting to log in');
      await updateJobStatus(jobId, 'processing', 'logging_in');

      const loginEmail = (credentials && credentials.email) || process.env.CL_EMAIL;
      const loginPassword = (credentials && credentials.password) || process.env.CL_PASSWORD;

      if (!loginEmail || !loginPassword) {
        await capturePageDebug(page, log);
        throw new Error('Login required but no credentials provided (pass credentials object or set CL_EMAIL/CL_PASSWORD env vars)');
      }

      const emailInput = await page.$('input[name="inputEmailHandle"]');
      if (emailInput) {
        await emailInput.type(loginEmail);
        const pwInput = await page.$('input[name="inputPassword"]');
        if (pwInput) {
          await pwInput.type(loginPassword);
          const loginBtn = await page.$('button[type="submit"]');
          if (loginBtn) {
            await clickAndNavigate(page, () => loginBtn.click(), 'login submit', 15000, log);
          }
        }
      }
      log.log('After login URL:', page.url());
      stage = await detectStage(page, log);
      log.log('Stage after login:', stage);
    }

    // =========================================================
    // Step 2: Handle "copy from previous" page if it appears
    // =========================================================
    if (stage === 'copyfromanother') {
      log.log('On copy-from-another page, looking for skip/new option');
      const newPostLink = await page.$('a[href*="new"], button[name="skip"]');
      if (newPostLink) {
        await clickAndNavigate(page, () => newPostLink.click(), 'skip copy-from-another', 15000, log);
      } else {
        const btn = await findContinueButton(page);
        if (btn) {
          await clickAndNavigate(page, () => btn.click(), 'skip copy-from-another', 15000, log);
        }
      }
      stage = await detectStage(page, log);
      log.log('Stage after skip:', stage);
    }

    // =========================================================
    // Step 3: Handle subarea selection if it appears
    // =========================================================
    if (stage === 'subarea') {
      log.log('On subarea selection page');
      await updateJobStatus(jobId, 'processing', 'selecting_area');
      const firstRadio = await page.$('form.picker input[type="radio"]');
      if (firstRadio) {
        await firstRadio.click();
        log.log('Selected first subarea');
      }
      const btn = await findContinueButton(page);
      if (btn) {
        await clickAndNavigate(page, () => btn.click(), 'subarea continue', 15000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after subarea:', stage);
    }

    // =========================================================
    // Step 3b: Handle neighborhood (hood) selection if it appears
    // =========================================================
    if (stage === 'hood') {
      log.log('On neighborhood selection page');
      const firstRadio = await page.$('form.picker input[type="radio"]');
      if (firstRadio) {
        await firstRadio.click();
      }
      const btn = await findContinueButton(page);
      if (btn) {
        await clickAndNavigate(page, () => btn.click(), 'hood continue', 15000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after hood:', stage);
    }

    // =========================================================
    // Step 4: Choose type (e.g. "for sale by owner")
    // =========================================================
    if (stage === 'type') {
      await updateJobStatus(jobId, 'processing', 'selecting_type');
      log.log(`Selecting posting type: "${postingType}"`);
      await selectRadioByLabelText(page, postingType, 'posting type', log);
      const btn = await findContinueButton(page);
      if (btn) {
        await clickAndNavigate(page, () => btn.click(), 'type→cat navigation', 25000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after type:', stage);
    }

    // =========================================================
    // Step 5: Choose category
    // =========================================================
    if (stage === 'cat') {
      await updateJobStatus(jobId, 'processing', 'selecting_category');
      const catKeyword = (category || 'general').toLowerCase();
      log.log(`Selecting category matching: "${catKeyword}"`);

      let found = await selectRadioByLabelText(page, catKeyword, 'category', log);
      if (!found) {
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
          'services': 'household services',
          'service': 'household services',
        };
        const alias = catAliases[catKeyword] || catKeyword;
        if (alias !== catKeyword) {
          found = await selectRadioByLabelText(page, alias, 'category (alias)', log);
        }
      }
      if (!found) {
        // Last resort: select first available radio
        // Only set .checked — DO NOT dispatch events or click labels.
        // CL's JS auto-submits on change/click, destroying the execution context.
        await safeEvaluate(page, () => {
          const radio = document.querySelector('form.picker input[type="radio"]');
          if (radio) {
            radio.checked = true;
          }
        }, undefined, log);
        log.log('Selected first available category as fallback');
      }

      const catBtn = await findContinueButton(page);
      if (catBtn) {
        await clickAndNavigate(page, () => catBtn.click(), 'category→edit navigation', 25000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after category:', stage);
    }

    // =========================================================
    // Step 6: Fill the posting form (stage: edit)
    // =========================================================
    if (stage === 'edit') {
      await updateJobStatus(jobId, 'processing', 'filling_form');
      log.log('Filling posting form...');

      await page.waitForSelector('input[name="PostingTitle"], #PostingTitle', { timeout: 15000 }).catch(() => {
        log.log('Warning: PostingTitle field not found within timeout');
      });

      await fillField(page, 'input[name="PostingTitle"]', title || 'Item for Sale', 'title', log);
      await fillField(page, 'input[name="price"]', String(price || ''), 'price', log);
      await fillField(page, 'textarea[name="PostingBody"]', description || '', 'description', log);
      await fillField(page, 'input[name="postal"]', adData.zip || adData.zipCode || '92694', 'zip', log);

      if (condition) {
        const condSelect = await page.$('select[name="condition"]');
        if (condSelect) {
          const condMap = { 'new': '10', 'like new': '20', 'excellent': '30', 'good': '40', 'fair': '50', 'salvage': '60' };
          const condValue = condMap[condition.toLowerCase()] || '20';
          await page.select('select[name="condition"]', condValue);
          log.log('Set condition:', condition, '→', condValue);
        }
      }

      if (make) await fillField(page, 'input[name="make_manufacturer"]', make, 'make', log);
      if (model) await fillField(page, 'input[name="model_name_number"]', model, 'model', log);
      if (phoneNumber) await fillField(page, 'input[name="contact_phone"]', phoneNumber, 'phone', log);

      log.log('Form filled, submitting...');

      const submitBtn = await findContinueButton(page);
      if (submitBtn) {
        await clickAndNavigate(page, () => submitBtn.click(), 'form submit', 20000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after form submit:', stage);
    }

    // =========================================================
    // Step 6b: Handle geoverify / map page if it appears
    // =========================================================
    if (stage === 'geoverify') {
      log.log('On geo-verify / map page');
      await updateJobStatus(jobId, 'processing', 'verifying_location');
      const geoBtn = await findContinueButton(page);
      if (geoBtn) {
        await clickAndNavigate(page, () => geoBtn.click(), 'geoverify continue', 20000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after geoverify:', stage);
    }

    // =========================================================
    // Step 7: Handle images (stage: editimage)
    // =========================================================
    if (stage === 'editimage') {
      await updateJobStatus(jobId, 'processing', 'uploading_images');
      log.log('On image upload page');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-images-'));
      let imagePaths = [];

      if (imageUrls && imageUrls.length > 0) {
        log.log(`Downloading ${imageUrls.length} images`);
        for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
          try {
            const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
            const imgPath = path.join(tmpDir, `image_${i}.${ext}`);
            await downloadImage(imageUrls[i], imgPath);
            imagePaths.push(imgPath);
            log.log(`Downloaded image ${i + 1}/${imageUrls.length}`);
          } catch (e) {
            log.error(`Image ${i} download failed:`, e.message);
          }
        }
      }
      log.log(`Total images to upload: ${imagePaths.length}`);

      for (const imgPath of imagePaths) {
        try {
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.uploadFile(imgPath);
            await delay(3000);
            log.log(`Uploaded: ${path.basename(imgPath)}`);
          } else {
            log.log('No file input found on image page');
          }
          fs.unlinkSync(imgPath);
        } catch (e) {
          log.error('Image upload failed:', e.message);
          try { fs.unlinkSync(imgPath); } catch (_) {}
        }
      }
      try { fs.rmdirSync(tmpDir); } catch (_) {}

      const doneSelectors = [
        'button.done',
        'button[value="done with images"]',
        'input[value="done with images"]',
        'a.done',
        'button.pickbutton',
        'button[type="submit"]',
      ];
      let doneBtn = null;
      for (const sel of doneSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const text = await btn.evaluate(el => el.textContent?.trim().toLowerCase() || el.value?.toLowerCase() || '');
          log.log(`Found done button: ${sel} (text: "${text}")`);
          doneBtn = btn;
          break;
        }
      }
      if (doneBtn) {
        await clickAndNavigate(page, () => doneBtn.click(), 'done with images', 15000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after images:', stage);
    }

    // =========================================================
    // Step 8: Preview page → publish
    // =========================================================
    if (stage === 'preview') {
      await updateJobStatus(jobId, 'processing', 'publishing');
      log.log('On preview page, clicking publish');

      const publishSelectors = [
        'button.pickbutton',
        'button[type="submit"]',
        'input[type="submit"]',
      ];
      for (const sel of publishSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const text = await btn.evaluate(el => el.textContent?.trim() || el.value || '');
          log.log(`Clicking publish via ${sel} (text: "${text}")`);
          await clickAndNavigate(page, () => btn.click(), 'publish', 20000, log);
          break;
        }
      }
      await delay(1500);
      stage = await detectStage(page, log);
      log.log('Stage after publish:', stage);
    }

    // =========================================================
    // Step 9: Extract final URL / confirmation
    // =========================================================
    const finalUrl = page.url();
    let postUrl2 = finalUrl;

    const confirmLink = await page.$('a[href*="/d/"], a.manageable-ad-link, a[href*="craigslist.org"][href*="/"]');
    if (confirmLink) {
      postUrl2 = await confirmLink.evaluate(el => el.href) || finalUrl;
    }

    log.log('Final URL:', finalUrl);
    log.log('Post URL:', postUrl2);
    log.log('Final stage:', stage);

    return { postUrl: postUrl2, success: true };
  } catch (err) {
    // Capture debug info on any failure before re-throwing
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        await capturePageDebug(pages[pages.length - 1], logger || defaultLogger);
      }
    } catch (_) {}
    throw err;
  } finally {
    await browser.close();
  }
}

// Helper to safely fill a form field (clear + type)
async function fillField(page, selector, value, fieldName, log = defaultLogger) {
  if (!value) return;
  const el = await page.$(selector);
  if (el) {
    await el.click({ clickCount: 3 });
    await el.type(value);
    log.log(`Filled ${fieldName}: "${value.substring(0, 50)}${value.length > 50 ? '...' : ''}"`);
  } else {
    log.log(`Field not found: ${fieldName} (${selector})`);
  }
}

module.exports = { postToCraigslist };
