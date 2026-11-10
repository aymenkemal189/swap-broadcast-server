const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ═════════════════════ CONFIGURATION ═════════════════════
const PORT          = process.env.PORT || 3000;
const BOT_TOKEN     = process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const ADMIN_KEY     = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL     = process.env.SHEET_URL; // Google Sheets CSV export URL
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ለአድሚን ኖቲፊኬሽን የሚላክበት Telegram ID
const FX_RATE       = 120.00; // 1 USD = 120.00 ETB

const TG_PHOTO   = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
const TG_MESSAGE = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

// ═════════════════════ CORS & STATIC FILES ═════════════════════
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// የ Mini App ፋይሎችን (index.html) ማስተናገጃ
app.use(express.static(path.join(__dirname, 'public')));

// የአድሚን ጥበቃ Middleware
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  next();
}

// ═════════════════════ SQL DATABASE SETUP ═════════════════════
const db = new sqlite3.Database('./binance_et.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('✅ SQLite Database Connected: binance_et.db');
});

db.serialize(() => {
  // 1. Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    balance_usd REAL DEFAULT 0.00,
    welcome_claimed INTEGER DEFAULT 0,
    stage1_claimed INTEGER DEFAULT 0,
    stage2_claimed INTEGER DEFAULT 0,
    stage3_claimed INTEGER DEFAULT 0,
    stage4_claimed INTEGER DEFAULT 0,
    referred_by TEXT DEFAULT NULL,
    last_spin_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 2. Referrals
  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id TEXT NOT NULL,
    referred_id TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'ACTIVE',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 3. Deposits
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount REAL NOT NULL,
    amount_usd REAL NOT NULL,
    payment_method TEXT NOT NULL,
    transaction_ref TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 4. Withdrawals
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    amount_etb REAL NOT NULL,
    payment_method TEXT NOT NULL,
    account_number TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 5. Virtual Visa Cards
  db.run(`CREATE TABLE IF NOT EXISTS virtual_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    card_number TEXT NOT NULL,
    expiry TEXT NOT NULL,
    cvv TEXT NOT NULL,
    balance_usd REAL DEFAULT 0.00,
    status TEXT DEFAULT 'ACTIVE',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 6. Virtual Phone Orders
  db.run(`CREATE TABLE IF NOT EXISTS phone_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    country TEXT NOT NULL,
    service TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    otp_code TEXT NOT NULL,
    status TEXT DEFAULT 'ACTIVE',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 7. Transaction Audit Log
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ═════════════════════ TELEGRAM & BROADCAST ENGINE ═════════════════════

let broadcastJob = {
  running:   false,
  paused:    false,
  stop:      false,
  sent:      0,
  failed:    0,
  total:     0,
  startedAt: null,
  log:       []
};

// ለአድሚኑ ቀጥታ ቴሌግራም ላይ የማሳወቂያ መልእክት መላኪያ
async function notifyAdmin(message) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await fetch(TG_MESSAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('Failed to notify admin:', e.message);
  }
}

// {username} ተጠቃሚ ስም መተኪያ
function personalise(text, username) {
  const name = (username && username !== 'None' && username !== 'undefined' && username.trim() !== '')
    ? username.trim()
    : 'ተጠቃሚ';
  return text.replace(/\{username\}/gi, name);
}

// Markdown → Telegram HTML Converter
function mdToHtml(text) {
  return text
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
}

// አንድ መልእክት ለተጠቃሚ መላክ
async function sendToUser(uid, rawText, username, photo, replyMarkup) {
  const personalised = personalise(rawText, username);
  const htmlText = mdToHtml(personalised);

  // 1. Try Photo
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

  // 2. Try Text
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

// የብሮድካስት ስራ መቆጣጠሪያ
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
      appendLog('⏹️ Stopped by admin at ' + i);
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
      appendLog('⚠️ Rate limited — waiting ' + result.wait + 's');
      await sleep(result.wait * 1000);
      i--;
      continue;
    }

    if (result.success) {
      broadcastJob.sent++;
    } else {
      broadcastJob.failed++;
      appendLog('❌ ' + userId + ': ' + (result.reason || 'unknown'));
    }

    await sleep(35); // ~28 msgs/sec
  }

  broadcastJob.running = false;
  appendLog('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}

function appendLog(msg) {
  broadcastJob.log.push(msg);
  if (broadcastJob.log.length > 150) broadcastJob.log.shift(); // Memory leak guard
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchUsers() {
  if (!SHEET_URL) throw new Error('SHEET_URL env variable not set');
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error('Failed to fetch sheet: ' + res.status);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) throw new Error('Sheet is empty');

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  let userIdCol = headers.findIndex(h =>
    h === '_id' || h === 'userid' || h === 'user_id' ||
    h === 'chat_id' || h === 'telegramid' || h === 'telegram_id' ||
    h.includes('userid') || h.includes('user_id') || h.includes('chat_id')
  );
  if (userIdCol === -1) userIdCol = 0;

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

// ═════════════════════ BINANCE ET MINI APP REST APIS ═════════════════════

// 1. መግቢያና መረጃ ማመሳከሪያ (Auth / Sync)
app.post('/api/auth', (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!user) {
      const validRef = (ref_by && ref_by !== telegram_id.toString()) ? ref_by : null;
      db.run(
        `INSERT INTO users (telegram_id, first_name, last_name, username, balance_usd, referred_by) 
         VALUES (?, ?, ?, ?, 0.00, ?)`,
        [telegram_id.toString(), first_name || 'User', last_name || '', username || '', validRef],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          if (validRef) {
            db.run(`INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)`, [validRef, telegram_id.toString()]);
          }

          notifyAdmin(`👤 <b>አዲስ ተጠቃሚ ተመዝግቧል:</b>\nስም: ${first_name}\nID: <code>${telegram_id}</code>\nጋባዥ: ${validRef || 'የለም'}`);

          db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, newUser) => {
            res.json({ user: newUser, isNew: true });
          });
        }
      );
    } else {
      res.json({ user, isNew: false });
    }
  });
});

