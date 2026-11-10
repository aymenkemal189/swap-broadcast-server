const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// ═════════════════════ CONFIGURATION ═════════════════════
const PORT          = process.env.PORT || 3000;

// 1. የ Binance Mini App Bot ውቅረት (App & Admin Notifications)
const BINANCE_BOT_TOKEN = process.env.BINANCE_BOT_TOKEN || process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const BINANCE_BOT_USER  = process.env.BINANCE_BOT_USERNAME || 'BinanceEthioBot';
const ADMIN_CHAT_ID     = process.env.ADMIN_CHAT_ID;

// 2. የ Broadcast Bot ውቅረት (Mass-Messaging Engine)
const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const ADMIN_KEY           = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL           = process.env.SHEET_URL; 

// 3. እውነተኛ የክፍያ መረጃዎችና የሰርቨር አድራሻ
const CBE_ACCOUNT     = '1000562339427';
const TELEBIRR_PHONE  = '0996910607';
const VERIFY_SERVER   = process.env.VERIFY_SERVER_URL || 'https://verifiy-server.app.aletcloud.com';
const VERIFY_SECRET   = process.env.VERIFY_SECRET || process.env.VERIFY_TOKEN || '';
const FX_RATE         = 120.00; // 1 USD = 120.00 ETB

// 4. የቦቶች Telegram API Endpoints መለያየት
const TG_APP_MESSAGE = `https://api.telegram.org/bot${BINANCE_BOT_TOKEN}/sendMessage`;
const TG_BC_PHOTO    = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendPhoto`;
const TG_BC_MESSAGE  = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendMessage`;

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

function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  next();
}

// ═════════════════════ NEON POSTGRESQL POOL ═════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// የዳታቤዝ ሰንጠረዦችን ማስጀመር (Auto-Migration)
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        balance_usd NUMERIC(14, 2) DEFAULT 0.00,
        welcome_claimed INT DEFAULT 0,
        stage1_claimed INT DEFAULT 0,
        stage2_claimed INT DEFAULT 0,
        stage3_claimed INT DEFAULT 0,
        stage4_claimed INT DEFAULT 0,
        referred_by VARCHAR(64) DEFAULT NULL,
        last_spin_at TIMESTAMPTZ DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id VARCHAR(64) NOT NULL,
        referred_id VARCHAR(64) UNIQUE NOT NULL,
        status TEXT DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        amount NUMERIC(14, 2) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        transaction_ref VARCHAR(128) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        amount_etb NUMERIC(14, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        account_number VARCHAR(128) NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS virtual_cards (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        card_number VARCHAR(32) NOT NULL,
        expiry VARCHAR(10) NOT NULL,
        cvv VARCHAR(5) NOT NULL,
        balance_usd NUMERIC(14, 2) DEFAULT 0.00,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS phone_orders (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        country VARCHAR(10) NOT NULL,
        service VARCHAR(64) NOT NULL,
        phone_number VARCHAR(32) NOT NULL,
        otp_code VARCHAR(16) NOT NULL,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        type VARCHAR(32) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Neon PostgreSQL Database Connected & Initialized.');
  } catch (err) {
    console.error('❌ Neon Database connection error:', err.message);
  }
}
initDB();

// ═════════════════════ VERIFY SERVER INTEGRATION ═════════════════════
async function checkWithVerifyServer(method, ref, amount) {
  if (!VERIFY_SECRET) {
    return { verified: false, manual: true };
  }
  try {
    const targetAccount = method.toLowerCase().includes('tele') ? TELEBIRR_PHONE : CBE_ACCOUNT;
    const resp = await fetch(`${VERIFY_SERVER}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VERIFY_SECRET}`,
        'x-secret-token': VERIFY_SECRET
      },
      body: JSON.stringify({
        method: method.toLowerCase().includes('tele') ? 'telebirr' : 'cbe',
        account: targetAccount,
        transaction_ref: ref.trim(),
        amount: parseFloat(amount)
      })
    });
    const result = await resp.json();
    return result;
  } catch (err) {
    console.warn('Verify server check warning:', err.message);
    return { verified: false, manual: true };
  }
}

// ═════════════════════ TELEGRAM HELPER FUNCTIONS ═════════════════════

// ለአድሚኑ በ BINANCE BOT በኩል ኖቲፊኬሽን መላኪያ
async function notifyAdmin(message) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await fetch(TG_APP_MESSAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('Failed to notify admin via Binance Bot:', e.message);
  }
}

function personalise(text, username) {
  const name = (username && username !== 'None' && username !== 'undefined' && username.trim() !== '')
    ? username.trim()
    : 'ተጠቃሚ';
  return text.replace(/\{username\}/gi, name);
}

