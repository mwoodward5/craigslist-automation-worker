const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getClSubdomainForZip, validateZipForCity } = require('./zipLookup');

// Known CL area codes for the posting wizard URL (https://post.craigslist.org/c/{code}).
// These are verified codes that may differ from the subdomain.
// If a city isn't here, we fall back to the first 3 chars of the subdomain.
const KNOWN_AREA_CODES = {
  'orangecounty': 'orc', 'losangeles': 'lac', 'sfbay': 'sfc',
  'sandiego': 'sdo', 'inlandempire': 'iee', 'newyork': 'nyc',
  'chicago': 'chi', 'boston': 'bos', 'seattle': 'sea',
  'portland': 'pdx', 'dallas': 'dal', 'houston': 'hou',
  'atlanta': 'atl', 'detroit': 'det', 'denver': 'den',
  'phoenix': 'phx', 'minneapolis': 'min', 'miami': 'mia',
  'tampa': 'tpa', 'philadelphia': 'phi', 'washingtondc': 'wdc',
  'sacramento': 'sac', 'sandiego': 'sdo', 'austin': 'aus',
  'nashville': 'nas', 'stlouis': 'stl', 'kansascity': 'kan',
  'orlando': 'orl', 'jacksonville': 'jax', 'raleigh': 'ral',
  'charlotte': 'cha', 'columbus': 'col', 'cleveland': 'cle',
  'pittsburgh': 'pit', 'indianapolis': 'ind', 'sanantonio': 'sat',
};

// Build default zips per subdomain from ArcGIS data
const { ZIP_TO_CL } = require('./zipLookup');
const _subdomainZips = {};
for (const [zip, sub] of Object.entries(ZIP_TO_CL)) {
  if (!_subdomainZips[sub]) _subdomainZips[sub] = [];
  _subdomainZips[sub].push(zip);
}

/**
 * Get city info for any CL subdomain. Uses ArcGIS data for zip defaults.
 * Works for ALL ~400 CL cities, not just a hardcoded list.
 */
function getCityInfo(subdomain) {
  const zips = _subdomainZips[subdomain];
  const defaultZip = zips ? zips[Math.floor(zips.length / 2)] : '92694';
  return {
    base: `https://${subdomain}.craigslist.org`,
    code: KNOWN_AREA_CODES[subdomain] || subdomain.substring(0, 3),
    zip: defaultZip
  };
}