// 2. የ $0.50 ዌልካም ቦነስ (Atomic Update - No Double Claiming)
app.post('/api/claim-welcome', (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.50;

  db.run(
    `UPDATE users SET balance_usd = balance_usd + ?, welcome_claimed = 1 
     WHERE telegram_id = ? AND welcome_claimed = 0`,
    [BONUS_USD, telegram_id.toString()],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) {
        return res.status(400).json({ error: 'ቦነሱ አስቀድሞ ተወስዷል ወይም ተጠቃሚው አልተገኘም!' });
      }

      db.run(
        `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES (?, 'WELCOME_BONUS', ?, 'Welcome Gift')`,
        [telegram_id.toString(), BONUS_USD]
      );

      db.get('SELECT balance_usd FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, u) => {
        res.json({ success: true, balance_usd: u.balance_usd, message: '🎉 $0.50 USD Welcome Bonus Credited!' });
      });
    }
  );
});

// 3. የ 4ቱ ደረጃዎች ሽልማቶች (Stages 1, 2, 3, 4)
app.post('/api/claim-stage', (req, res) => {
  const { telegram_id, stage } = req.body;
  const stageNum = parseInt(stage);

  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });

    let rewardUSD = 0;
    let col = '';
    let prereqCheck = true;

    if (stageNum === 1) {
      if (user.stage1_claimed === 1) return res.status(400).json({ error: 'Stage 1 already claimed' });
      rewardUSD = 1.00; col = 'stage1_claimed';
    } else if (stageNum === 2) {
      if (user.stage1_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 1 first' });
      if (user.stage2_claimed === 1) return res.status(400).json({ error: 'Stage 2 already claimed' });
      rewardUSD = 2.50; col = 'stage2_claimed';
    } else if (stageNum === 3) {
      if (user.stage2_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 2 first' });
      if (user.stage3_claimed === 1) return res.status(400).json({ error: 'Stage 3 already claimed' });
      rewardUSD = 5.00; col = 'stage3_claimed';
    } else if (stageNum === 4) {
      if (user.stage3_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 3 first' });
      if (user.stage4_claimed === 1) return res.status(400).json({ error: 'Stage 4 already claimed' });
      rewardUSD = 40.00; col = 'stage4_claimed'; // $40.00 VIP Champion
    } else {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    db.run(
      `UPDATE users SET balance_usd = balance_usd + ?, ${col} = 1 WHERE telegram_id = ? AND ${col} = 0`,
      [rewardUSD, telegram_id.toString()],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(400).json({ error: 'Stage already claimed' });

        db.run(
          `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES (?, 'STAGE_REWARD', ?, ?)`,
          [telegram_id.toString(), rewardUSD, `Stage ${stageNum} Task Reward`]
        );

        db.get('SELECT balance_usd FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, u) => {
          res.json({ success: true, reward_usd: rewardUSD, balance_usd: u.balance_usd });
        });
      }
    );
  });
});

