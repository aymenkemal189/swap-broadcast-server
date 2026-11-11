const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// ═════════════════════ CONFIGURATION ═════════════════════
const PORT          = process.env.PORT || 3000;
const HOST          = '0.0.0.0';

// 1. የቦቶች መለያየት (App Bot vs Broadcast Bot)
const BINANCE_BOT_TOKEN   = process.env.BINANCE_BOT_TOKEN || process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const BINANCE_BOT_USER    = process.env.BINANCE_BOT_USERNAME || 'BinanceEthioBot';
const ADMIN_CHAT_ID       = process.env.ADMIN_CHAT_ID;

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const ADMIN_KEY           = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL           = process.env.SHEET_URL; 

// 2. እውነተኛ የክፍያ መረጃዎችና Verify Server
const CBE_ACCOUNT     = '1000562339427';
const TELEBIRR_PHONE  = '0996910607';
const VERIFY_SERVER   = process.env.VERIFY_SERVER_URL || 'https://verifiy-server.app.aletcloud.com';
const VERIFY_SECRET   = process.env.VERIFY_SECRET || process.env.VERIFY_TOKEN || '';

// 3. ተለዋዋጭ የዶላር ምንዛሬ (Dynamic FX Rate - አሁን በ 194.00 ETB)
let CURRENT_FX_RATE = 194.00;

// 4. የቦቶች Telegram API Endpoints
const TG_APP_MESSAGE = `https://api.telegram.org/bot${BINANCE_BOT_TOKEN}/sendMessage`;
const TG_BC_PHOTO    = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendPhoto`;
const TG_BC_MESSAGE  = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendMessage`;

// ═════════════════════ ROBUST CORS (FOR GITHUB PAGES) ═════════════════════
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// የ Mini App ፋይሎችን ማስተናገጃ
app.use(express.static(path.join(__dirname, 'public')));

// የአድሚን ጥበቃ Middleware
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  next();
}

// ═════════════════════ NEON POSTGRESQL POOL ═════════════════════
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  pool.on('error', (err) => {
    console.error('Postgres client error on pool:', err.message);
  });
} else {
  console.warn('⚠️ DATABASE_URL is not set in Environment Variables!');
}

