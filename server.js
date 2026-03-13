const express = require('express');
const cors = require('cors');
const { postToCraigslist } = require('./poster');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { resolveProxy, launchBrowser, loginToCL, delay } = require('./proxyUtils');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERSION = '2.18.0';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// =========================================================
// In-memory log ring buffer
// =========================================================
const logBuffer = [];
const MAX_LOGS = 500;

function addLog(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logBuffer.push({ ts: new Date().toISOString(), level, msg });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  if (level === 'error') process.stderr.write(msg + '\n');
  else process.stdout.write(msg + '\n');
}

const logger = {
  log: (...args) => addLog('info', ...args),
  error: (...args) => addLog('error', ...args),
};

async function updateJobStatus(jobId, status, step, extra = {}) {
  if (!supabase || !jobId) return;
  try {
    await supabase.from('posting_jobs').update({
      status, step, updated_at: new Date().toISOString(), ...extra
    }).eq('id', jobId);
  } catch (e) { logger.error('Status update failed:', e.message); }
}

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'CL Puppeteer Poster', version: VERSION });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// =========================================================
// /debug endpoint — returns env status and recent logs
// =========================================================
app.get('/debug', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    version: VERSION,
    env: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      DECODO_PROXY_HOST: !!process.env.DECODO_PROXY_HOST,
      DECODO_PROXY_USER: !!process.env.DECODO_PROXY_USER,
      DECODO_PROXY_PASS: !!process.env.DECODO_PROXY_PASS,
    },
    logCount: logBuffer.length,
    logs: logBuffer.slice(-limit),
  });
});

// =========================================================
// /test-post endpoint — dry-run: launch browser, navigate, screenshot
// =========================================================
app.post('/test-post', async (req, res) => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://post.craigslist.org/c/orc', { waitUntil: 'networkidle2', timeout: 30000 });

    const url = page.url();
    const title = await page.title();
    const bodyClass = await page.evaluate(() => document.body.className);
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    res.json({
      success: true,
      url,
      title,
      bodyClass,
      pageText: pageText.substring(0, 1000),
      screenshotBase64: screenshot.substring(0, 100) + '...(truncated)',
      hasScreenshot: true,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  } finally {
    await browser.close();
  }
});

// =========================================================
// Posting endpoints
// =========================================================
async function handlePostJob(req, res) {
  const { jobId, adData, proxyConfig, targetCity, credentials } = req.body;
  logger.log(`[SERVER] Job received: jobId=${jobId}, city=${targetCity}, proxy=${JSON.stringify(proxyConfig || 'NONE').substring(0, 200)}`);
  if (!adData) return res.status(400).json({ error: 'adData is required' });

  res.json({ success: true, message: 'Job accepted', jobId });

  try {
    await updateJobStatus(jobId, 'processing', 'connecting');
    const result = await postToCraigslist({ jobId, adData, proxyConfig, targetCity, credentials, updateJobStatus, logger });
    await updateJobStatus(jobId, 'completed', 'done', { result_url: result.postUrl });
  } catch (err) {
    logger.error('Posting failed:', err.message);
    await updateJobStatus(jobId, 'failed', 'error', { error_message: err.message });
  }
}

app.post('/', handlePostJob);
app.post('/post', handlePostJob);