// 4. ተቀማጭ ማስገቢያ (Deposit Submission)
app.post('/api/deposit/submit', (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref } = req.body;
  if (!transaction_ref || !amount) return res.status(400).json({ error: 'Amount and TxID are required' });

  db.get('SELECT * FROM deposits WHERE transaction_ref = ?', [transaction_ref.trim()], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (existing) return res.status(400).json({ error: 'ይህ የደረሰኝ ቁጥር አስቀድሞ አገልግሎት ላይ ውሏል!' });

    const amountVal = parseFloat(amount);
    const amountUSD = currency === 'ETB' ? (amountVal / FX_RATE) : amountVal;

    db.run(
      `INSERT INTO deposits (telegram_id, currency, amount, amount_usd, payment_method, transaction_ref) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [telegram_id.toString(), currency, amountVal, amountUSD, payment_method, transaction_ref.trim()],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        notifyAdmin(
          `💰 <b>አዲስ ተቀማጭ ክፍያ (Deposit):</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>${amountVal} ${currency}</b> (≈ $${amountUSD.toFixed(2)})\n🏦 መንገድ: ${payment_method}\n🧾 ደረሰኝ: <code>${transaction_ref}</code>`
        );

        res.json({
          success: true,
          message: 'የክፍያ ማረጋገጫዎ ደርሶናል፤ ተጣርቶ በ 5-15 ደቂቃ ውስጥ አካውንትዎ ላይ ገቢ ይደረጋል።',
          deposit_id: this.lastID
        });
      }
    );
  });
});

// 5. ቪዛ ካርድ ማዘዣ ($1.50 / 200 ETB)
app.post('/api/cards/order', (req, res) => {
  const { telegram_id, transaction_ref } = req.body;
  if (!transaction_ref) return res.status(400).json({ error: 'የደረሰኝ ቁጥር (TxID) ያስገቡ' });

  const randomCard = '4129 ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000);
  const randomCVV = Math.floor(100 + Math.random() * 900).toString();

  db.run(
    `INSERT INTO virtual_cards (telegram_id, card_number, expiry, cvv, balance_usd, status) 
     VALUES (?, ?, '12/29', ?, 0.00, 'ACTIVE')`,
    [telegram_id.toString(), randomCard, randomCVV],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES (?, 'CARD_ORDER', 1.50, 'Virtual Visa Activation')`,
        [telegram_id.toString()]
      );

      notifyAdmin(`💳 <b>አዲስ የቪዛ ካርድ ትዕዛዝ:</b>\n👤 ID: <code>${telegram_id}</code>\n🧾 ደረሰኝ: <code>${transaction_ref}</code>\n💳 ካርድ: <code>${randomCard}</code>`);

      res.json({
        success: true,
        message: '🎉 ቪዛ ካርድዎ በተሳካ ሁኔታ ተፈጥሯል!',
        card: { number: randomCard, expiry: '12/29', cvv: randomCVV, balance_usd: 0.00 }
      });
    }
  );
});