// Map category to the radio button label text on CL wizard "choose type" page.
// Supports both human-readable names AND CL path codes (fso, bfs, cto, etc.)
const TYPE_MAP = {
  // Human-readable names
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
  // CL path codes (sent by frontend)
  'fso': 'for sale by owner',      // for sale by owner
  'fsd': 'for sale by dealer',     // for sale by dealer
  'bfs': 'service offered',        // business/financial services
  'cto': 'for sale by owner',      // cars & trucks - by owner
  'ctd': 'for sale by dealer',     // cars & trucks - by dealer
  'mco': 'for sale by owner',      // motorcycles - by owner
  'mcd': 'for sale by dealer',     // motorcycles - by dealer
  'apa': 'housing offered',        // apartments / housing for rent
  'hou': 'housing offered',        // housing
  'rea': 'housing offered',        // real estate
  'gig': 'gig offered',            // gigs
  'com': 'community',              // community
  'eve': 'event / class',          // events
  'rid': 'community',              // rideshare
  // Frontend QuickPostModal dropdown values (exact match)
  'for-sale-general': 'for sale by owner',
  'sporting-goods': 'for sale by owner',
  'apts-housing': 'housing offered',
  'rooms-shares': 'housing offered',
  'vacation-rentals': 'housing offered',
  'office-commercial': 'housing offered',
  'services-household': 'service offered',
  'services-labor': 'service offered',
  'services-automotive': 'service offered',
  'jobs-general': 'job offered',
  'community-general': 'community',
  'cars-trucks': 'for sale by owner',
  'motorcycles': 'for sale by owner',
  'gigs': 'gig offered',
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
      if (isVisible) {
        // Scroll button into view to ensure it's clickable (CL forms can be long)
        await btn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await new Promise(r => setTimeout(r, 300));
        return btn;
      }
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
// IMPORTANT: Check longer/more-specific names BEFORE substrings.
// e.g. 'editimage' must be checked before 'edit' since 'editimage'.includes('edit') === true
async function detectStage(page, log = defaultLogger) {
  return await safeEvaluate(page, () => {
    // Most reliable: check the URL's ?s= parameter
    const url = window.location.href;
    const sMatch = url.match(/[?&]s=([a-zA-Z]+)/);
    if (sMatch) {
      const sParam = sMatch[1].toLowerCase();
      const knownStages = ['copyfromanother', 'subarea', 'hood', 'type', 'cat', 'editimage', 'edit', 'geoverify', 'preview', 'finalize', 'loginloop'];
      for (const s of knownStages) {
        if (sParam === s) return s;
      }
    }

    // Fallback: check body class — LONGER names first to avoid substring matches
    const body = document.body;
    const classes = body.className || '';
    const stages = ['copyfromanother', 'editimage', 'subarea', 'hood', 'type', 'cat', 'geoverify', 'loginloop', 'preview', 'finalize', 'edit'];
    for (const s of stages) {
      if (classes.includes(s)) return s;
    }

    // Fallback: check page title
    const title = document.title.toLowerCase();
    if (title.includes('choose type')) return 'type';
    if (title.includes('choose category')) return 'cat';
    if (title.includes('choose nearest area') || title.includes('choose area')) return 'subarea';
    if (title.includes('choose neighborhood')) return 'hood';
    if (title.includes('copy from')) return 'copyfromanother';
    if (title.includes('choose images') || title.includes('add images')) return 'editimage';
    if (title.includes('edit posting') || title.includes('posting details')) return 'edit';
    if (title.includes('verify') || title.includes('add map')) return 'geoverify';
    if (title.includes('preview')) return 'preview';
    if (title.includes('email confirmation') || title.includes('further action')) return 'loginloop';
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
  const { title, price, description, category, categoryName, condition, make, model, imageUrls, phoneNumber, email, sourceUrl, subarea } = adData;
  const cityKey = targetCity || 'orangecounty';
  const cityInfo = getCityInfo(cityKey);
  const baseUrl = cityInfo.base;
  const areaCode = cityInfo.code;
  const postingType = TYPE_MAP[(category || '').toLowerCase()] || TYPE_MAP[category] || 'for sale by owner';

  log.log(`[v2.16.0] Posting to ${cityKey} (${baseUrl}), area=${areaCode}, subarea=${subarea || 'auto'}, category=${category}, categoryName=${categoryName || 'n/a'}, type=${postingType}`);
  log.log(`[v2.16.0] Title: "${(title || '').substring(0, 60)}", images=${(imageUrls || []).length}, zip=${adData.zipCode || 'default'}`);
  log.log(`[v2.16.0] proxyConfig received: ${JSON.stringify(proxyConfig || 'NONE')}`);

  // ── Resolve proxy credentials ──
  // Frontend sends { state: 'california', sessionType: 'sticky' }.
  // Decodo proxy geo-targeting uses USERNAME PARAMETERS on gate.decodo.com:7000.
  // Docs: https://help.decodo.com/docs/residential-proxy-user-pass-requests
  // Format: user-USERNAME-country-us-state-us_STATE-session-SESSIONID-sessionduration-30
  // This is the ONLY reliable method — state.decodo.com endpoint does NOT work.

  // Map state names to Decodo state parameter format (us_statename)
  const DECODO_STATE_MAP = {
    alabama: 'us_alabama', alaska: 'us_alaska', arizona: 'us_arizona', arkansas: 'us_arkansas',
    california: 'us_california', colorado: 'us_colorado', connecticut: 'us_connecticut', delaware: 'us_delaware',
    florida: 'us_florida', georgia: 'us_georgia', hawaii: 'us_hawaii', idaho: 'us_idaho',
    illinois: 'us_illinois', indiana: 'us_indiana', iowa: 'us_iowa', kansas: 'us_kansas',
    kentucky: 'us_kentucky', louisiana: 'us_louisiana', maine: 'us_maine', maryland: 'us_maryland',
    massachusetts: 'us_massachusetts', michigan: 'us_michigan', minnesota: 'us_minnesota', mississippi: 'us_mississippi',
    missouri: 'us_missouri', montana: 'us_montana', nebraska: 'us_nebraska', nevada: 'us_nevada',
    new_hampshire: 'us_new_hampshire', new_jersey: 'us_new_jersey', new_mexico: 'us_new_mexico', new_york: 'us_new_york',
    north_carolina: 'us_north_carolina', north_dakota: 'us_north_dakota', ohio: 'us_ohio', oklahoma: 'us_oklahoma',
    oregon: 'us_oregon', pennsylvania: 'us_pennsylvania', rhode_island: 'us_rhode_island', south_carolina: 'us_south_carolina',
    south_dakota: 'us_south_dakota', tennessee: 'us_tennessee', texas: 'us_texas', utah: 'us_utah',
    vermont: 'us_vermont', virginia: 'us_virginia', washington: 'us_washington', west_virginia: 'us_west_virginia',
    wisconsin: 'us_wisconsin', wyoming: 'us_wyoming', district_of_columbia: 'us_district_of_columbia',
  };

  // Map CL city subdomains to target cities for city-level proxy targeting
  const CL_CITY_TO_PROXY_CITY = {
    losangeles: 'los_angeles', sfbay: 'san_francisco', sandiego: 'san_diego',
    orangecounty: 'los_angeles', inlandempire: 'los_angeles',
    newyork: 'new_york', chicago: 'chicago', houston: 'houston',
    dallas: 'dallas', miami: 'miami', atlanta: 'atlanta', seattle: 'seattle',
    boston: 'boston', phoenix: 'phoenix', denver: 'denver', portland: 'portland',
    detroit: 'detroit', minneapolis: 'minneapolis', philadelphia: 'philadelphia',
    washingtondc: 'washington', sacramento: 'sacramento', austin: 'austin',
    nashville: 'nashville', tampa: 'tampa', orlando: 'orlando',
    charlotte: 'charlotte', columbus: 'columbus', cleveland: 'cleveland',
    pittsburgh: 'pittsburgh', indianapolis: 'indianapolis', sanantonio: 'san_antonio',
    stlouis: 'saint_louis', kansascity: 'kansas_city', raleigh: 'raleigh',
    jacksonville: 'jacksonville', lasvegas: 'las_vegas',
  };

  let resolvedProxy = null;
  if (proxyConfig && proxyConfig.host) {
    // Already resolved (host/port/username/password) — use as-is
    resolvedProxy = proxyConfig;
  } else if (proxyConfig && proxyConfig.state) {
    // Frontend sent { state, sessionType } — build Decodo credentials with username parameters
    const proxyUser = process.env.DECODO_PROXY_USER;
    const proxyPass = process.env.DECODO_PROXY_PASS;
    if (proxyUser && proxyPass) {
      const stateKey = (proxyConfig.state || 'california').toLowerCase().replace(/ /g, '_');
      const decodoPart = DECODO_STATE_MAP[stateKey] || 'us_california';
      // Generate a unique session ID for sticky sessions (CL needs consistent IP during posting)
      const sessionId = `adclimber_${jobId || Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      // Build the full username with geo-targeting parameters
      // Format: user-PROXYUSER-country-us-state-STATE-session-SESSIONID-sessionduration-30
      let usernameParams = `user-${proxyUser}-country-us-state-${decodoPart}`;
      // Add city-level targeting if we can map the target CL city
      const proxyCity = CL_CITY_TO_PROXY_CITY[(cityKey || '').toLowerCase()];
      if (proxyCity) {
        usernameParams += `-city-${proxyCity}`;
        log.log(`[PROXY] Adding city-level targeting: ${proxyCity}`);
      }
      usernameParams += `-session-${sessionId}-sessionduration-30`;
      resolvedProxy = {
        host: 'gate.decodo.com',
        port: 7000,
        username: usernameParams,
        password: proxyPass
      };
      log.log(`[PROXY] Decodo username-param targeting: gate.decodo.com:7000`);
      log.log(`[PROXY] Username: ${usernameParams.substring(0, 80)}...`);
      log.log(`[PROXY] State: ${decodoPart}, City: ${proxyCity || 'none'}, Session: ${sessionId}`);
    } else {
      log.log(`[PROXY] WARNING — proxyConfig has state "${proxyConfig.state}" but DECODO env vars missing! user=${!!proxyUser} pass=${!!proxyPass}`);
    }
  }

  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--window-size=1280,900', '--disable-blink-features=AutomationControlled',
    '--disable-features=site-per-process', // Prevent cross-process iframes from creating context issues
  ];
  if (resolvedProxy && resolvedProxy.host) {
    launchArgs.push(`--proxy-server=${resolvedProxy.host}:${resolvedProxy.port}`);
    log.log(`[PROXY] Active — ${resolvedProxy.host}:${resolvedProxy.port} (user: ${resolvedProxy.username ? 'yes' : 'no'})`);
  } else {
    log.log('[PROXY] WARNING — No proxy configured! CL will geolocate to Railway datacenter IP. Posts may redirect to wrong region.');
  }

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs, defaultViewport: { width: 1280, height: 900 } });

  try {
    const page = await browser.newPage();

    // Evade bot detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    if (resolvedProxy && resolvedProxy.username) {
      await page.authenticate({ username: resolvedProxy.username, password: resolvedProxy.password });
      log.log(`[PROXY] Authenticated with Decodo user credentials`);
    }
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ── Verify proxy IP location before posting ──
    if (resolvedProxy && resolvedProxy.host) {
      try {
        log.log('[PROXY] Verifying IP geolocation...');
        await page.goto('https://ip.decodo.com/json', { waitUntil: 'networkidle2', timeout: 15000 });
        const ipInfo = await page.evaluate(() => {
          try { return JSON.parse(document.body.innerText); } catch { return { raw: document.body.innerText.substring(0, 500) }; }
        });
        log.log(`[PROXY] IP check result: ${JSON.stringify(ipInfo).substring(0, 500)}`);
        // Decodo's ip.decodo.com/json returns nested structure: { isp: {...}, city: { name, code }, country: { name, code }, ip }
        const ipCity = (ipInfo.city && ipInfo.city.name) || ipInfo.city || 'unknown';
        const ipState = (ipInfo.city && ipInfo.city.code) || ipInfo.region || ipInfo.state || 'unknown';
        const ipCountry = (ipInfo.country && ipInfo.country.name) || ipInfo.country || 'unknown';
        const ipCountryCode = (ipInfo.country && ipInfo.country.code) || ipInfo.country_code || '';
        const ipISP = (ipInfo.isp && ipInfo.isp.isp) || 'unknown';
        log.log(`[PROXY] GEO: ${ipCity}, ${ipState}, ${ipCountry} (${ipCountryCode}) via ${ipISP}`);
        if (ipCountryCode && ipCountryCode !== 'US') {
          log.log(`[PROXY] WARNING: IP is in ${ipCountry} (${ipCountryCode}), NOT in US! Proxy geo-targeting may not be working.`);
        } else {
          log.log(`[PROXY] Confirmed: US residential IP in ${ipCity}, ${ipState}`);
        }
      } catch (ipErr) {
        log.log(`[PROXY] IP verification failed (non-fatal): ${ipErr.message.substring(0, 100)}`);
      }
    }

    // =========================================================
    // Step 1: Navigate directly to the CL posting wizard
    // =========================================================
    await updateJobStatus(jobId, 'processing', 'navigating');
    const postUrl = `https://post.craigslist.org/c/${areaCode}`;
    log.log('Navigating directly to posting wizard:', postUrl);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
    const wizardUrl = page.url();
    const wizardTitle = await page.title().catch(() => '(unknown)');
    log.log(`Wizard URL: ${wizardUrl}`);
    log.log(`Wizard title: ${wizardTitle}`);

    // Check for CL region redirect — if CL sends us to the wrong region (e.g. "aberdeen")
    // based on the server's IP geolocation, log a warning.
    if (wizardTitle && !wizardTitle.toLowerCase().includes(cityKey.replace(/county|empire|bay/gi, '').trim().substring(0, 5))) {
      log.log(`WARNING: Page title "${wizardTitle}" may not match target city "${cityKey}". CL may have redirected based on server IP.`);
    }

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
    // Step 3: Handle area/subarea selection if it appears
    // CL can show TWO different area pages:
    //   a) Top-level area dropdown (<select name="n">) — "which city/area would you like to post to?"
    //      This appears when CL can't determine the region from the URL/IP.
    //   b) Subarea radio buttons — "choose nearest area" within a city (e.g. LA subareas)
    // =========================================================
    if (stage === 'subarea') {
      log.log('On area/subarea selection page');
      await updateJobStatus(jobId, 'processing', 'selecting_area');

      // Check if this is a top-level AREA dropdown page (select name="n")
      const hasAreaDropdown = await safeEvaluate(page, () => {
        return !!document.querySelector('select[name="n"]');
      }, undefined, log).catch(() => false);

      if (hasAreaDropdown) {
        // ── Top-level area dropdown: select the correct CL city ──
        log.log('[AREA] Found top-level area dropdown — selecting target city');
        const targetName = (cityKey || '').toLowerCase();

        // Map CL subdomain names to how they appear in the dropdown
        const CITY_DROPDOWN_NAMES = {
          losangeles: 'los angeles', sfbay: 'SF bay area', sandiego: 'san diego',
          orangecounty: 'orange county', inlandempire: 'inland empire',
          newyork: 'new york city', chicago: 'chicago', houston: 'houston',
          dallas: 'dallas / fort worth', miami: 'south florida',
          atlanta: 'atlanta', seattle: 'seattle-tacoma', boston: 'boston',
          phoenix: 'phoenix', denver: 'denver', portland: 'portland',
          detroit: 'detroit metro', minneapolis: 'minneapolis / st paul',
          philadelphia: 'philadelphia', washingtondc: 'washington, DC',
          sacramento: 'sacramento', austin: 'austin', nashville: 'nashville',
          tampa: 'tampa bay area', orlando: 'orlando', charlotte: 'charlotte',
          columbus: 'columbus', cleveland: 'cleveland', pittsburgh: 'pittsburgh',
          indianapolis: 'indianapolis', sanantonio: 'san antonio',
          stlouis: 'st louis', kansascity: 'kansas city', raleigh: 'raleigh',
          jacksonville: 'jacksonville', lasvegas: 'las vegas',
          tucson: 'tucson', honolulu: 'honolulu', reno: 'reno / tahoe',
          saltlakecity: 'salt lake city', albuquerque: 'albuquerque',
          memphis: 'memphis', richmond: 'richmond', norfolk: 'norfolk',
          fresno: 'fresno / madera', bakersfield: 'bakersfield',
          stockton: 'stockton', modesto: 'modesto', santabarbara: 'santa barbara',
          ventura: 'ventura county', santacruz: 'santa cruz',
        };

        const dropdownTarget = CITY_DROPDOWN_NAMES[targetName] || targetName.replace(/county|empire|bay/gi, '').trim();
        log.log(`[AREA] Looking for "${dropdownTarget}" in area dropdown`);

        // First, find the matching option value (don't set it yet — use page.select later)
        const matchResult = await safeEvaluate(page, (searchName) => {
          const select = document.querySelector('select[name="n"]');
          if (!select) return { found: false, error: 'no select element' };
          const options = Array.from(select.options);
          const search = searchName.toLowerCase();

          let match = options.find(o => o.textContent.trim().toLowerCase() === search);
          if (!match) match = options.find(o => o.textContent.trim().toLowerCase().startsWith(search));
          if (!match) match = options.find(o => o.textContent.trim().toLowerCase().includes(search));

          if (match) return { found: true, value: match.value, text: match.textContent.trim() };
          return { found: false, options: options.slice(0, 10).map(o => o.textContent.trim()) };
        }, dropdownTarget, log);
        log.log(`[AREA] Dropdown match result: ${JSON.stringify(matchResult)}`);

        if (matchResult && matchResult.found) {
          // Use Puppeteer's page.select() — properly fires all DOM events CL expects
          await page.select('select[name="n"]', matchResult.value);
          await delay(300 + Math.random() * 200);
          log.log(`[AREA] Selected: "${matchResult.text}" (value=${matchResult.value}) via page.select()`);
        } else {
          log.log(`[AREA] WARNING: Could not find "${dropdownTarget}" in dropdown! Available: ${JSON.stringify(matchResult?.options || [])}`);
        }

        // Submit the form
        const btn = await findContinueButton(page);
        if (btn) {
          await clickAndNavigate(page, () => btn.click(), 'area dropdown submit', 20000, log);
        }
        stage = await detectStage(page, log);
        log.log('[AREA] Stage after area selection:', stage);

        // After selecting the top-level area, CL may show subareas next
        // Fall through to the radio button handler below
      }

      // ── Subarea radio buttons (within a city) ──
      if (stage === 'subarea') {
        // Check for radio buttons (not dropdown — we already handled that above)
        const hasRadios = await safeEvaluate(page, () => {
          return document.querySelectorAll('form.picker input[type="radio"]').length;
        }, undefined, log).catch(() => 0);

        if (hasRadios > 0) {
          log.log(`On subarea radio selection page (${hasRadios} options)`);
          const availableSubareas = await safeEvaluate(page, () => {
            const radios = document.querySelectorAll('form.picker input[type="radio"]');
            return Array.from(radios).map(r => {
              const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
              return { value: r.value || '', id: r.id || '', labelText: label ? label.textContent.trim() : '' };
            });
          }, undefined, log).catch(() => []);
          log.log(`Available subareas: ${JSON.stringify(availableSubareas)}`);
          log.log(`Requested subarea from frontend: ${subarea || '(none — will pick first)'}`);

          const selectedSub = await safeEvaluate(page, (requestedSubarea) => {
            const radios = Array.from(document.querySelectorAll('form.picker input[type="radio"]'));
            let target = null;
            if (requestedSubarea) {
              const req = requestedSubarea.toLowerCase();
              target = radios.find(r => (r.value || '').toLowerCase() === req);
              if (!target) target = radios.find(r => (r.id || '').toLowerCase().includes(req));
              if (!target) {
                target = radios.find(r => {
                  const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
                  return label && label.textContent.toLowerCase().includes(req);
                });
              }
            }
            if (!target && radios.length > 0) target = radios[0];
            if (target) { target.checked = true; return target.value || target.id || 'first-radio'; }
            return null;
          }, subarea || null, log);
          log.log(`Selected subarea: ${selectedSub}`);

          const btn2 = await findContinueButton(page);
          if (btn2) {
            await clickAndNavigate(page, () => btn2.click(), 'subarea continue', 15000, log);
          }
          stage = await detectStage(page, log);
          log.log('Stage after subarea:', stage);
        } else {
          // No radios and no dropdown (or dropdown was already handled) — just continue
          log.log('[AREA] No radio buttons found, clicking continue...');
          const btn = await findContinueButton(page);
          if (btn) {
            await clickAndNavigate(page, () => btn.click(), 'area continue (no selection available)', 15000, log);
          }
          stage = await detectStage(page, log);
          log.log('Stage after area continue:', stage);
        }
      }
    }

    // =========================================================
    // Step 3b: Handle neighborhood (hood) selection if it appears
    // =========================================================
    if (stage === 'hood') {
      log.log('On neighborhood selection page');

      // Log available neighborhoods
      const hoods = await safeEvaluate(page, () => {
        const labels = document.querySelectorAll('form.picker label, .selection-list label');
        return Array.from(labels).map(l => l.textContent.trim()).filter(t => t.length > 0);
      }, undefined, log).catch(() => []);
      log.log(`Available neighborhoods: ${JSON.stringify(hoods)}`);

      // Select first hood via .checked (NOT .click())
      await safeEvaluate(page, () => {
        const radio = document.querySelector('form.picker input[type="radio"]');
        if (radio) radio.checked = true;
      }, undefined, log);

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
      // Category selection: prefer categoryName (specific subcategory like "bicycles")
      // over category (broad type code like "fso"). The frontend should send both.
      const catKeyword = (categoryName || category || 'general').toLowerCase();
      log.log(`Selecting category: keyword="${catKeyword}" (categoryName=${categoryName || 'n/a'}, category=${category})`);

      // Log all available categories on this page for debugging
      const availableCats = await safeEvaluate(page, () => {
        const labels = document.querySelectorAll('form.picker label, .selection-list label');
        return Array.from(labels).map(l => l.textContent.trim()).filter(t => t.length > 0);
      }, undefined, log).catch(() => []);
      log.log(`Available categories on CL: ${JSON.stringify(availableCats)}`);

      // Map frontend values AND common names to CL's exact category label text
      const catAliases = {
        // Frontend category values (from CL_CATEGORIES dropdown)
        'bicycles': 'bicycles',
        'bicycle': 'bicycles',
        'bikes': 'bicycles',
        'electronics': 'electronics',
        'furniture': 'furniture',
        'computers': 'computers',
        'computer': 'computers',
        'cell-phones': 'cell phones',
        'cell phones': 'cell phones',
        'clothing': 'clothing & accessories',
        'tools': 'tools',
        'appliances': 'appliances',
        'collectibles': 'collectibles',
        'sports': 'sporting goods',
        'sporting': 'sporting goods',
        'sporting-goods': 'sporting goods',
        'baby': 'baby & kid stuff',
        'musical-instruments': 'musical instruments',
        'general': 'general for sale',
        'for-sale': 'general for sale',
        'for-sale-by-owner': 'general for sale',
        'auto-parts': 'auto parts',
        'cars': 'cars & trucks',
        'cars-trucks': 'cars & trucks',
        'motorcycles': 'motorcycles/scooters',
        'housing': 'apts / housing',
        'services': 'household services',
        'real-estate': 'real estate',
        // CL path codes (broad type — only use as last resort)
        'fso': 'general for sale',
        'bfs': 'household services',
        'cto': 'cars & trucks',
        'ctd': 'cars & trucks',
        'mco': 'motorcycles/scooters',
        'mcd': 'motorcycles/scooters',
        'apa': 'apts / housing',
        // More frontend QuickPostModal values
        'for-sale-general': 'general for sale',
        'apts-housing': 'apts / housing',
        'rooms-shares': 'rooms / shared',
        'vacation-rentals': 'vacation rentals',
        'office-commercial': 'office / commercial',
        'services-household': 'household services',
        'services-labor': 'labor / hauling / moving',
        'services-automotive': 'automotive services',
        'jobs-general': 'general labor',
        'community-general': 'general community',
        'gigs': 'gigs',
      };

      // Try matching directly first, then try alias
      let found = await selectRadioByLabelText(page, catKeyword, 'category', log);
      if (!found) {
        const alias = catAliases[catKeyword];
        if (alias && alias !== catKeyword) {
          log.log(`Category alias: "${catKeyword}" -> "${alias}"`);
          found = await selectRadioByLabelText(page, alias, 'category (alias)', log);
        }
      }
      // If categoryName didn't work but we also have category (clPath), try that too
      if (!found && categoryName && category && category.toLowerCase() !== catKeyword) {
        const fallbackAlias = catAliases[(category || '').toLowerCase()] || (category || '').toLowerCase();
        log.log(`Trying category fallback from clPath: "${category}" -> "${fallbackAlias}"`);
        found = await selectRadioByLabelText(page, fallbackAlias, 'category (clPath fallback)', log);
      }
      if (!found) {
        // Last resort: select "general for sale" or first available radio
        log.log('No category match — trying "general for sale" as last resort');
        found = await selectRadioByLabelText(page, 'general for sale', 'category (general fallback)', log);
      }
      if (!found) {
        await safeEvaluate(page, () => {
          const radio = document.querySelector('form.picker input[type="radio"]');
          if (radio) {
            radio.checked = true;
          }
        }, undefined, log);
        log.log('Selected first available category as absolute fallback');
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
      // Smart zip selection using ArcGIS CL zip lookup data (33K zip-to-region mappings).
      // Priority: frontend zip (from subarea) > validated ad zip > city default zip.
      // If the zip doesn't belong to the target CL city, auto-correct to the city default.
      const frontendZip = adData.zipCode || adData.zip;
      let finalZip = cityInfo.zip || '92694'; // safe default

      if (frontendZip) {
        const validation = validateZipForCity(frontendZip, cityKey);
        if (validation.valid) {
          finalZip = frontendZip;
          log.log(`[ZIP] Using frontend zip ${frontendZip} — validated for ${cityKey}`);
        } else if (validation.actualCity) {
          log.log(`[ZIP] Frontend zip ${frontendZip} belongs to "${validation.actualCity}" not "${cityKey}" — using city default ${cityInfo.zip} instead`);
          finalZip = cityInfo.zip;
        } else {
          // Unknown zip in ArcGIS data — trust the frontend
          finalZip = frontendZip;
          log.log(`[ZIP] Frontend zip ${frontendZip} not in ArcGIS lookup — using as-is`);
        }
      } else {
        log.log(`[ZIP] No frontend zip — using city default: ${finalZip}`);
      }

      await fillField(page, 'input[name="postal"]', finalZip, 'zip', log);

      // Brief pause after zip — CL sometimes does AJAX validation that modifies the DOM
      await delay(1000);

      // ── Reply email (REQUIRED by CL) ──
      // CL requires a reply email address on the edit form.
      // Use the credentials email, adData email, or fallback.
      // Normalize email to lowercase — CL rejects uppercase email addresses
      const rawEmail = (credentials && credentials.email) || email || adData.email || process.env.CL_EMAIL || '';
      const replyEmail = rawEmail.toLowerCase().trim();
      log.log(`Reply email: "${replyEmail}" (raw: "${rawEmail}")`);
      if (replyEmail) {
        // Try multiple selectors — CL uses different field names depending on category
        const emailSelectors = [
          'input[name="FromEMail"]',
          'input[name="Reply.To.eMail"]',
          'input[name="reply_email"]',
          'input#FromEMail',
        ];
        let emailFilled = false;
        for (const sel of emailSelectors) {
          const emailEl = await page.$(sel);
          if (emailEl) {
            await fillField(page, sel, replyEmail, 'reply email', log);
            emailFilled = true;
            break;
          }
        }
        // Also fill confirm email if present
        const confirmSelectors = [
          'input[name="ConfirmEMail"]',
          'input#ConfirmEMail',
          'input[name="confirm_email"]',
        ];
        for (const sel of confirmSelectors) {
          const confirmEl = await page.$(sel);
          if (confirmEl) {
            await fillField(page, sel, replyEmail, 'confirm email', log);
            break;
          }
        }
        if (!emailFilled) {
          log.log('Warning: No reply email field found on form');
        }
      } else {
        log.log('Warning: No reply email available to fill');
      }

      // ── Reply options / Privacy (check "CL mail relay" if available) ──
      try {
        const privacyRadio = await page.$('input[name="Privacy"][value="C"]');
        if (privacyRadio) {
          await privacyRadio.evaluate(el => { el.checked = true; });
          log.log('Set privacy to CL mail relay (C)');
        }
      } catch (privErr) {
        log.log('Privacy radio not found or not settable (non-fatal)');
      }

      // Optional fields — all wrapped in try/catch so failures don't kill the posting
      try {
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
      } catch (optionalErr) {
        log.log(`Warning: Optional field error (non-fatal): ${optionalErr.message.substring(0, 80)}`);
      }

      log.log('Form filled, submitting...');

      const submitBtn = await findContinueButton(page);
      if (submitBtn) {
        // Use a robust click that falls back to JS click if Puppeteer click fails
        // (CL's edit form can be long, and the button may not have a proper bounding box)
        await clickAndNavigate(page, async () => {
          try {
            await submitBtn.click();
          } catch (clickErr) {
            log.log(`Puppeteer click failed (${clickErr.message.substring(0, 60)}), using JS click fallback`);
            await submitBtn.evaluate(el => el.click());
          }
        }, 'form submit', 20000, log);
      }
      stage = await detectStage(page, log);
      log.log('Stage after form submit:', stage);

      // If still on edit page, CL likely has validation errors — capture them
      if (stage === 'edit') {
        const errors = await safeEvaluate(page, () => {
          // CL uses various elements for errors: red text, .errtxt, .notice, 
          // and also plain text blocks at top like "Some required information is missing"
          const errEls = document.querySelectorAll('.errtxt, .error, .field-error, span[style*="color: red"], span[style*="color:red"], .notice, .errormsg, .req, p[style*="color: red"], p[style*="color:red"]');
          const errs = Array.from(errEls).map(el => el.textContent.trim()).filter(t => t.length > 0);
          // Also check for CL's "required information is missing" banner
          const bodyText = document.body.innerText.substring(0, 500);
          if (bodyText.includes('required information is missing') || bodyText.includes('doesn\'t look right') || bodyText.includes('correct the fields')) {
            // Extract the error lines
            const lines = bodyText.split('\n').filter(l => l.includes('doesn\'t look right') || l.includes('required') || l.includes('missing') || l.includes('incorrect'));
            errs.push(...lines);
          }
          return errs;
        }, undefined, log).catch(() => []);
        if (errors && errors.length > 0) {
          log.log('FORM VALIDATION ERRORS:', JSON.stringify(errors));
          throw new Error(`CL form validation failed: ${errors.join('; ').substring(0, 200)}`);
        } else {
          // No visible errors but still on edit — try submitting again after a delay
          log.log('Still on edit page with no visible errors, retrying submit...');
          await delay(2000);
          const retryBtn = await findContinueButton(page);
          if (retryBtn) {
            await clickAndNavigate(page, async () => {
              try { await retryBtn.click(); } catch (e) { await retryBtn.evaluate(el => el.click()); }
            }, 'form submit retry', 25000, log);
            stage = await detectStage(page, log);
            log.log('Stage after retry submit:', stage);
          }
          if (stage === 'edit') {
            // Capture page screenshot and any error text for debugging
            const pageText = await safeEvaluate(page, () => document.body.innerText.substring(0, 500), undefined, log).catch(() => '');
            log.log('Page text on stuck edit:', pageText);
            throw new Error('Form submission failed — page stayed on edit form after 2 attempts');
          }
        }
      }
    }

    // =========================================================
    // Step 6b: Handle geoverify / map page if it appears
    // CL's geoverify page shows a map and asks user to confirm location.
    // The continue button may be class="continue bigbutton" or similar.
    // Sometimes the page has a "looks good" / "continue" button that
    // differs from the standard wizard buttons.
    // The page may also auto-advance after map interaction.
    // =========================================================
    if (stage === 'geoverify') {
      log.log('On geo-verify / map page');
      await updateJobStatus(jobId, 'processing', 'verifying_location');

      // Capture the page HTML for debugging
      const geoPageInfo = await safeEvaluate(page, () => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.button, a.bigbutton'));
        const btnInfo = buttons.map(b => ({
          tag: b.tagName,
          type: b.type || '',
          name: b.name || '',
          value: b.value || '',
          className: b.className || '',
          text: (b.textContent || '').trim().substring(0, 60),
          visible: b.offsetParent !== null && window.getComputedStyle(b).display !== 'none',
        }));
        const forms = Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action || '',
          method: f.method || '',
          id: f.id || '',
          className: f.className || '',
        }));
        return { buttons: btnInfo, forms, bodyClass: document.body.className, title: document.title };
      }, undefined, log).catch(() => ({ buttons: [], forms: [] }));
      log.log('Geoverify page info:', JSON.stringify(geoPageInfo));

      // Strategy 1: Look for specific geoverify continue buttons
      // CL map page often uses: button.continue.bigbutton, or a link-style button
      const geoButtonSelectors = [
        'button.continue',
        'button.bigbutton',
        'button.continue.bigbutton',
        '.continue.bigbutton',
        'a.continue.bigbutton',
        'button[value="continue"]',
        'input[value="continue"]',
        'button.pickbutton',
        'button[name="go"]',
        'button[type="submit"]',
        'input[type="submit"]',
      ];

      let geoClicked = false;
      for (const sel of geoButtonSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const btnVisible = await btn.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
          }).catch(() => false);
          if (btnVisible) {
            const btnText = await btn.evaluate(el => (el.textContent || el.value || '').trim()).catch(() => '');
            log.log(`Found geoverify button: ${sel} (text: "${btnText}")`);
            await btn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
            await delay(500);
            await clickAndNavigate(page, async () => {
              try {
                await btn.click();
              } catch (e) {
                log.log(`Direct click failed on geoverify button, trying JS click: ${e.message.substring(0, 60)}`);
                await btn.evaluate(el => el.click());
              }
            }, `geoverify continue (${sel})`, 20000, log);
            geoClicked = true;
            break;
          }
        }
      }

      // Strategy 2: If no button worked via clickAndNavigate (URL didn't change),
      // try submitting the form directly via JS
      stage = await detectStage(page, log);
      if (stage === 'geoverify') {
        log.log('Still on geoverify after button click — trying form.submit()');
        await safeEvaluate(page, () => {
          const form = document.querySelector('form');
          if (form) form.submit();
        }, undefined, log).catch(e => log.log('form.submit() error (may be expected):', e.message.substring(0, 60)));
        // Wait for potential navigation
        await delay(3000);
        // Wait for page to stabilize
        for (let i = 0; i < 6; i++) {
          try {
            await page.evaluate(() => document.title);
            break;
          } catch (e) {
            await delay(1000);
          }
        }
        stage = await detectStage(page, log);
        log.log('Stage after form.submit():', stage);
      }

      // Strategy 3: If STILL on geoverify, try clicking any element that looks like continue
      if (stage === 'geoverify') {
        log.log('Still on geoverify — trying text-based button search');
        const clicked = await safeEvaluate(page, () => {
          const allEls = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
          for (const el of allEls) {
            const text = (el.textContent || el.value || '').trim().toLowerCase();
            if (text === 'continue' || text === 'done' || text === 'looks good' || text.includes('continue')) {
              if (el.offsetParent !== null) {
                el.click();
                return text;
              }
            }
          }
          return null;
        }, undefined, log).catch(() => null);
        if (clicked) {
          log.log(`Clicked text-based button: "${clicked}"`);
          await delay(5000);
          for (let i = 0; i < 6; i++) {
            try { await page.evaluate(() => document.title); break; } catch (e) { await delay(1000); }
          }
          stage = await detectStage(page, log);
          log.log('Stage after text-based click:', stage);
        }
      }

      if (stage === 'geoverify') {
        log.log('WARNING: Could not advance past geoverify page');
        await capturePageDebug(page, log);
      }
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
    // Step 8b: Handle email verification / loginloop
    // CL requires email verification when posting from an untrusted IP.
    // The ad IS submitted but requires clicking a link in email to go live.
    // Report this as a special status so the frontend can show the right message.
    // =========================================================
    if (stage === 'loginloop') {
      log.log('CL requires email verification (loginloop stage)');
      await updateJobStatus(jobId, 'processing', 'email_verification');

      // Extract the email address CL sent verification to
      const verifyInfo = await safeEvaluate(page, () => {
        const text = document.body.innerText;
        const emailMatch = text.match(/Email sent to:\s*(\S+@\S+)/i) || text.match(/email.*?([\w.+-]+@[\w.-]+)/i);
        return {
          email: emailMatch ? emailMatch[1] : null,
          bodySnippet: text.substring(0, 300),
        };
      }, undefined, log).catch(() => ({ email: null, bodySnippet: '' }));
      log.log('Email verification info:', JSON.stringify(verifyInfo));

      // Return success with a note about email verification
      // The ad is submitted, it just needs email confirmation to go live
      return {
        postUrl: page.url(),
        success: true,
        needsEmailVerification: true,
        verificationEmail: verifyInfo.email,
        message: `Ad submitted successfully but requires email verification. CL sent a confirmation email to ${verifyInfo.email || 'the posting email'}. Click the link in that email to publish the ad.`,
      };
    }

    // =========================================================
    // Step 9: Extract final URL / confirmation
    // =========================================================
    const finalUrl = page.url();
    let postUrl2 = finalUrl;

    // Try to find a confirmation link with the actual post URL
    const confirmLink = await page.$('a[href*="/d/"], a.manageable-ad-link, a[href*="craigslist.org"][href*="/"]');
    if (confirmLink) {
      postUrl2 = await confirmLink.evaluate(el => el.href) || finalUrl;
    }

    // Also check for confirmation text on the page
    const pageConfirmation = await safeEvaluate(page, () => {
      const text = document.body.innerText.toLowerCase();
      return {
        hasPublished: text.includes('your posting has been published') || text.includes('thanks for posting'),
        hasPending: text.includes('your posting is being reviewed') || text.includes('will be posted shortly'),
        hasManage: !!document.querySelector('a[href*="/manage/"], a[href*="manage.craigslist"]'),
        bodySnippet: document.body.innerText.substring(0, 300),
      };
    }, undefined, log).catch(() => ({ hasPublished: false, hasPending: false, hasManage: false, bodySnippet: '' }));

    log.log('Final URL:', finalUrl);
    log.log('Post URL:', postUrl2);
    log.log('Final stage:', stage);
    log.log('Page confirmation:', JSON.stringify(pageConfirmation));

    // ── Validate result ──
    // Don't return false success — if we're still on geoverify or edit,
    // or the URL is just the base domain, the post didn't actually go through.
    const stuckStages = ['geoverify', 'edit', 'type', 'cat', 'subarea', 'hood'];
    if (stuckStages.includes(stage)) {
      throw new Error(`Posting did not complete — stuck on stage: ${stage}. Final URL: ${finalUrl}`);
    }

    // Check if the postUrl is actually valid (not just "craigslist.org" or empty)
    const isValidPostUrl = postUrl2 && 
      postUrl2 !== finalUrl && 
      postUrl2.includes('craigslist.org/') && 
      postUrl2.length > 30;
    
    // Even without a valid post URL, if we see confirmation text, it worked
    const hasConfirmation = pageConfirmation.hasPublished || pageConfirmation.hasPending || pageConfirmation.hasManage;
    
    if (!isValidPostUrl && !hasConfirmation && stage !== 'preview') {
      // We might be on a finalize/thanks page without a clear link — that's still OK
      // But if we can't find ANY evidence of success, report it
      log.log('WARNING: No valid post URL or confirmation text found');
      log.log('Returning with caution — post may or may not have succeeded');
    }

    return { postUrl: isValidPostUrl ? postUrl2 : finalUrl, success: true };
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

// Helper to safely fill a form field
// Strategy: focus via JS, clear via select+delete, then type or insertText.
// CL detects direct .value= assignment as "autofilled" and rejects the form,
// so we must simulate real user input.
async function fillField(page, selector, value, fieldName, log = defaultLogger) {
  if (!value) return;
  try {
    const el = await page.$(selector);
    if (el) {
      // Strip emojis/special unicode — CL only accepts plain text in form fields.
      const cleanValue = value.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{200D}\u{2764}\u{FE0F}\u{20E3}\u{2B50}\u{2705}\u{274C}\u{2728}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu, '').replace(/  +/g, ' ');

      // Step 1: Scroll into view
      await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await delay(200 + Math.random() * 300);

      // Step 2: Get bounding box and click at a random point within the field
      // Using mouse.click with coordinates is more human-like than el.click()
      const box = await el.boundingBox();
      if (box) {
        const clickX = box.x + 5 + Math.random() * Math.min(box.width - 10, 100);
        const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * (box.height * 0.4);
        await page.mouse.click(clickX, clickY);
      } else {
        await el.click();
      }
      await delay(150 + Math.random() * 200);

      // Step 3: Triple-click to select all text (human way, not Ctrl+A)
      if (box) {
        const clickX = box.x + 5 + Math.random() * Math.min(box.width - 10, 100);
        const clickY = box.y + box.height / 2;
        await page.mouse.click(clickX, clickY, { clickCount: 3 });
      } else {
        await el.click({ clickCount: 3 });
      }
      await delay(80 + Math.random() * 100);
      await page.keyboard.press('Backspace');
      await delay(80 + Math.random() * 100);

      // Step 4: Type with Puppeteer's type() — fires real keydown/keypress/input/keyup per char
      // Use a human-like delay between keystrokes (20-55ms with occasional pauses)
      const baseDelay = 20 + Math.floor(Math.random() * 15);
      for (let i = 0; i < cleanValue.length; i++) {
        await page.keyboard.type(cleanValue[i]);
        // Variable delay: occasional longer pauses (like a human thinking)
        let charDelay = baseDelay + Math.floor(Math.random() * 20);
        if (Math.random() < 0.05) charDelay += 80 + Math.random() * 120; // 5% chance of longer pause
        if (cleanValue[i] === ' ') charDelay += 10 + Math.random() * 30; // slightly longer on spaces
        await delay(charDelay);
      }

      // Step 5: Small pause then blur (click somewhere else or tab)
      await delay(200 + Math.random() * 300);
      // Click outside the field to blur (more natural than Tab)
      if (box) {
        await page.mouse.click(box.x + box.width + 20, box.y + box.height + 20);
      }
      await delay(150);

      // Step 6: Verify the value was set
      const actualValue = await el.evaluate(e => e.value || e.textContent || '');
      if (actualValue.length === 0 && cleanValue.length > 0) {
        log.log(`WARNING: ${fieldName} appears empty after fill, retrying with type()...`);
        await el.click();
        await delay(200);
        await el.type(cleanValue, { delay: 25 + Math.floor(Math.random() * 15) });
      }

      log.log(`Filled ${fieldName}: "${cleanValue.substring(0, 50)}${cleanValue.length > 50 ? '...' : ''}"`);
    } else {
      log.log(`Field not found: ${fieldName} (${selector})`);
    }
  } catch (err) {
    log.log(`ERROR filling ${fieldName}: ${err.message.substring(0, 120)}`);
    // Last resort fallback
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await delay(200);
        const cleanValue = value.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{200D}]/gu, '');
        await el.type(cleanValue, { delay: 25 });
        log.log(`Filled ${fieldName} via fallback type()`);
      }
    } catch (e2) {
      log.log(`FALLBACK also failed for ${fieldName}: ${e2.message.substring(0, 80)}`);
    }
  }
}

module.exports = { postToCraigslist };