// =========================================================
// POST /scan-position — Scan CL search results for ad position
// Synchronous: waits for result, 30s timeout
// =========================================================
app.post('/scan-position', async (req, res) => {
  const { searchUrl, cl_post_id, proxyConfig, jobId } = req.body;
  logger.log(`[SCAN] Position scan: postId=${cl_post_id}, url=${searchUrl}, jobId=${jobId || 'none'}`);

  if (!searchUrl || !cl_post_id) {
    return res.status(400).json({ error: 'searchUrl and cl_post_id are required' });
  }

  let browser = null;
  const timeout = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
    // Response may already be sent if we finished in time
  }, 30000);

  try {
    const resolvedProxy = resolveProxy(proxyConfig, { jobId, cityKey: '', log: logger });
    let page;
    ({ browser, page } = await launchBrowser(resolvedProxy, logger));

    logger.log(`[SCAN] Navigating to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);

    // Parse all search result listings
    const scanResult = await page.evaluate((targetPostId) => {
      const results = [];

      // Strategy 1: cl-static-search-result items (newer CL layout)
      const staticResults = document.querySelectorAll('li.cl-static-search-result');
      if (staticResults.length > 0) {
        staticResults.forEach((li, idx) => {
          const pid = li.getAttribute('data-pid');
          const link = li.querySelector('a');
          const href = link ? link.getAttribute('href') : '';
          results.push({ index: idx + 1, pid, href });
        });
      }

      // Strategy 2: cl-search-result items (gallery/list view)
      if (results.length === 0) {
        const searchResults = document.querySelectorAll('li.cl-search-result');
        searchResults.forEach((li, idx) => {
          const pid = li.getAttribute('data-pid');
          const link = li.querySelector('a');
          const href = link ? link.getAttribute('href') : '';
          results.push({ index: idx + 1, pid, href });
        });
      }

      // Strategy 3: result-row items (classic CL layout)
      if (results.length === 0) {
        const rows = document.querySelectorAll('.result-row, li.result-row');
        rows.forEach((row, idx) => {
          const pid = row.getAttribute('data-pid');
          const link = row.querySelector('a.result-title, a.hdrlnk, a');
          const href = link ? link.getAttribute('href') : '';
          results.push({ index: idx + 1, pid, href });
        });
      }

      // Strategy 4: any link with /d/ pattern containing post IDs
      if (results.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/d/"]');
        allLinks.forEach((a, idx) => {
          const href = a.getAttribute('href') || '';
          const match = href.match(/\/(\d{10,})\.html/);
          const pid = match ? match[1] : null;
          if (pid) results.push({ index: idx + 1, pid, href });
        });
      }

      const total = results.length;
      let found = false;
      let position = null;

      for (const r of results) {
        // Match by data-pid attribute
        if (r.pid && r.pid === targetPostId) {
          found = true;
          position = r.index;
          break;
        }
        // Match by post ID in href
        if (r.href && r.href.includes(targetPostId)) {
          found = true;
          position = r.index;
          break;
        }
      }

      return { found, position, total_listings: total };
    }, cl_post_id);

    clearTimeout(timeout);
    logger.log(`[SCAN] Result: found=${scanResult.found}, position=${scanResult.position}, total=${scanResult.total_listings}`);
    res.json(scanResult);
  } catch (err) {
    clearTimeout(timeout);
    logger.error(`[SCAN] Error: ${err.message}`);
    res.status(500).json({ error: err.message, found: false, position: null, total_listings: 0 });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// =========================================================
// POST /renew — Renew an existing CL post
// Synchronous: waits for result, 60s timeout
// =========================================================
app.post('/renew', async (req, res) => {
  const { cl_post_url, credentials, proxyConfig, jobId } = req.body;
  logger.log(`[RENEW] Renew request: url=${cl_post_url}, jobId=${jobId || 'none'}`);

  if (!cl_post_url || !credentials) {
    return res.status(400).json({ error: 'cl_post_url and credentials are required' });
  }

  // Extract post ID from URL (pattern: /7845123456.html)
  const postIdMatch = cl_post_url.match(/\/(\d{10,})\.html/);
  const targetPostId = postIdMatch ? postIdMatch[1] : null;
  if (!targetPostId) {
    return res.status(400).json({ error: 'Could not extract post ID from cl_post_url' });
  }

  let browser = null;
  const timeout = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
  }, 60000);

  try {
    const resolvedProxy = resolveProxy(proxyConfig, { jobId, cityKey: '', log: logger });
    let page;
    ({ browser, page } = await launchBrowser(resolvedProxy, logger));

    // Step 1: Login
    await loginToCL(page, credentials, logger);
    await delay(1000);

    // Step 2: Navigate to CL account page to find the post
    logger.log('[RENEW] Navigating to account management page...');
    await page.goto('https://accounts.craigslist.org/login/home', { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);

    // Step 3: Find the post and click renew
    const renewResult = await page.evaluate((targetId) => {
      // Look for all post management rows
      // CL account page shows posts with links containing the post ID
      const allLinks = document.querySelectorAll('a');
      let postFound = false;

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.includes(targetId)) {
          postFound = true;
          break;
        }
      }

      // Look for renew buttons/links near the post
      const renewButtons = document.querySelectorAll('input[value="renew"], button.renew, a.renew, [data-action="renew"]');
      const forms = document.querySelectorAll('form');
      let renewFormFound = false;
      for (const form of forms) {
        const action = form.getAttribute('action') || '';
        const html = form.innerHTML || '';
        if ((action.includes(targetId) || html.includes(targetId)) && html.toLowerCase().includes('renew')) {
          renewFormFound = true;
          break;
        }
      }

      return { postFound, renewButtonCount: renewButtons.length, renewFormFound };
    }, targetPostId);

    logger.log(`[RENEW] Account page scan: postFound=${renewResult.postFound}, renewButtons=${renewResult.renewButtonCount}, renewFormFound=${renewResult.renewFormFound}`);

    // Try to click the renew button for this specific post
    // CL account page has rows with post info and action buttons
    const renewed = await page.evaluate((targetId) => {
      // Strategy 1: Find a row/container with the post ID and a renew button inside it
      const rows = document.querySelectorAll('.posting-row, tr, .manage-posting, [data-pid]');
      for (const row of rows) {
        const html = row.innerHTML || '';
        if (html.includes(targetId)) {
          const renewBtn = row.querySelector('input[value="renew"], button.renew, input[type="submit"][value*="renew" i], a[href*="renew"]');
          if (renewBtn) {
            renewBtn.click();
            return { clicked: true, method: 'row-button' };
          }
        }
      }

      // Strategy 2: Find any form that references this post ID with a renew action
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        const action = form.getAttribute('action') || '';
        const html = form.innerHTML || '';
        if ((action.includes(targetId) || html.includes(targetId)) && html.toLowerCase().includes('renew')) {
          const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], button');
          if (submitBtn) {
            submitBtn.click();
            return { clicked: true, method: 'form-submit' };
          }
          form.submit();
          return { clicked: true, method: 'form-submit-direct' };
        }
      }

      // Strategy 3: Look for renew links with the post ID
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').toLowerCase();
        if (href.includes(targetId) && text.includes('renew')) {
          link.click();
          return { clicked: true, method: 'link-click' };
        }
      }

      return { clicked: false, method: 'none' };
    }, targetPostId);

    if (renewed.clicked) {
      logger.log(`[RENEW] Clicked renew via ${renewed.method}, waiting for confirmation...`);
      await delay(3000);

      // Handle confirmation dialog if present
      await page.evaluate(() => {
        const confirmBtns = document.querySelectorAll('button[type="submit"], input[type="submit"], button.confirm, .confirm-button');
        for (const btn of confirmBtns) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (text.includes('confirm') || text.includes('renew') || text.includes('yes') || text.includes('ok') || text.includes('continue')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await delay(2000);

      clearTimeout(timeout);
      logger.log('[RENEW] Renewal completed successfully');
      res.json({ success: true, renewed: true });
    } else {
      clearTimeout(timeout);
      logger.log('[RENEW] Could not find renew button for this post');
      res.json({ success: false, error: 'Post not found for renewal or renew option not available' });
    }
  } catch (err) {
    clearTimeout(timeout);
    logger.error(`[RENEW] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// =========================================================
// POST /delete-post — Delete an existing CL post
// Synchronous: waits for result, 60s timeout
// =========================================================
app.post('/delete-post', async (req, res) => {
  const { cl_post_url, credentials, proxyConfig, jobId } = req.body;
  logger.log(`[DELETE] Delete request: url=${cl_post_url}, jobId=${jobId || 'none'}`);

  if (!cl_post_url || !credentials) {
    return res.status(400).json({ error: 'cl_post_url and credentials are required' });
  }

  const postIdMatch = cl_post_url.match(/\/(\d{10,})\.html/);
  const targetPostId = postIdMatch ? postIdMatch[1] : null;
  if (!targetPostId) {
    return res.status(400).json({ error: 'Could not extract post ID from cl_post_url' });
  }

  let browser = null;
  const timeout = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
  }, 60000);

  try {
    const resolvedProxy = resolveProxy(proxyConfig, { jobId, cityKey: '', log: logger });
    let page;
    ({ browser, page } = await launchBrowser(resolvedProxy, logger));

    // Step 1: Login
    await loginToCL(page, credentials, logger);
    await delay(1000);

    // Step 2: Navigate to CL account page
    logger.log('[DELETE] Navigating to account management page...');
    await page.goto('https://accounts.craigslist.org/login/home', { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);

    // Step 3: Find the post and click delete
    const deleted = await page.evaluate((targetId) => {
      // Strategy 1: Find a row/container with the post ID and a delete button inside it
      const rows = document.querySelectorAll('.posting-row, tr, .manage-posting, [data-pid]');
      for (const row of rows) {
        const html = row.innerHTML || '';
        if (html.includes(targetId)) {
          const deleteBtn = row.querySelector('input[value="delete"], button.delete, input[type="submit"][value*="delete" i], a[href*="delete"]');
          if (deleteBtn) {
            deleteBtn.click();
            return { clicked: true, method: 'row-button' };
          }
        }
      }

      // Strategy 2: Find any form that references this post ID with a delete action
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        const action = form.getAttribute('action') || '';
        const html = form.innerHTML || '';
        if ((action.includes(targetId) || html.includes(targetId)) && html.toLowerCase().includes('delete')) {
          const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], button');
          if (submitBtn) {
            submitBtn.click();
            return { clicked: true, method: 'form-submit' };
          }
          form.submit();
          return { clicked: true, method: 'form-submit-direct' };
        }
      }

      // Strategy 3: Look for delete links with the post ID
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').toLowerCase();
        if (href.includes(targetId) && text.includes('delete')) {
          link.click();
          return { clicked: true, method: 'link-click' };
        }
      }

      return { clicked: false, method: 'none' };
    }, targetPostId);

    if (deleted.clicked) {
      logger.log(`[DELETE] Clicked delete via ${deleted.method}, waiting for confirmation...`);
      await delay(3000);

      // Handle confirmation dialog
      await page.evaluate(() => {
        const confirmBtns = document.querySelectorAll('button[type="submit"], input[type="submit"], button.confirm, .confirm-button');
        for (const btn of confirmBtns) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (text.includes('confirm') || text.includes('delete') || text.includes('yes') || text.includes('ok') || text.includes('continue')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await delay(2000);

      clearTimeout(timeout);
      logger.log('[DELETE] Deletion completed successfully');
      res.json({ success: true, deleted: true });
    } else {
      clearTimeout(timeout);
      logger.log('[DELETE] Could not find delete button for this post');
      res.json({ success: false, error: 'Post not found for deletion or delete option not available' });
    }
  } catch (err) {
    clearTimeout(timeout);
    logger.error(`[DELETE] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  logger.log(`CL Puppeteer service running on port ${PORT}`);
});