// 6. የውጭ ስልክ ቁጥር ማዘዣ ($1.50 / 200 ETB)
app.post('/api/services/buy-number', (req, res) => {
  const { telegram_id, country, service } = req.body;
  const fakePhone = (country === 'UK' ? '+44 ' : '+1 ') + Math.floor(2000000000 + Math.random() * 8000000000);
  const fakeOTP = Math.floor(100000 + Math.random() * 900000).toString();

  db.run(
    `INSERT INTO phone_orders (telegram_id, country, service, phone_number, otp_code) 
     VALUES (?, ?, ?, ?, ?)`,
    [telegram_id.toString(), country || 'US', service || 'TikTok', fakePhone, fakeOTP],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES (?, 'PHONE_ORDER', 1.50, ?)`,
        [telegram_id.toString(), `Virtual Number for ${service}`]
      );

      res.json({
        success: true,
        phone_number: fakePhone,
        otp_code: fakeOTP,
        service: service
      });
    }
  );
});

// 7. ብር ማውጣት (Withdrawal - Atomic Deduct with Minimum $2.00 / 250 ETB)
app.post('/api/withdraw', (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);

  if (amount < 2.00) {
    return res.status(400).json({ error: 'ዝቅተኛው የማውጣት መጠን $2.00 USD (250 ETB) ነው።' });
  }

  // Atomic deduction: prevents spending balance twice
  db.run(
    `UPDATE users SET balance_usd = balance_usd - ? WHERE telegram_id = ? AND balance_usd >= ?`,
    [amount, telegram_id.toString(), amount],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) {
        return res.status(400).json({ error: 'በቂ ቀሪ ሂሳብ የለዎትም!' });
      }

      const amountETB = amount * FX_RATE;
      db.run(
        `INSERT INTO withdrawals (telegram_id, amount_usd, amount_etb, payment_method, account_number) 
         VALUES (?, ?, ?, ?, ?)`,
        [telegram_id.toString(), amount, amountETB, payment_method, account_number]
      );

      notifyAdmin(
        `🚨 <b>አዲስ የገንዘብ ማውጣት ጥያቄ:</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>$${amount} USD</b> (${amountETB} ETB)\n🏦 መንገድ: ${payment_method}\n💳 አካውንት: <code>${account_number}</code>`
      );

      db.get('SELECT balance_usd FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, u) => {
        res.json({
          success: true,
          balance_usd: u.balance_usd,
          message: 'የማውጣት ጥያቄዎ ደርሷል፤ በቅርቡ ወደ አካውንትዎ ይላካል!'
        });
      });
    }
  );
});

// 8. Daily Spin (Max 1 per 24 hours)
app.post('/api/daily-spin', (req, res) => {
  const { telegram_id } = req.body;
  const now = new Date();

  db.get('SELECT balance_usd, last_spin_at FROM users WHERE telegram_id = ?', [telegram_id.toString()], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });

    if (user.last_spin_at) {
      const hoursDiff = (now - new Date(user.last_spin_at)) / (1000 * 60 * 60);
      if (hoursDiff < 24) {
        return res.status(400).json({ error: `የቀጣይ ዕድል በ ${(24 - hoursDiff).toFixed(1)} ሰዓት ውስጥ ይከፈታል።` });
      }
    }

    const wonUSD = parseFloat(((Math.random() * 0.20) + 0.05).toFixed(2));
    db.run(
      'UPDATE users SET balance_usd = balance_usd + ?, last_spin_at = ? WHERE telegram_id = ?',
      [wonUSD, now.toISOString(), telegram_id.toString()],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, won_usd: wonUSD, balance_usd: user.balance_usd + wonUSD });
      }
    );
  });
});

// 9. Live P2P Orders
app.get('/api/p2p-orders', (req, res) => {
  res.json([
    { merchant: 'Abebe_Crypto_ET', rate: 120.50, limit: '$5 - $500', methods: ['Telebirr', 'CBE'] },
    { merchant: 'EthioFin_Express', rate: 120.75, limit: '$10 - $1,000', methods: ['CBE', 'Abyssinia'] },
    { merchant: 'Selam_P2P_Merchant', rate: 120.60, limit: '$5 - $250', methods: ['Telebirr'] }
  ]);
});

// ═════════════════════ ADMIN MANAGEMENT ROUTES ═════════════════════

// ያልጸደቁ ዲፖዚቶችንና ገንዘብ ማውጫዎችን ማሳያ
app.get('/api/admin/pending', auth, (req, res) => {
  db.all('SELECT * FROM deposits WHERE status = "PENDING" ORDER BY id DESC', [], (err, deps) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM withdrawals WHERE status = "PENDING" ORDER BY id DESC', [], (err, withs) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ pending_deposits: deps, pending_withdrawals: withs });
    });
  });
});

// ዲፖዚት ማጽደቂያ
app.post('/api/admin/approve-deposit', auth, (req, res) => {
  const { deposit_id } = req.body;
  db.get('SELECT * FROM deposits WHERE id = ? AND status = "PENDING"', [deposit_id], (err, deposit) => {
    if (err || !deposit) return res.status(404).json({ error: 'Deposit not found or already processed' });

    db.run('UPDATE users SET balance_usd = balance_usd + ? WHERE telegram_id = ?', [deposit.amount_usd, deposit.telegram_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE deposits SET status = "APPROVED" WHERE id = ?', [deposit_id]);
      res.json({ success: true, message: `Deposit of $${deposit.amount_usd} USD approved!` });
    });
  });
});

// ═════════════════════ BROADCAST API ROUTES (100% PRESERVED) ═════════════════════

// Health check
app.get('/status', (req, res) => res.json({
  server:    'Binance Ethiopia & Swap Broadcast Unified Server running ✅',
  bot_token: BOT_TOKEN ? '✅ Set' : '❌ Missing',
  sheet_url: SHEET_URL ? '✅ Set' : '❌ Missing',
  admin_key: ADMIN_KEY ? '✅ Set' : '❌ Missing',
  broadcast: broadcastJob.running
    ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}`
    : '⏹️ Idle',
  tip: 'Message ውስጥ {username} ጻፍ — እያንዳንዱ ሰው ስሙ ይደርሰዋል ✅'
}));

