const express = require('express');
const cors = require('cors');
const { postToCraigslist } = require('./poster');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function updateJobStatus(jobId, status, step, extra = {}) {
  if (!supabase || !jobId) return;
  try {
    await supabase.from('posting_jobs').update({
      status, step, updated_at: new Date().toISOString(), ...extra
    }).eq('id', jobId);
  } catch (e) { console.error('Status update failed:', e.message); }
}

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'CL Puppeteer Poster', version: '2.2.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

async function handlePostJob(req, res) {
  const { jobId, adData, proxyConfig, targetCity, credentials } = req.body;
  if (!adData) return res.status(400).json({ error: 'adData is required' });

  res.json({ success: true, message: 'Job accepted', jobId });

  try {
    await updateJobStatus(jobId, 'processing', 'connecting');
    const result = await postToCraigslist({ jobId, adData, proxyConfig, targetCity, credentials, updateJobStatus });
    await updateJobStatus(jobId, 'completed', 'done', { result_url: result.postUrl });
  } catch (err) {
    console.error('Posting failed:', err.message);
    await updateJobStatus(jobId, 'failed', 'error', { error_message: err.message });
  }
}

app.post('/', handlePostJob);
app.post('/post', handlePostJob);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CL Puppeteer service running on port ${PORT}`);
});
