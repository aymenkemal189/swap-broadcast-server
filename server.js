const express = require('express');
const app = express();
app.use(express.json());

// ═══════════ CONFIG ═══════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8925694023:AAE_ITYjKOeCkcsR_gpAeU2WobQT3lGqWMw';
const SHEET_URL = process.env.SHEET_URL; // Google Sheets CSV export URL
const ADMIN_KEY = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';

const TG_PHOTO   = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
const TG_MESSAGE = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

// ═══════════ BROADCAST STATE ═══════════
let broadcastJob = {
  running: false,
  paused:  false,
  stop:    false,
  sent:    0,
  failed:  0,
  total:   0,
  startedAt: null,
  log: []
};

// ═══════════ CORS (allow dashboard) ═══════════
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════ AUTH MIDDLEWARE ═══════════
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═══════════ FETCH USERS FROM GOOGLE SHEETS CSV ═══════════
async function fetchUsers() {
  if (!SHEET_URL) throw new Error('SHEET_URL env variable not set');

  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error('Failed to fetch sheet: ' + res.status);
  const csv = await res.text();

  const lines = csv.trim().split('\n');
  if (lines.length < 2) throw new Error('Sheet is empty');

  // First row = headers
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const userIdCol = headers.findIndex(h => h.includes('userid') || h.includes('user_id') || h.includes('chat') || h.includes('id'));

  if (userIdCol === -1) throw new Error('Could not find userId column. Headers: ' + headers.join(', '));

  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const uid = cols[userIdCol];
    if (uid && uid !== 'None' && uid !== 'undefined' && uid !== '') {
      users.push({ userId: uid });
    }
  }
  return users;
}

// ═══════════ SEND ONE MESSAGE ═══════════
async function sendToUser(uid, text, photo, replyMarkup) {
  // Try photo first
  if (photo) {
    try {
      const body = { chat_id: uid, photo, caption: text, parse_mode: 'HTML' };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const r = await fetch(TG_PHOTO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.ok) return { success: true };
      if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    } catch (_) {}
  }

  // Fallback: text only
  try {
    const body = { chat_id: uid, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(TG_MESSAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) return { success: true };
    if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    return { success: false, reason: d.description };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// ═══════════ BROADCAST RUNNER (background) ═══════════
async function runBroadcast(users, text, photo, replyMarkup) {
  broadcastJob.running   = true;
  broadcastJob.paused    = false;
  broadcastJob.stop      = false;
  broadcastJob.sent      = 0;
  broadcastJob.failed    = 0;
  broadcastJob.total     = users.length;
  broadcastJob.startedAt = new Date().toISOString();
  broadcastJob.log       = [];

  for (let i = 0; i < users.length; i++) {
    // Stop check
    if (broadcastJob.stop) {
      broadcastJob.log.push('⏹️ Stopped by admin at ' + i);
      break;
    }

    // Pause: wait until resumed or stopped
    while (broadcastJob.paused) {
      await sleep(1000);
      if (broadcastJob.stop) break;
    }
    if (broadcastJob.stop) break;

    const uid = users[i].userId;
    const result = await sendToUser(uid, text, photo, replyMarkup);

    if (result.rateLimited) {
      broadcastJob.log.push('⚠️ Rate limited — waiting ' + result.wait + 's');
      await sleep(result.wait * 1000);
      i--; // retry same user
      continue;
    }

    if (result.success) {
      broadcastJob.sent++;
    } else {
      broadcastJob.failed++;
    }

    // ~28 msgs/sec — Telegram safe rate
    await sleep(35);
  }

  broadcastJob.running = false;
  broadcastJob.log.push('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════ API ROUTES ═══════════

// Health check
app.get('/', (req, res) => res.json({ status: 'Swap Broadcast Server running ✅' }));

// Start broadcast
app.post('/broadcast/start', auth, async (req, res) => {
  if (broadcastJob.running) {
    return res.status(409).json({ error: 'Broadcast already running. Stop it first.' });
  }

  const { text, photo, btnText, btnUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  let replyMarkup = null;
  if (btnText && btnUrl && btnUrl.startsWith('http')) {
    replyMarkup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
  }

  // Fetch users
  let users;
  try {
    users = await fetchUsers();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch users: ' + e.message });
  }

  if (users.length === 0) return res.status(404).json({ error: 'No users found in sheet' });

  // Start in background (don't await)
  runBroadcast(users, text, photo || '', replyMarkup);

  res.json({
    ok: true,
    message: 'Broadcast started in background',
    total: users.length
  });
});

// Pause
app.post('/broadcast/pause', auth, (req, res) => {
  if (!broadcastJob.running) return res.status(400).json({ error: 'No broadcast running' });
  broadcastJob.paused = true;
  res.json({ ok: true, message: 'Paused' });
});

// Resume
app.post('/broadcast/resume', auth, (req, res) => {
  broadcastJob.paused = false;
  res.json({ ok: true, message: 'Resumed' });
});

// Stop
app.post('/broadcast/stop', auth, (req, res) => {
  broadcastJob.stop    = true;
  broadcastJob.running = false;
  broadcastJob.paused  = false;
  res.json({ ok: true, message: 'Stopped' });
});

// Status (dashboard polls this)
app.get('/broadcast/status', auth, (req, res) => {
  res.json({
    running:   broadcastJob.running,
    paused:    broadcastJob.paused,
    sent:      broadcastJob.sent,
    failed:    broadcastJob.failed,
    total:     broadcastJob.total,
    pct:       broadcastJob.total ? Math.round((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total * 100) : 0,
    startedAt: broadcastJob.startedAt,
    lastLog:   broadcastJob.log.slice(-3)
  });
});

// ═══════════ START ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ Swap Broadcast Server on port ' + PORT));