// Start broadcast
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

  // Priority 1: Segmented with username
  if (Array.isArray(usersPayload) && usersPayload.length > 0) {
    users = usersPayload.map(u => ({
      userId:   String(u.userId || u.id || ''),
      username: u.username || u.name || ''
    })).filter(u => u.userId);
    console.log(`[broadcast] Segmented (with username) — ${users.length} users`);

  // Priority 2: IDs only
  } else if (Array.isArray(user_ids) && user_ids.length > 0) {
    users = user_ids.map(id => ({ userId: String(id), username: '' }));
    console.log(`[broadcast] Segmented (ids only) — ${users.length} users`);

  // Priority 3: All-users from sheet
  } else {
    try {
      users = await fetchUsers();
      console.log(`[broadcast] All-users from sheet — ${users.length} users`);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch users: ' + e.message });
    }
    if (users.length === 0) return res.status(404).json({ error: 'No users found in sheet' });
  }

  runBroadcast(users, text, photo || '', replyMarkup);
  res.json({ ok: true, message: 'Broadcast started', total: users.length });
});

// Pause broadcast
app.post('/broadcast/pause', auth, (req, res) => {
  if (!broadcastJob.running) return res.status(400).json({ error: 'No broadcast running' });
  broadcastJob.paused = true;
  res.json({ ok: true, message: 'Paused' });
});

// Resume broadcast
app.post('/broadcast/resume', auth, (req, res) => {
  broadcastJob.paused = false;
  res.json({ ok: true, message: 'Resumed' });
});

// Stop broadcast
app.post('/broadcast/stop', auth, (req, res) => {
  broadcastJob.stop    = true;
  broadcastJob.running = false;
  broadcastJob.paused  = false;
  res.json({ ok: true, message: 'Stopped' });
});

// Status poll
app.get('/broadcast/status', auth, (req, res) => {
  res.json({
    running:   broadcastJob.running,
    paused:    broadcastJob.paused,
    sent:      broadcastJob.sent,
    failed:    broadcastJob.failed,
    total:     broadcastJob.total,
    pct:       broadcastJob.total ? Math.round((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total * 100) : 0,
    startedAt: broadcastJob.startedAt,
    lastLog:   broadcastJob.log.slice(-4)
  });
});

// ═════════════════════ CRASH PREVENTION & PROCESS LISTENERS ═════════════════════
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ═════════════════════ START SERVER ═════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Unified Binance ET + Broadcast Server running on port ${PORT}`);
});