function mdToHtml(text) {
  return text
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
}

// በ BROADCAST BOT በኩል ማስታወቂያ ለአንድ ተጠቃሚ መላኪያ
async function sendToUser(uid, rawText, username, photo, replyMarkup) {
  const personalised = personalise(rawText, username);
  const htmlText = mdToHtml(personalised);

  if (photo) {
    try {
      const body = { chat_id: uid, photo, caption: htmlText, parse_mode: 'HTML' };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const r = await fetch(TG_BC_PHOTO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.ok) return { success: true };
      if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    } catch (_) {}
  }

  try {
    const body = { chat_id: uid, text: htmlText, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(TG_BC_MESSAGE, {
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

// ═════════════════════ BROADCAST RUNNER ═════════════════════
let broadcastJob = {
  running: false, paused: false, stop: false, sent: 0, failed: 0, total: 0, startedAt: null, log: []
};

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

    await sleep(35); // ~28 msgs/sec — Telegram Safe Rate
  }

  broadcastJob.running = false;
  appendLog('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}

function appendLog(msg) {
  broadcastJob.log.push(msg);
  if (broadcastJob.log.length > 150) broadcastJob.log.shift(); // Memory Leak Guard
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
    h === '_id' || h === 'userid' || h === 'user_id' || h === 'chat_id' || h.includes('userid') || h.includes('user_id')
  );
  if (userIdCol === -1) userIdCol = 0;

  let usernameCol = headers.findIndex(h => h === 'username' || h === 'user_name' || h.includes('username'));

  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const uid  = cols[userIdCol];
    if (uid && uid !== 'None' && uid !== 'undefined' && uid !== '') {
      users.push({ userId: uid, username: usernameCol >= 0 ? (cols[usernameCol] || '') : '' });
    }
  }
  return users;
}

// ═════════════════════ BINANCE ET MINI APP REST APIS ═════════════════════

// 1. User Sync / Auth
app.post('/api/auth', async (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (userResult.rows.length === 0) {
      const validRef = (ref_by && ref_by !== telegram_id.toString()) ? ref_by : null;
      const insertResult = await pool.query(
        `INSERT INTO users (telegram_id, first_name, last_name, username, balance_usd, referred_by) 
         VALUES ($1, $2, $3, $4, 0.00, $5) RETURNING *`,
        [telegram_id.toString(), first_name || 'User', last_name || '', username || '', validRef]
      );

      if (validRef) {
        await pool.query(
          `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [validRef, telegram_id.toString()]
        );
      }

      // ለባለቤቱ በ Binance Bot በኩል ማሳወቅ
      notifyAdmin(`👤 <b>አዲስ ተጠቃሚ ተመዝግቧል:</b>\nስም: ${first_name}\nID: <code>${telegram_id}</code>\nጋባዥ: ${validRef || 'የለም'}`);
      return res.json({ user: insertResult.rows[0], isNew: true });
    }
    res.json({ user: userResult.rows[0], isNew: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Welcome Bonus ($0.50 USD)
app.post('/api/claim-welcome', async (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.50;

  try {
    const update = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, welcome_claimed = 1 
       WHERE telegram_id = $2 AND welcome_claimed = 0 RETURNING balance_usd`,
      [BONUS_USD, telegram_id.toString()]
    );

    if (update.rowCount === 0) {
      return res.status(400).json({ error: 'ቦነሱ አስቀድሞ ተወስዷል ወይም ተጠቃሚው አልተገኘም!' });
    }

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'WELCOME_BONUS', $2, 'Welcome Gift')`,
      [telegram_id.toString(), BONUS_USD]
    );

    res.json({ success: true, balance_usd: parseFloat(update.rows[0].balance_usd), message: '🎉 $0.50 USD Welcome Bonus Credited!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 4 Prize Stages
app.post('/api/claim-stage', async (req, res) => {
  const { telegram_id, stage } = req.body;
  const stageNum = parseInt(stage);

  try {
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = uRes.rows[0];

    let rewardUSD = 0;
    let col = '';

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

    const upRes = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, ${col} = 1 
       WHERE telegram_id = $2 AND ${col} = 0 RETURNING balance_usd`,
      [rewardUSD, telegram_id.toString()]
    );

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'STAGE_REWARD', $2, $3)`,
      [telegram_id.toString(), rewardUSD, `Stage ${stageNum} Task Reward`]
    );

    res.json({ success: true, reward_usd: rewardUSD, balance_usd: parseFloat(upRes.rows[0].balance_usd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Deposit Submission (CBE: 1000562339427 & Telebirr: 0996910607)
app.post('/api/deposit/submit', async (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref } = req.body;
  if (!transaction_ref || !amount) return res.status(400).json({ error: 'Amount and TxID are required' });

  const amountVal = parseFloat(amount);
  const amountUSD = currency === 'ETB' ? (amountVal / FX_RATE) : amountVal;

  try {
    const exist = await pool.query('SELECT * FROM deposits WHERE transaction_ref = $1', [transaction_ref.trim()]);
    if (exist.rows.length > 0) return res.status(400).json({ error: 'ይህ የደረሰኝ ቁጥር አስቀድሞ አገልግሎት ላይ ውሏል!' });

    // የክፍያ ማረጋገጫ ሰርቨርን መፈተሽ
    const verification = await checkWithVerifyServer(payment_method, transaction_ref, amountVal);

    let status = 'PENDING';
    if (verification && (verification.verified === true || verification.status === 'SUCCESS')) {
      status = 'APPROVED';
      await pool.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [amountUSD, telegram_id.toString()]);
      await pool.query(
        `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'DEPOSIT', $2, $3)`,
        [telegram_id.toString(), amountUSD, `Auto-Verified Deposit: ${transaction_ref}`]
      );
    }

    const ins = await pool.query(
      `INSERT INTO deposits (telegram_id, currency, amount, amount_usd, payment_method, transaction_ref, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [telegram_id.toString(), currency, amountVal, amountUSD, payment_method, transaction_ref.trim(), status]
    );

    notifyAdmin(
      `💰 <b>ተቀማጭ ክፍያ (${status}):</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>${amountVal} ${currency}</b> (≈ $${amountUSD.toFixed(2)})\n🏦 መንገድ: ${payment_method}\n🧾 ደረሰኝ: <code>${transaction_ref}</code>\n🤖 ፍተሻ: ${status === 'APPROVED' ? '✅ በራስ-ሰር ጸድቋል' : '⏳ ማረጋገጫ ይጠብቃል'}`
    );

    res.json({
      success: true,
      verified: status === 'APPROVED',
      message: status === 'APPROVED' 
        ? `🎉 ክፍያዎ በራስ-ሰር ተረጋግጦ $${amountUSD.toFixed(2)} ገቢ ሆኗል!` 
        : 'የክፍያ ማረጋገጫዎ ደርሶናል፤ ተጣርቶ በ 5-15 ደቂቃ ውስጥ አካውንትዎ ላይ ገቢ ይደረጋል።',
      deposit_id: ins.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ቪዛ ካርድ ማዘዣ ($1.50 / 200 ETB)
app.post('/api/cards/order', async (req, res) => {
  const { telegram_id, transaction_ref } = req.body;
  if (!transaction_ref) return res.status(400).json({ error: 'የደረሰኝ ቁጥር (TxID) ያስገቡ' });

  const randomCard = '4129 ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000);
  const randomCVV = Math.floor(100 + Math.random() * 900).toString();

  try {
    await pool.query(
      `INSERT INTO virtual_cards (telegram_id, card_number, expiry, cvv, balance_usd, status) 
       VALUES ($1, $2, '12/29', $3, 0.00, 'ACTIVE')`,
      [telegram_id.toString(), randomCard, randomCVV]
    );

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'CARD_ORDER', 1.50, 'Virtual Visa Activation')`,
      [telegram_id.toString()]
    );

    notifyAdmin(`💳 <b>አዲስ የቪዛ ካርድ ትዕዛዝ:</b>\n👤 ID: <code>${telegram_id}</code>\n🧾 ደረሰኝ: <code>${transaction_ref}</code>\n💳 ካርድ: <code>${randomCard}</code>`);

    res.json({
      success: true,
      message: '🎉 ቪዛ ካርድዎ በተሳካ ሁኔታ ተፈጥሯል!',
      card: { number: randomCard, expiry: '12/29', cvv: randomCVV, balance_usd: 0.00 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. የውጭ ስልክ ቁጥር ማዘዣ ($1.50 / 200 ETB)
app.post('/api/services/buy-number', async (req, res) => {
  const { telegram_id, country, service } = req.body;
  const fakePhone = (country === 'UK' ? '+44 ' : '+1 ') + Math.floor(2000000000 + Math.random() * 8000000000);
  const fakeOTP = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await pool.query(
      `INSERT INTO phone_orders (telegram_id, country, service, phone_number, otp_code) 
       VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id.toString(), country || 'US', service || 'TikTok', fakePhone, fakeOTP]
    );

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'PHONE_ORDER', 1.50, $2)`,
      [telegram_id.toString(), `Virtual Number for ${service}`]
    );

    res.json({
      success: true,
      phone_number: fakePhone,
      otp_code: fakeOTP,
      service: service
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. ብር ማውጣት (Withdrawal - Atomic Deduct with Minimum $2.00 / 250 ETB)
app.post('/api/withdraw', async (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);

  if (amount < 2.00) return res.status(400).json({ error: 'ዝቅተኛው የማውጣት መጠን $2.00 USD (250 ETB) ነው።' });

  try {
    const deduct = await pool.query(
      `UPDATE users SET balance_usd = balance_usd - $1 
       WHERE telegram_id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
      [amount, telegram_id.toString()]
    );

    if (deduct.rowCount === 0) return res.status(400).json({ error: 'በቂ ቀሪ ሂሳብ የለዎትም!' });

    const amountETB = amount * FX_RATE;
    await pool.query(
      `INSERT INTO withdrawals (telegram_id, amount_usd, amount_etb, payment_method, account_number) 
       VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id.toString(), amount, amountETB, payment_method, account_number]
    );

    notifyAdmin(
      `🚨 <b>አዲስ የገንዘብ ማውጣት ጥያቄ:</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>$${amount} USD</b> (${amountETB} ETB)\n🏦 መንገድ: ${payment_method}\n💳 አካውንት: <code>${account_number}</code>`
    );

    res.json({
      success: true,
      balance_usd: parseFloat(deduct.rows[0].balance_usd),
      message: 'የማውጣት ጥያቄዎ ደርሷል፤ በቅርቡ ወደ አካውንትዎ ይላካል!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Daily Spin
app.post('/api/daily-spin', async (req, res) => {
  const { telegram_id } = req.body;
  const now = new Date();

  try {
    const uRes = await pool.query('SELECT balance_usd, last_spin_at FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = uRes.rows[0];

    if (user.last_spin_at) {
      const hoursDiff = (now - new Date(user.last_spin_at)) / (1000 * 60 * 60);
      if (hoursDiff < 24) {
        return res.status(400).json({ error: `የቀጣይ ዕድል በ ${(24 - hoursDiff).toFixed(1)} ሰዓት ውስጥ ይከፈታል።` });
      }
    }

    const wonUSD = parseFloat(((Math.random() * 0.20) + 0.05).toFixed(2));
    const up = await pool.query(
      'UPDATE users SET balance_usd = balance_usd + $1, last_spin_at = $2 WHERE telegram_id = $3 RETURNING balance_usd',
      [wonUSD, now.toISOString(), telegram_id.toString()]
    );

    res.json({ success: true, won_usd: wonUSD, balance_usd: parseFloat(up.rows[0].balance_usd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════ BROADCAST API ROUTES (100% PRESERVED) ═════════════════════

// Health check
app.get('/status', (req, res) => res.json({
  server:        'Unified Binance ET (App) + Swap Broadcast (Marketing) Server running ✅',
  app_bot:       BINANCE_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  broadcast_bot: BROADCAST_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  sheet_url:     SHEET_URL ? '✅ Set' : '❌ Missing',
  broadcast:     broadcastJob.running ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}` : '⏹️ Idle'
}));

// Start Broadcast
app.post('/broadcast/start', auth, async (req, res) => {
  if (broadcastJob.running) return res.status(409).json({ error: 'Broadcast already running. Stop it first.' });

  const { text, photo, btnText, btnUrl, users: usersPayload, user_ids } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  let replyMarkup = null;
  if (btnText && btnUrl && btnUrl.startsWith('http')) {
    replyMarkup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
  }

  let users;
  if (Array.isArray(usersPayload) && usersPayload.length > 0) {
    users = usersPayload.map(u => ({ userId: String(u.userId || u.id || ''), username: u.username || u.name || '' })).filter(u => u.userId);
  } else if (Array.isArray(user_ids) && user_ids.length > 0) {
    users = user_ids.map(id => ({ userId: String(id), username: '' }));
  } else {
    try { users = await fetchUsers(); } catch (e) { return res.status(500).json({ error: 'Failed to fetch users: ' + e.message }); }
  }

  runBroadcast(users, text, photo || '', replyMarkup);
  res.json({ ok: true, message: 'Broadcast started', total: users.length });
});

app.post('/broadcast/pause', auth, (req, res) => {
  if (!broadcastJob.running) return res.status(400).json({ error: 'No broadcast running' });
  broadcastJob.paused = true;
  res.json({ ok: true, message: 'Paused' });
});

app.post('/broadcast/resume', auth, (req, res) => {
  broadcastJob.paused = false;
  res.json({ ok: true, message: 'Resumed' });
});

app.post('/broadcast/stop', auth, (req, res) => {
  broadcastJob.stop    = true;
  broadcastJob.running = false;
  broadcastJob.paused  = false;
  res.json({ ok: true, message: 'Stopped' });
});

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
