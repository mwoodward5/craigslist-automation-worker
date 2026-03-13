const express = require('express');
const cors = require('cors');
const { postToCraigslist } = require('./poster');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN;
const INTER_POST_DELAY_MS = parseInt(process.env.INTER_POST_DELAY_MS) || 180000; // 3 minutes default
const VERSION = '3.0.0';

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

// =========================================================
// Auth middleware
// =========================================================
function requireAuth(req, res, next) {
  if (!WORKER_AUTH_TOKEN) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  const token = authHeader.slice(7);
  if (token !== WORKER_AUTH_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

// =========================================================
// Payload normalization — accept both adData and ad formats
// =========================================================
function normalizePayload(body) {
  let { jobId, adData, ad, proxyConfig, targetCity, credentials } = body;

  // Accept either adData (edge function) or ad (auto-renew)
  const rawAd = adData || ad;
  if (!rawAd) return { jobId, adData: null, proxyConfig, targetCity, credentials };

  // Normalize fields: map 'body' to 'description' if description is missing
  const normalized = { ...rawAd };
  if (!normalized.description && normalized.body) {
    normalized.description = normalized.body;
  }

  // Map 'city' to targetCity if targetCity not provided at top level
  if (!targetCity && normalized.city) {
    targetCity = normalized.city;
  }

  return { jobId, adData: normalized, proxyConfig, targetCity, credentials };
}

// =========================================================
// Sequential Job Queue
// =========================================================
const jobQueue = [];
let currentJob = null;
let isProcessing = false;
let shuttingDown = false;
let totalProcessed = 0;
let totalFailed = 0;

function generateJobId() {
  return crypto.randomUUID();
}

function getQueueState() {
  return {
    queueLength: jobQueue.length,
    currentJob: currentJob ? {
      jobId: currentJob.jobId,
      targetCity: currentJob.targetCity,
      title: currentJob.adData?.title?.substring(0, 60),
      startedAt: currentJob.startedAt,
    } : null,
    pending: jobQueue.map((j, i) => ({
      position: i + 1,
      jobId: j.jobId,
      targetCity: j.targetCity,
      title: j.adData?.title?.substring(0, 60),
      queuedAt: j.queuedAt,
    })),
    stats: {
      totalProcessed,
      totalFailed,
      isProcessing,
      shuttingDown,
      interPostDelayMs: INTER_POST_DELAY_MS,
    },
  };
}

function enqueueJob(job) {
  const queuedAt = new Date().toISOString();
  const internalId = job.jobId || generateJobId();
  const entry = { ...job, jobId: internalId, queuedAt };
  jobQueue.push(entry);
  const position = jobQueue.length;
  logger.log(`[QUEUE] Job ${internalId} queued at position ${position} (city=${job.targetCity}, queue length=${position})`);
  processQueue();
  return { jobId: internalId, queuePosition: position };
}

async function processQueue() {
  if (isProcessing || shuttingDown || jobQueue.length === 0) return;

  isProcessing = true;

  while (jobQueue.length > 0 && !shuttingDown) {
    const job = jobQueue.shift();
    currentJob = { ...job, startedAt: new Date().toISOString() };
    logger.log(`[QUEUE] Processing job ${job.jobId} (city=${job.targetCity}, remaining=${jobQueue.length})`);

    try {
      await updateJobStatus(job.jobId, 'processing', 'connecting');
      const result = await postToCraigslist({
        jobId: job.jobId,
        adData: job.adData,
        proxyConfig: job.proxyConfig,
        targetCity: job.targetCity,
        credentials: job.credentials,
        updateJobStatus,
        logger,
      });
      await updateJobStatus(job.jobId, 'completed', 'done', { result_url: result.postUrl });
      totalProcessed++;
      logger.log(`[QUEUE] Job ${job.jobId} completed (url=${result.postUrl || 'n/a'})`);
    } catch (err) {
      totalFailed++;
      logger.error(`[QUEUE] Job ${job.jobId} failed: ${err.message}`);
      await updateJobStatus(job.jobId, 'failed', 'error', { error_message: err.message });
    }

    currentJob = null;

    // Wait between posts if more jobs remain
    if (jobQueue.length > 0 && !shuttingDown) {
      logger.log(`[QUEUE] Waiting ${INTER_POST_DELAY_MS}ms before next job (${jobQueue.length} remaining)`);
      await new Promise(resolve => setTimeout(resolve, INTER_POST_DELAY_MS));
    }
  }

  isProcessing = false;
  logger.log(`[QUEUE] Queue empty. Processed=${totalProcessed}, Failed=${totalFailed}`);
}

// =========================================================
// Graceful shutdown
// =========================================================
function handleShutdown(signal) {
  logger.log(`[SHUTDOWN] Received ${signal}. Finishing current job, not starting new ones.`);
  shuttingDown = true;
  // If nothing is processing, exit immediately
  if (!isProcessing) {
    logger.log('[SHUTDOWN] No active job. Exiting.');
    process.exit(0);
  }
  // Otherwise, the processQueue loop will stop after the current job
  // Set a hard timeout of 10 minutes in case the current job hangs
  setTimeout(() => {
    logger.error('[SHUTDOWN] Hard timeout reached. Force exiting.');
    process.exit(1);
  }, 600000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// =========================================================
// Routes
// =========================================================

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'CL Puppeteer Poster', version: VERSION });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: VERSION,
    queue: {
      length: jobQueue.length,
      isProcessing,
      totalProcessed,
      totalFailed,
    },
  });
});