// የዳታቤዝ ሰንጠረዦችን ማስጀመር (Auto-Migration)
async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        phone_number VARCHAR(32) DEFAULT NULL,
        balance_usd NUMERIC(14, 2) DEFAULT 0.00,
        welcome_claimed INT DEFAULT 0,
        stage1_claimed INT DEFAULT 0,
        stage2_claimed INT DEFAULT 0,
        stage3_claimed INT DEFAULT 0,
        stage4_claimed INT DEFAULT 0,
        referred_by VARCHAR(64) DEFAULT NULL,
        is_banned INT DEFAULT 0,
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
        card_type VARCHAR(20) DEFAULT 'VISA',
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

      CREATE TABLE IF NOT EXISTS p2p_ads (
        id SERIAL PRIMARY KEY,
        creator_id VARCHAR(64) NOT NULL,
        creator_name TEXT NOT NULL,
        trade_type VARCHAR(10) NOT NULL,
        crypto_symbol VARCHAR(10) DEFAULT 'USDT',
        price_etb NUMERIC(14, 2) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        min_limit_etb NUMERIC(14, 2) DEFAULT 250.00,
        max_limit_etb NUMERIC(14, 2) DEFAULT 100000.00,
        payment_methods TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS p2p_trades (
        id SERIAL PRIMARY KEY,
        trade_code VARCHAR(32) UNIQUE NOT NULL,
        ad_id INT,
        buyer_id VARCHAR(64) NOT NULL,
        seller_id VARCHAR(64) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        amount_etb NUMERIC(14, 2) NOT NULL,
        price_rate NUMERIC(14, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        payment_ref TEXT DEFAULT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
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

    // የምንዛሬውን ዋጋ ከዳታቤዝ ማንበብ ወይም ማስጀመር
    const fxRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'fx_rate'`);
    if (fxRes.rows.length === 0) {
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1)`, [CURRENT_FX_RATE.toString()]);
    } else {
      CURRENT_FX_RATE = parseFloat(fxRes.rows[0].value) || 194.00;
    }

    // የ P2P ገበያ ባዶ እንዳይሆን የተረጋገጡ ነጋዴዎችን ማስገባት
    const adsCount = await pool.query('SELECT COUNT(*) FROM p2p_ads');
    if (parseInt(adsCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, min_limit_etb, max_limit_etb, payment_methods)
        VALUES 
        ('SYSTEM_VERIFIED_1', 'Abebe_Crypto_ET (Official)', 'SELL', 194.50, 5000.00, 500.00, 100000.00, 'Telebirr, CBE'),
        ('SYSTEM_VERIFIED_2', 'EthioFin_Express', 'SELL', 194.80, 8500.00, 1000.00, 150000.00, 'CBE, Abyssinia'),
        ('SYSTEM_VERIFIED_3', 'Selam_P2P_Trader', 'BUY', 193.50, 2500.00, 500.00, 50000.00, 'Telebirr')
      `);
    }

    console.log(`✅ Database Initialized. Active Dollar Rate: 1 USD = ${CURRENT_FX_RATE} ETB`);
  } catch (err) {
    console.error('❌ Database query error:', err.message);
  }
}

// ═════════════════════ VERIFY SERVER INTEGRATION ═════════════════════
async function checkWithVerifyServer(method, ref, amount) {
  if (!VERIFY_SECRET) return { verified: false, manual: true };
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
    return await resp.json();
  } catch (err) {
    console.warn('Verify server check error:', err.message);
    return { verified: false, manual: true };
  }
}

// ═════════════════════ TELEGRAM HELPER FUNCTIONS ═════════════════════
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

    await sleep(35); // ~28 msgs/sec
  }

  broadcastJob.running = false;
  appendLog('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}

function appendLog(msg) {
  broadcastJob.log.push(msg);
  if (broadcastJob.log.length > 150) broadcastJob.log.shift();
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

app.get('/health', (req, res) => res.status(200).send('OK'));

// 1. የዳሽቦርድ ውቅርና የምንዛሬ ተመን ማግኛ (System Config Endpoint)
app.get('/api/config', (req, res) => {
  res.json({
    app_name: 'Binance Ethiopia Dollar Vault',
    fx_rate: CURRENT_FX_RATE,
    cbe_account: CBE_ACCOUNT,
    telebirr_phone: TELEBIRR_PHONE,
    min_withdraw_usd: 2.00,
    min_withdraw_etb: (2.00 * CURRENT_FX_RATE),
    bot_username: BINANCE_BOT_USER
  });
});

// 2. የተጠቃሚ ምዝገባና ማመሳከሪያ (User Auth & Sync)
app.post('/api/auth', async (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  if (!pool) return res.json({ user: { balance_usd: 0.00 }, isNew: false });

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

      notifyAdmin(`👤 <b>አዲስ ተጠቃሚ ተመዝግቧል:</b>\nስም: ${first_name}\nID: <code>${telegram_id}</code>\nጋባዥ: ${validRef || 'የለም'}`);
      return res.json({ user: insertResult.rows[0], isNew: true });
    }
    res.json({ user: userResult.rows[0], isNew: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. የ $0.50 ዌልካም ቦነስ (Welcome Bonus Claim)
app.post('/api/claim-welcome', async (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.50;

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const update = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, welcome_claimed = 1 
       WHERE telegram_id = $2 AND welcome_claimed = 0 RETURNING balance_usd`,
      [BONUS_USD, telegram_id.toString()]
    );

    if (update.rowCount === 0) {
      return res.status(400).json({ error: 'ይህን የ $0.50 ቦነስ አስቀድመው ወስደዋል!' });
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

// 4. ጥብቅ የተቆጣጣሪ የስራ ደረጃዎች (STRICT TASK & STAGE VERIFICATION)
app.post('/api/claim-stage', async (req, res) => {
  const { telegram_id, stage } = req.body;
  const stageNum = parseInt(stage);

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
    const user = uRes.rows[0];

    let rewardUSD = 0;
    let col = '';

    // ── STAGE 1: KYC / Identity Profile Verification ($1.00) ──
    if (stageNum === 1) {
      if (user.stage1_claimed === 1) return res.status(400).json({ error: 'Stage 1 ቀድሞ ተጠናቋል!' });
      // ማረጋገጫ፦ ተጠቃሚው መለያው ሙሉ መሆኑን ማረጋገጥ
      if (!user.first_name && !user.username) {
        return res.status(400).json({ error: 'እባክዎ በመጀመሪያ የቴሌግራም መለያዎን ያሟሉ!' });
      }
      rewardUSD = 1.00; col = 'stage1_claimed';

    // ── STAGE 2: Real Add Funds / Deposit Verification ($2.50) ──
    } else if (stageNum === 2) {
      if (user.stage1_claimed !== 1) return res.status(400).json({ error: 'በቅድሚያ Stage 1ን ያጠናቁ!' });
      if (user.stage2_claimed === 1) return res.status(400).json({ error: 'Stage 2 ቀድሞ ተጠናቋል!' });

      // እውነተኛ ማረጋገጫ፦ በዳታቤዝ ውስጥ ጸድቆ የገባ ተቀማጭ ክፍያ መኖሩን ማረጋገጥ
      const depCheck = await pool.query(
        `SELECT COUNT(*) FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`,
        [telegram_id.toString()]
      );

      if (parseInt(depCheck.rows[0].count) === 0) {
        return res.status(400).json({ 
          error: 'Stage 2ን ለመውሰድ ቢያንስ አንድ የተረጋገጠ Add Funds / Deposit በቴሌብር፣ በCBE ወይም በUSDT ማስገባት አለብዎት!' 
        });
      }
      rewardUSD = 2.50; col = 'stage2_claimed';

    // ── STAGE 3: Real Active 5 Invites Verification ($5.00) ──
    } else if (stageNum === 3) {
      if (user.stage2_claimed !== 1) return res.status(400).json({ error: 'በቅድሚያ Stage 2ን ያጠናቁ!' });
      if (user.stage3_claimed === 1) return res.status(400).json({ error: 'Stage 3 ቀድሞ ተጠናቋል!' });

      // እውነተኛ ማረጋገጫ፦ በዳታቤዝ ውስጥ የተመዘገቡ ቢያንስ 5 ጓደኞች መኖራቸውን ማረጋገጥ
      const refCheck = await pool.query(
        `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
        [telegram_id.toString()]
      );
      const inviteCount = parseInt(refCheck.rows[0].count);

      if (inviteCount < 5) {
        return res.status(400).json({ 
          error: `Stage 3ን ለመውሰድ ቢያንስ 5 ጓደኞችን መጋበዝ አለብዎት! (የጋበዙት: ${inviteCount}/5)` 
        });
      }
      rewardUSD = 5.00; col = 'stage3_claimed';

    // ── STAGE 4: VIP Champion Verification ($40.00 MEGA) ──
    } else if (stageNum === 4) {
      if (user.stage3_claimed !== 1) return res.status(400).json({ error: 'በቅድሚያ Stage 3ን ያጠናቁ!' });
      if (user.stage4_claimed === 1) return res.status(400).json({ error: 'Stage 4 ቀድሞ ተጠናቋል!' });

      // እውነተኛ ማረጋገጫ፦ ወይ 20 ጓደኛ ጋብዟል አለበለዚያ ቢያንስ $16 ዶላር ዲፖዚት አድርጓል
      const refCheck = await pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]);
      const inviteCount = parseInt(refCheck.rows[0].count);

      const depSum = await pool.query(
        `SELECT COALESCE(SUM(amount_usd), 0) as total_usd FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`,
        [telegram_id.toString()]
      );
      const totalDepositedUSD = parseFloat(depSum.rows[0].total_usd);

      if (inviteCount < 20 && totalDepositedUSD < 16.00) {
        return res.status(400).json({ 
          error: `Stage 4 VIP ለመውሰድ ወይ 20 ጓደኛ መጋበዝ (${inviteCount}/20) ወይም ቢያንስ $16 ዲፖዚት ማድረግ (አሁን ያለዎት: $${totalDepositedUSD.toFixed(2)}/16) አለብዎት!` 
        });
      }
      rewardUSD = 40.00; col = 'stage4_claimed';
    } else {
      return res.status(400).json({ error: 'Invalid stage number' });
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

// 5. ገንዘብ ማስገቢያ (Add Funds - Renamed from Deposit)
const handleAddFunds = async (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref } = req.body;
  if (!transaction_ref || !amount) return res.status(400).json({ error: 'Amount and TxID are required' });

  const amountVal = parseFloat(amount);
  const amountUSD = currency === 'ETB' ? (amountVal / CURRENT_FX_RATE) : amountVal;

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const exist = await pool.query('SELECT * FROM deposits WHERE transaction_ref = $1', [transaction_ref.trim()]);
    if (exist.rows.length > 0) return res.status(400).json({ error: 'ይህ የደረሰኝ ቁጥር አስቀድሞ አገልግሎት ላይ ውሏል!' });

    // የክፍያ ማረጋገጫ ሰርቨርን መፈተሽ (Verify Server)
    const verification = await checkWithVerifyServer(payment_method, transaction_ref, amountVal);

    let status = 'PENDING';
    if (verification && (verification.verified === true || verification.status === 'SUCCESS')) {
      status = 'APPROVED';
      await pool.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [amountUSD, telegram_id.toString()]);
      await pool.query(
        `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`,
        [telegram_id.toString(), amountUSD, `Auto-Verified Add Funds: ${transaction_ref}`]
      );
    }

    const ins = await pool.query(
      `INSERT INTO deposits (telegram_id, currency, amount, amount_usd, payment_method, transaction_ref, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [telegram_id.toString(), currency, amountVal, amountUSD, payment_method, transaction_ref.trim(), status]
    );

    notifyAdmin(
      `💰 <b>አዲስ ገንዘብ ገቢ ተደረገ (${status}):</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>${amountVal} ${currency}</b> (≈ $${amountUSD.toFixed(2)} USD)\n🏦 መንገድ: ${payment_method}\n🧾 ደረሰኝ: <code>${transaction_ref}</code>\n🤖 ፍተሻ: ${status === 'APPROVED' ? '✅ በራስ-ሰር ጸድቋል' : '⏳ በእጅ ማረጋገጫ ይጠብቃል'}`
    );

    res.json({
      success: true,
      verified: status === 'APPROVED',
      message: status === 'APPROVED' 
        ? `🎉 ክፍያዎ በራስ-ሰር ተረጋግጦ $${amountUSD.toFixed(2)} USD ወደ አሴት ቦርሳዎ ገቢ ሆኗል!` 
        : 'የክፍያ ማረጋገጫዎ ደርሶናል፤ ተጣርቶ በ 5-15 ደቂቃ ውስጥ አካውንትዎ ላይ ገቢ ይደረጋል።',
      deposit_id: ins.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/funds/add', handleAddFunds);
app.post('/api/deposit/submit', handleAddFunds); // የኋላ ተኳሃኝነት (Backward compatibility)

// 6. ቪዛ እና ማስተርካርድ ሽያጭ (Sell VISA & MASTERCARD - $1.50)
app.post('/api/cards/order', async (req, res) => {
  const { telegram_id, card_type, transaction_ref } = req.body;
  if (!transaction_ref) return res.status(400).json({ error: 'የደረሰኝ ቁጥር (TxID) ያስገቡ' });

  const chosenType = (card_type && card_type.toUpperCase().includes('MASTER')) ? 'MASTERCARD' : 'VISA';
  
  // Visa የሚጀምረው በ 4129 ሲሆን Mastercard ደግሞ በ 5326 ይጀምራል
  const prefix = chosenType === 'MASTERCARD' ? '5326' : '4129';
  const randomCard = prefix + ' ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000);
  const randomCVV = Math.floor(100 + Math.random() * 900).toString();

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    await pool.query(
      `INSERT INTO virtual_cards (telegram_id, card_type, card_number, expiry, cvv, balance_usd, status) 
       VALUES ($1, $2, $3, '12/29', $4, 0.00, 'ACTIVE')`,
      [telegram_id.toString(), chosenType, randomCard, randomCVV]
    );

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'CARD_ORDER', 1.50, $2)`,
      [telegram_id.toString(), `${chosenType} Card Activation`]
    );

    notifyAdmin(`💳 <b>አዲስ የ ${chosenType} ካርድ ትዕዛዝ:</b>\n👤 ID: <code>${telegram_id}</code>\n🧾 ደረሰኝ: <code>${transaction_ref}</code>\n💳 ካርድ: <code>${randomCard}</code>`);

    res.json({
      success: true,
      message: `🎉 የእርስዎ ${chosenType} ካርድ በተሳካ ሁኔታ ተፈጥሯል!`,
      card: { type: chosenType, number: randomCard, expiry: '12/29', cvv: randomCVV, balance_usd: 0.00 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. የውጭ ስልክ ቁጥር ማዘዣ ($1.50)
app.post('/api/services/buy-number', async (req, res) => {
  const { telegram_id, country, service } = req.body;
  const fakePhone = (country === 'UK' ? '+44 ' : '+1 ') + Math.floor(2000000000 + Math.random() * 8000000000);
  const fakeOTP = Math.floor(100000 + Math.random() * 900000).toString();

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

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

// 8. ዶላር ማውጣት (Withdrawal - Min: $2.00)
app.post('/api/withdraw', async (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);

  if (amount < 2.00) return res.status(400).json({ error: `ዝቅተኛው የማውጣት መጠን $2.00 USD (${(2 * CURRENT_FX_RATE)} ETB) ነው።` });

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const deduct = await pool.query(
      `UPDATE users SET balance_usd = balance_usd - $1 
       WHERE telegram_id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
      [amount, telegram_id.toString()]
    );

    if (deduct.rowCount === 0) return res.status(400).json({ error: 'በቂ የዶላር ቀሪ ሂሳብ የለዎትም!' });

    const amountETB = amount * CURRENT_FX_RATE;
    await pool.query(
      `INSERT INTO withdrawals (telegram_id, amount_usd, amount_etb, payment_method, account_number) 
       VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id.toString(), amount, amountETB, payment_method, account_number]
    );

    notifyAdmin(
      `🚨 <b>አዲስ የገንዘብ ማውጣት ጥያቄ:</b>\n👤 ID: <code>${telegram_id}</code>\n💵 መጠን: <b>$${amount} USD</b> (${amountETB.toLocaleString()} ETB)\n🏦 መንገድ: ${payment_method}\n💳 አካውንት: <code>${account_number}</code>`
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

// 9. Daily Spin
app.post('/api/daily-spin', async (req, res) => {
  const { telegram_id } = req.body;
  const now = new Date();

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

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

// ═════════════════════ P2P MARKETPLACE REST APIS ═════════════════════

app.get('/api/p2p/ads', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const ads = await pool.query(`SELECT * FROM p2p_ads WHERE status = 'ACTIVE' ORDER BY id DESC`);
    res.json(ads.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/ads/create', async (req, res) => {
  const { telegram_id, creator_name, trade_type, price_etb, amount_usd, payment_methods, min_limit, max_limit } = req.body;
  if (!telegram_id || !trade_type || !price_etb || !amount_usd) {
    return res.status(400).json({ error: 'Missing required ad parameters' });
  }

  const amtUSD = parseFloat(amount_usd);
  const rateETB = parseFloat(price_etb);

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    if (trade_type.toUpperCase() === 'SELL') {
      const lockRes = await pool.query(
        `UPDATE users SET balance_usd = balance_usd - $1 WHERE telegram_id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
        [amtUSD, telegram_id.toString()]
      );
      if (lockRes.rowCount === 0) {
        return res.status(400).json({ error: 'የሽያጭ ማስታወቂያ ለመልቀቅ በቂ ዶላር የለዎትም!' });
      }
    }

    const adRes = await pool.query(
      `INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, min_limit_etb, max_limit_etb, payment_methods)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        telegram_id.toString(),
        creator_name || 'Trader',
        trade_type.toUpperCase(),
        rateETB,
        amtUSD,
        parseFloat(min_limit) || 250.00,
        parseFloat(max_limit) || 100000.00,
        payment_methods || 'Telebirr, CBE'
      ]
    );

    notifyAdmin(
      `📢 <b>አዲስ የ P2P ማስታወቂያ ተለጥፏል:</b>\n👤 ነጋዴ: ${creator_name} (<code>${telegram_id}</code>)\n🔄 አይነት: <b>${trade_type.toUpperCase()} USDT</b>\n💵 ዋጋ: <b>${rateETB} ETB</b>\n💰 መጠን: <b>$${amtUSD} USD</b>`
    );

    res.json({ success: true, ad: adRes.rows[0], message: 'ማስታወቂያዎ በዳታቤዝ ተመዝግቧል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/create', async (req, res) => {
  const { buyer_id, ad_id, amount_etb, payment_method } = req.body;
  if (!buyer_id || !ad_id || !amount_etb) return res.status(400).json({ error: 'Missing parameters' });

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const adRes = await pool.query('SELECT * FROM p2p_ads WHERE id = $1 AND status = $2', [ad_id, 'ACTIVE']);
    if (adRes.rows.length === 0) return res.status(404).json({ error: 'ማስታወቂያው አልተገኘም' });

    const ad = adRes.rows[0];
    const etbAmt = parseFloat(amount_etb);
    const usdtAmt = parseFloat((etbAmt / parseFloat(ad.price_etb)).toFixed(2));
    const tradeCode = 'P2P-' + Math.floor(100000 + Math.random() * 900000);

    const tradeRes = await pool.query(
      `INSERT INTO p2p_trades (trade_code, ad_id, buyer_id, seller_id, amount_usd, amount_etb, price_rate, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING') RETURNING *`,
      [tradeCode, ad.id, buyer_id.toString(), ad.creator_id, usdtAmt, etbAmt, ad.price_etb, payment_method || 'Telebirr/CBE']
    );

    notifyAdmin(
      `🤝 <b>አዲስ P2P ግብይት (${tradeCode}):</b>\n👤 ገዢ: <code>${buyer_id}</code>\n👤 ሻጭ: <code>${ad.creator_id}</code>\n💵 የብር መጠን: <b>${etbAmt} ETB</b>\n🪙 የሚለቀቅ: <b>${usdtAmt} USDT</b>`
    );

    res.json({ success: true, trade: tradeRes.rows[0], message: 'ትዕዛዝ ተፈጥሯል፤ ክፍያውን ፈጽመው የደረሰኝ ቁጥር ያስገቡ።' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/mark-paid', async (req, res) => {
  const { trade_code, payment_ref } = req.body;
  if (!trade_code || !payment_ref) return res.status(400).json({ error: 'Code and Ref required' });

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    await pool.query(`UPDATE p2p_trades SET status = 'PAID', payment_ref = $1 WHERE trade_code = $2`, [payment_ref.trim(), trade_code]);
    notifyAdmin(`🧾 <b>P2P ክፍያ ተፈጽሟል (${trade_code}):</b>\nደረሰኝ: <code>${payment_ref}</code>`);
    res.json({ success: true, message: 'ማረጋገጫዎ ደርሷል፤ ክሪፕቶው በ Escrow ይለቀቃል።' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/release', async (req, res) => {
  const { trade_code } = req.body;
  if (!trade_code) return res.status(400).json({ error: 'Trade code required' });

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const tRes = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1 AND status IN ($2, $3)', [trade_code, 'PENDING', 'PAID']);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });

    const trade = tRes.rows[0];
    await pool.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [trade.amount_usd, trade.buyer_id]);
    await pool.query('UPDATE p2p_trades SET status = $1 WHERE trade_code = $2', ['RELEASED', trade_code]);

    notifyAdmin(`✅ <b>P2P ተጠናቋል (${trade_code}):</b>\nለገዢው <b>$${trade.amount_usd} USDT</b> ተለቋል!`);
    res.json({ success: true, message: `$${trade.amount_usd} USDT ለገዢው ተለቋል!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════ WIDE ADMIN CONTROL APIS ═════════════════════

// 1. አጠቃላይ ሲስተም ስታቲስቲክስ
app.get('/api/admin/stats', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalVaultUSD = await pool.query('SELECT COALESCE(SUM(balance_usd), 0) FROM users');
    const totalDeps = await pool.query("SELECT COUNT(*), COALESCE(SUM(amount_usd), 0) FROM deposits WHERE status = 'APPROVED'");
    const pendingWiths = await pool.query("SELECT COUNT(*), COALESCE(SUM(amount_usd), 0) FROM withdrawals WHERE status = 'PENDING'");
    const totalCards = await pool.query('SELECT COUNT(*) FROM virtual_cards');

    res.json({
      total_registered_users: parseInt(totalUsers.rows[0].count),
      total_vault_balance_usd: parseFloat(totalVaultUSD.rows[0].coalesce),
      active_dollar_rate: CURRENT_FX_RATE,
      total_approved_deposits_usd: parseFloat(totalDeps.rows[0].coalesce),
      pending_withdrawals_count: parseInt(pendingWiths.rows[0].count),
      total_cards_issued: parseInt(totalCards.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. የምንዛሬ ዋጋ መቀየሪያ (Set Dynamic Dollar Rate)
app.post('/api/admin/set-rate', auth, async (req, res) => {
  const { rate } = req.body;
  const newRate = parseFloat(rate);
  if (!newRate || newRate <= 0) return res.status(400).json({ error: 'Valid rate required' });

  CURRENT_FX_RATE = newRate;
  if (pool) {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1) 
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [newRate.toString()]
    );
  }
  notifyAdmin(`⚙️ <b>የምንዛሬ ተመን ተቀይሯል:</b>\nአዲሱ ተመን: 1 USD = <b>${newRate} ETB</b>`);
  res.json({ success: true, message: `Dollar rate updated to 1 USD = ${newRate} ETB` });
});

// 3. ያልጸደቁ ዲፖዚቶች እና ዊዝድሮዎች
app.get('/api/admin/pending', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const deps = await pool.query(`SELECT * FROM deposits WHERE status = 'PENDING' ORDER BY id DESC`);
    const withs = await pool.query(`SELECT * FROM withdrawals WHERE status = 'PENDING' ORDER BY id DESC`);
    res.json({ pending_deposits: deps.rows, pending_withdrawals: withs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. ዲፖዚት ማጽደቂያ
app.post('/api/admin/approve-deposit', auth, async (req, res) => {
  const { deposit_id } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const dRes = await pool.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING'`, [deposit_id]);
    if (dRes.rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });
    const dep = dRes.rows[0];

    await pool.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [dep.amount_usd, dep.telegram_id]);
    await pool.query(`UPDATE deposits SET status = 'APPROVED' WHERE id = $1`, [deposit_id]);
    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`, [dep.telegram_id, dep.amount_usd, `Admin Approved Ref: ${dep.transaction_ref}`]);

    res.json({ success: true, message: `Deposit of $${dep.amount_usd} USD approved successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ዊዝድሮ ማጽደቂያ
app.post('/api/admin/approve-withdrawal', auth, async (req, res) => {
  const { withdrawal_id } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    await pool.query(`UPDATE withdrawals SET status = 'COMPLETED' WHERE id = $1`, [withdrawal_id]);
    res.json({ success: true, message: 'Withdrawal marked as completed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. የተጠቃሚ ቀሪ ሂሳብ በቀጥታ ማስተካከያ (Direct Credit / Debit)
app.post('/api/admin/adjust-balance', auth, async (req, res) => {
  const { telegram_id, amount_usd, action, reason } = req.body;
  const amt = parseFloat(amount_usd);
  if (!telegram_id || !amt) return res.status(400).json({ error: 'Telegram ID and amount required' });

  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const operator = action === 'DEDUCT' ? '-' : '+';
    const up = await pool.query(
      `UPDATE users SET balance_usd = balance_usd ${operator} $1 WHERE telegram_id = $2 RETURNING balance_usd`,
      [amt, telegram_id.toString()]
    );
    if (up.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADMIN_ADJUST', $2, $3)`,
      [telegram_id.toString(), amt, reason || 'Admin manual balance adjustment']
    );

    res.json({ success: true, new_balance_usd: parseFloat(up.rows[0].balance_usd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════ BROADCAST API ROUTES (100% UNTOUCHED) ═════════════════════

app.get('/status', (req, res) => res.json({
  server:        'Unified Binance ET Dollar Vault + Swap Broadcast Marketing Server ✅',
  active_fx_rate: `1 USD = ${CURRENT_FX_RATE} ETB`,
  app_bot:       BINANCE_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  broadcast_bot: BROADCAST_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  sheet_url:     SHEET_URL ? '✅ Set' : '❌ Missing',
  broadcast:     broadcastJob.running ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}` : '⏹️ Idle'
}));

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
    try { users = await fetchUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
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

// ═════════════════════ PROCESS LISTENERS & SERVER START ═════════════════════
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(PORT, HOST, () => {
  console.log(`🚀 Unified Binance Dollar Vault Server running on http://${HOST}:${PORT}`);
  initDB();
});
