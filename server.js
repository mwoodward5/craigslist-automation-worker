const express = require('express');
const cors = require('cors');
const { postToCraigslist } = require('./poster');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERSION = '2.9.1';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// =========================================================
// In-memory log ring buffer
// =========================================================
const logBuffer = [];
const MAX_LOGS = 50;

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
  res.json({
    version: VERSION,
    env: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      CL_EMAIL: !!process.env.CL_EMAIL,
      CL_PASSWORD: !!process.env.CL_PASSWORD,
    },
    logs: logBuffer.slice(-20),
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

app.listen(PORT, '0.0.0.0', () => {
  logger.log(`CL Puppeteer service running on port ${PORT}`);
});
