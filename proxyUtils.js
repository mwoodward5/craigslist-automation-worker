const puppeteer = require('puppeteer');

// =========================================================
// Decodo proxy geo-targeting maps
// =========================================================

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

// =========================================================
// Resolve proxy config to { host, port, username, password }
// =========================================================
function resolveProxy(proxyConfig, { jobId, cityKey, log }) {
  if (proxyConfig && proxyConfig.host) {
    return proxyConfig;
  }
  if (proxyConfig && proxyConfig.state) {
    const proxyUser = process.env.DECODO_PROXY_USER;
    const proxyPass = process.env.DECODO_PROXY_PASS;
    if (proxyUser && proxyPass) {
      const stateKey = (proxyConfig.state || 'california').toLowerCase().replace(/ /g, '_');
      const decodoPart = DECODO_STATE_MAP[stateKey] || 'us_california';
      const sessionId = `adclimber_${jobId || Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      let usernameParams = `user-${proxyUser}-country-us-state-${decodoPart}`;
      const proxyCity = CL_CITY_TO_PROXY_CITY[(cityKey || '').toLowerCase()];
      if (proxyCity) {
        usernameParams += `-city-${proxyCity}`;
        log.log(`[PROXY] Adding city-level targeting: ${proxyCity}`);
      }
      usernameParams += `-session-${sessionId}-sessionduration-30`;
      log.log(`[PROXY] Decodo targeting: state=${decodoPart}, city=${proxyCity || 'none'}, session=${sessionId}`);
      return { host: 'gate.decodo.com', port: 7000, username: usernameParams, password: proxyPass };
    }
    log.log(`[PROXY] WARNING — state "${proxyConfig.state}" but DECODO env vars missing!`);
  }
  return null;
}

// =========================================================
// Launch Puppeteer with proxy + anti-detection
// Returns { browser, page }
// =========================================================
async function launchBrowser(resolvedProxy, log) {
  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--window-size=1280,900', '--disable-blink-features=AutomationControlled',
    '--disable-features=site-per-process',
  ];
  if (resolvedProxy && resolvedProxy.host) {
    launchArgs.push(`--proxy-server=${resolvedProxy.host}:${resolvedProxy.port}`);
    log.log(`[PROXY] Active — ${resolvedProxy.host}:${resolvedProxy.port}`);
  } else {
    log.log('[PROXY] WARNING — No proxy configured!');
  }

  const browser = await puppeteer.launch({ headless: 'new', args: launchArgs, defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  if (resolvedProxy && resolvedProxy.username) {
    await page.authenticate({ username: resolvedProxy.username, password: resolvedProxy.password });
    log.log('[PROXY] Authenticated with Decodo credentials');
  }
  page.setDefaultTimeout(30000);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  return { browser, page };
}

// =========================================================
// Delay helper
// =========================================================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================
// Human-like typing into a field (matches poster.js behavior)
// =========================================================
async function humanType(page, selector, value, log) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Field not found: ${selector}`);

  await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await delay(200 + Math.random() * 300);

  await el.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);

  for (let i = 0; i < value.length; i++) {
    await page.keyboard.type(value[i]);
    let charDelay = 25 + Math.floor(Math.random() * 20);
    if (Math.random() < 0.05) charDelay += 80 + Math.random() * 120;
    if (value[i] === ' ') charDelay += 10 + Math.random() * 30;
    await delay(charDelay);
  }
  await delay(200 + Math.random() * 300);
}

// =========================================================
// Login to CL (replicates poster.js Step 0)
// =========================================================
async function loginToCL(page, credentials, log) {
  const email = (credentials && credentials.email) || process.env.CL_EMAIL;
  const password = (credentials && credentials.password) || process.env.CL_PASSWORD;
  if (!email || !password) throw new Error('No CL credentials provided');

  log.log(`[LOGIN] Logging in as ${email}...`);
  await page.goto('https://accounts.craigslist.org/login', { waitUntil: 'networkidle2', timeout: 20000 });
  await delay(1000);

  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
  if (pageText.includes('log out') || pageText.includes('your account')) {
    log.log('[LOGIN] Already logged in');
    return true;
  }

  const emailInput = await page.$('input[name="inputEmailHandle"]');
  if (!emailInput) throw new Error('Login page: email field not found');

  await emailInput.click({ clickCount: 3 });
  await delay(100);
  await emailInput.type(email, { delay: 30 + Math.random() * 40 });
  await delay(300 + Math.random() * 200);

  const pwInput = await page.$('input[name="inputPassword"]');
  if (!pwInput) throw new Error('Login page: password field not found');

  await pwInput.click();
  await delay(100);
  await pwInput.type(password, { delay: 30 + Math.random() * 40 });
  await delay(300 + Math.random() * 200);

  const loginBtn = await page.$('button[type="submit"]');
  if (loginBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      loginBtn.click(),
    ]);
  }
  await delay(2000);

  const afterUrl = page.url();
  const afterText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
  if (afterText.includes('log out') || afterText.includes('your account') || afterUrl.includes('accounts.craigslist.org/login/home')) {
    log.log('[LOGIN] Login successful');
    return true;
  }
  if (afterText.includes('incorrect') || afterText.includes('invalid')) {
    throw new Error('Login failed: incorrect credentials');
  }
  log.log(`[LOGIN] Login status unclear. URL: ${afterUrl}`);
  return true; // proceed anyway, CL may still have session
}

module.exports = { resolveProxy, launchBrowser, loginToCL, humanType, delay, DECODO_STATE_MAP, CL_CITY_TO_PROXY_CITY };