// =========================================================
// /debug endpoint — returns env status and recent logs (auth required)
// =========================================================
app.get('/debug', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    version: VERSION,
    env: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      DECODO_PROXY_HOST: !!process.env.DECODO_PROXY_HOST,
      DECODO_PROXY_USER: !!process.env.DECODO_PROXY_USER,
      DECODO_PROXY_PASS: !!process.env.DECODO_PROXY_PASS,
      WORKER_AUTH_TOKEN: !!process.env.WORKER_AUTH_TOKEN,
      INTER_POST_DELAY_MS,
    },
    queue: getQueueState(),
    logCount: logBuffer.length,
    logs: logBuffer.slice(-limit),
  });
});

// =========================================================
// /queue endpoint — returns queue status (auth required)
// =========================================================
app.get('/queue', requireAuth, (req, res) => {
  res.json(getQueueState());
});

// =========================================================
// /test-post endpoint — dry-run (auth required)
// =========================================================
app.post('/test-post', requireAuth, async (req, res) => {
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
// Posting endpoints — now queue-based (auth required)
// =========================================================
function handlePostJob(req, res) {
  if (shuttingDown) {
    return res.status(503).json({ error: 'Server is shutting down, not accepting new jobs' });
  }

  const normalized = normalizePayload(req.body);
  const { jobId, adData, proxyConfig, targetCity, credentials } = normalized;

  logger.log(`[SERVER] Job received: jobId=${jobId}, city=${targetCity}, proxy=${JSON.stringify(proxyConfig || 'NONE').substring(0, 200)}`);

  if (!adData) {
    return res.status(400).json({ error: 'adData (or ad) is required' });
  }

  // Update Supabase status to queued
  updateJobStatus(jobId, 'queued', 'waiting_in_queue');

  const { jobId: queuedJobId, queuePosition } = enqueueJob({
    jobId, adData, proxyConfig, targetCity, credentials,
  });

  res.json({
    success: true,
    message: 'Job queued',
    jobId: queuedJobId,
    queuePosition,
    queueLength: jobQueue.length,
  });
}

app.post('/', requireAuth, handlePostJob);
app.post('/post', requireAuth, handlePostJob);

// =========================================================
// Start server
// =========================================================
app.listen(PORT, '0.0.0.0', () => {
  logger.log(`CL Puppeteer service v${VERSION} running on port ${PORT}`);
  logger.log(`[CONFIG] Inter-post delay: ${INTER_POST_DELAY_MS}ms, Auth: ${WORKER_AUTH_TOKEN ? 'enabled' : 'disabled'}`);
});
