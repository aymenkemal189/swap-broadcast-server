const express = require('express');
const app = express();
app.use(express.json());

// ═══════════ CONFIG ═══════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
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

// ═══════════ CORS ═══════════
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════ AUTH ═══════════
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

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());

  // Find userId column
  let userIdCol = headers.findIndex(h =>
    h === '_id' || h === 'userid' || h === 'user_id' ||
    h === 'chat_id' || h === 'telegramid' || h === 'telegram_id' ||
    h.includes('userid') || h.includes('user_id') || h.includes('chat_id')
  );
  if (userIdCol === -1) {
    console.warn('userId column not found — using column A. Headers:', headers.join(', '));
    userIdCol = 0;
  }

  // Find username column
  let usernameCol = headers.findIndex(h =>
    h === 'username' || h === 'user_name' || h === 'name' ||
    h.includes('username') || h.includes('user_name')
  );

  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const uid  = cols[userIdCol];
    if (uid && uid !== 'None' && uid !== 'undefined' && uid !== '') {
      const username = usernameCol >= 0 ? (cols[usernameCol] || '') : '';
      users.push({ userId: uid, username });
    }
  }
  return users;
}

// ═══════════ USERNAME PLACEHOLDER REPLACER ═══════════
// Dashboard message ውስጥ {username} ቢጽፉ → ተጠቃሚው ስም ይተካዋል
// fallback: username ከሌለ "ተጠቃሚ" ይጠቀማል
function personalise(text, username) {
  const name = (username && username !== 'None' && username !== 'undefined' && username.trim() !== '')
    ? username.trim()
    : 'ተጠቃሚ';
  return text.replace(/\{username\}/gi, name);
}

// ═══════════ MARKDOWN → HTML CONVERTER ═══════════
function mdToHtml(text) {
  return text
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
    // <u>...</u> passthrough — Telegram HTML ይደግፈዋል
}

// ═══════════ SEND ONE MESSAGE ═══════════
async function sendToUser(uid, rawText, username, photo, replyMarkup) {
  // 1. Personalise: {username} → actual name
  const personalised = personalise(rawText, username);
  // 2. Markdown → HTML
  const htmlText = mdToHtml(personalised);

  // Try photo first (sendPhoto)
  if (photo) {
    try {
      const body = { chat_id: uid, photo, caption: htmlText, parse_mode: 'HTML' };
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

  // Fallback: text message (sendMessage)
  try {
    const body = { chat_id: uid, text: htmlText, parse_mode: 'HTML' };
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
    if (broadcastJob.stop) {
      broadcastJob.log.push('⏹️ Stopped by admin at ' + i);
      break;
    }

    while (broadcastJob.paused) {
      await sleep(1000);
      if (broadcastJob.stop) break;
    }
    if (broadcastJob.stop) break;

    const { userId, username } = users[i];
    const result = await sendToUser(userId, text, username || '', photo, replyMarkup);

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
      broadcastJob.log.push('❌ ' + userId + ': ' + (result.reason || 'unknown'));
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
app.get('/', (req, res) => res.json({
  status:    'Swap Broadcast Server running ✅',
  bot_token: BOT_TOKEN ? '✅ Set' : '❌ Missing',
  sheet_url: SHEET_URL ? '✅ Set' : '❌ Missing (needed for All-Users mode)',
  admin_key: ADMIN_KEY ? '✅ Set' : '❌ Missing',
  broadcast: broadcastJob.running
    ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}`
    : '⏹️ Idle',
  tip: 'Message ውስጥ {username} ጻፍ — እያንዳንዱ ሰው ስሙ ይደርሰዋል ✅'
}));

// ── Start broadcast ──
app.post('/broadcast/start', auth, async (req, res) => {
  if (broadcastJob.running) {
    return res.status(409).json({ error: 'Broadcast already running. Stop it first.' });
  }

  const { text, photo, btnText, btnUrl, users: usersPayload, user_ids } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  let replyMarkup = null;
  if (btnText && btnUrl && btnUrl.startsWith('http')) {
    replyMarkup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
  }

  let users;

  // ── Priority 1: dashboard sent full {userId, username} objects ──
  if (Array.isArray(usersPayload) && usersPayload.length > 0) {
    users = usersPayload.map(u => ({
      userId:   String(u.userId || u.id || ''),
      username: u.username || u.name || ''
    })).filter(u => u.userId);
    console.log(`[broadcast] Segmented (with username) — ${users.length} users`);

  // ── Priority 2: legacy user_ids array (no username) ──
  } else if (Array.isArray(user_ids) && user_ids.length > 0) {
    users = user_ids.map(id => ({ userId: String(id), username: '' }));
    console.log(`[broadcast] Segmented (ids only) — ${users.length} users`);

  // ── Priority 3: All-users — fetch from Google Sheet ──
  } else {
    try {
      users = await fetchUsers();
      console.log(`[broadcast] All-users from sheet — ${users.length} users`);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch users: ' + e.message });
    }
    if (users.length === 0) return res.status(404).json({ error: 'No users found in sheet' });
  }

  // Fire in background — browser can close safely
  runBroadcast(users, text, photo || '', replyMarkup);

  res.json({ ok: true, message: 'Broadcast started', total: users.length });
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

// Status — dashboard polls every 3s
app.get('/broadcast/status', auth, (req, res) => {
  res.json({
    running:   broadcastJob.running,
    paused:    broadcastJob.paused,
    sent:      broadcastJob.sent,
    failed:    broadcastJob.failed,
    total:     broadcastJob.total,
    pct:       broadcastJob.total
                 ? Math.round((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total * 100)
                 : 0,
    startedAt: broadcastJob.startedAt,
    lastLog:   broadcastJob.log.slice(-4)
  });
});

// ═══════════ START ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ Swap Broadcast Server on port ' + PORT));
