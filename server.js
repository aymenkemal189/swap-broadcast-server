try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// ═════════════════════ 1. ENVIRONMENT SECRETS ═════════════════════
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const BINANCE_BOT_TOKEN   = process.env.BINANCE_BOT_TOKEN || process.env.BOT_TOKEN || '';
const BINANCE_BOT_USER    = process.env.BINANCE_BOT_USERNAME || 'Binanceethopiapartnerbot';
const ADMIN_GROUP_ID      = process.env.ADMIN_CHAT_ID || '-1004443564071';

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '';
const ADMIN_KEY           = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL           = process.env.SHEET_URL || '';

const VERIFY_SERVER       = process.env.VERIFY_SERVER_URL || 'https://verifiy-server.app.aletcloud.com';
const VERIFY_SECRET       = process.env.VERIFY_SECRET || process.env.VERIFY_TOKEN || '';

// ═════════════════════ 2. WALLETS & ACCOUNTS CONFIG (EDIT HERE) ═════════════════════
// ሚስጥር ያልሆኑ ሁሉም የባንክና የክሪፕቶ አድራሻዎች እዚህ ይስተካከላሉ
const WALLETS_CONFIG = {
  // የባለቤቱ የኢትዮጵያ ብር አካውንቶች (ETB Pool)
  etb: {
    cbe: { number: '1000562339427', holder: 'Binance Ethiopia (CBE)' },
    telebirr: { number: '0996910607', holder: 'Binance Ethiopia (Telebirr)' }
  },
  // የ Nbiyu የዶላርና የክሪፕቶ ዋሌቶች (Dollar Pool - Tracked in nbiyu_ledger)
  nbiyu: {
    binance_pay: { value: '1017416949', label: 'Binance Pay ID', type: 'EXCHANGE_ID' },
    okx_id:      { value: '611681957742954099', label: 'OKX Pay ID', type: 'EXCHANGE_ID' },
    bybit_id:    { value: '336532209', label: 'Bybit UID', type: 'EXCHANGE_ID' },
    bitget_id:   { value: '3130523131', label: 'Bitget UID', type: 'EXCHANGE_ID' },
    kucoin_id:   { value: '225449107', label: 'KuCoin UID', type: 'EXCHANGE_ID' },
    usdt_bep20:  { value: '0x36ec2475f48a2fb7705709f20171597c36d0cf74', label: 'USDT (BEP-20 / BSC)', type: 'ONCHAIN_BSC' },
    // ማሳሰቢያ፡ የ TRON (TRC20) አድራሻ በ 'T' ነው የሚጀምረው፤ 0x ከሆነ የBEP20 ነው!
    usdt_trc20:  { value: '', label: 'USDT (TRC-20)', type: 'ONCHAIN_TRON' },
    trx_address: { value: '0x36ec2475f48a2fb7705709f20171597c36d0cf74', label: 'TRX / EVM Address', type: 'ONCHAIN_BSC' },
    usdt_ton:    { value: '', label: 'USDT (TON)', type: 'ONCHAIN_TON' },
    btc:         { value: '', label: 'Bitcoin (BTC)', type: 'ONCHAIN_BTC' },
    eth:         { value: '', label: 'Ethereum (ERC-20)', type: 'ONCHAIN_ETH' },
    sol:         { value: '', label: 'Solana (SOL)', type: 'ONCHAIN_SOL' },
    bnb:         { value: '0x36ec2475f48a2fb7705709f20171597c36d0cf74', label: 'BNB (BEP-20)', type: 'ONCHAIN_BSC' }
  }
};

// ═════════════════════ 3. BUSINESS RULES & RATE ═════════════════════
let CURRENT_FX_RATE    = 194.00; // Default 1 USD = 194.00 ETB (Editable via Admin)
const P2P_FEE_PERCENT  = 3;
const MIN_WITHDRAW_USD = 2.00;
const REQUIRE_KYC      = true;

const TG_APP_MESSAGE = `https://api.telegram.org/bot${BINANCE_BOT_TOKEN}/sendMessage`;
const TG_BC_PHOTO    = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendPhoto`;
const TG_BC_MESSAGE  = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}/sendMessage`;

// ═════════════════════ HELPERS (TIME & INTEGER MATH) ═════════════════════
function formatEAT(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true
    }).format(date) + ' EAT';
  } catch {
    return date.toISOString();
  }
}

function calcOrder(usdt, price, percent = P2P_FEE_PERCENT) {
  const grossCents = Math.round(Number(((Number(usdt) || 0) * 100).toFixed(6)));
  const pct = Number(percent) || 0;
  const feeCents = Math.round(Number(((grossCents * pct) / 100).toFixed(6)));
  const netCents = grossCents - feeCents;
  const priceCents = Math.round(Number(((Number(price) || 0) * 100).toFixed(6)));
  const etbTotal = Math.round(Number(((grossCents * priceCents) / 100).toFixed(6))) / 100;
  return { gross: grossCents / 100, fee: feeCents / 100, net: netCents / 100, etbTotal };
}

function getWalletDetails(methodKey) {
  const k = String(methodKey || '').toLowerCase();
  if (k === 'cbe') return { pool: 'ETB_OWNER', value: WALLETS_CONFIG.etb.cbe.number, label: 'CBE Bank', type: 'ETB_BANK' };
  if (k === 'telebirr') return { pool: 'ETB_OWNER', value: WALLETS_CONFIG.etb.telebirr.number, label: 'Telebirr', type: 'ETB_TELE' };

  const map = {
    binancepay:  WALLETS_CONFIG.nbiyu.binance_pay,
    binance_pay: WALLETS_CONFIG.nbiyu.binance_pay,
    okx:         WALLETS_CONFIG.nbiyu.okx_id,
    okx_id:      WALLETS_CONFIG.nbiyu.okx_id,
    bybitpay:    WALLETS_CONFIG.nbiyu.bybit_id,
    bybit_id:    WALLETS_CONFIG.nbiyu.bybit_id,
    bitget:      WALLETS_CONFIG.nbiyu.bitget_id,
    bitget_id:   WALLETS_CONFIG.nbiyu.bitget_id,
    kucoin:      WALLETS_CONFIG.nbiyu.kucoin_id,
    kucoin_id:   WALLETS_CONFIG.nbiyu.kucoin_id,
    usdt_bep20:  WALLETS_CONFIG.nbiyu.usdt_bep20,
    usdt_trc20:  WALLETS_CONFIG.nbiyu.usdt_trc20,
    trx:         WALLETS_CONFIG.nbiyu.trx_address,
    usdt_ton:    WALLETS_CONFIG.nbiyu.usdt_ton,
    btc:         WALLETS_CONFIG.nbiyu.btc,
    eth:         WALLETS_CONFIG.nbiyu.eth,
    sol:         WALLETS_CONFIG.nbiyu.sol,
    bnb:         WALLETS_CONFIG.nbiyu.bnb
  };
  const found = map[k];
  if (!found) return null;
  return { pool: 'USD_NBIYU', ...found };
}

// ═════════════════════ CORS & STATIC FILES ═════════════════════
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'Date');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
} else {
  console.warn('⚠️ DATABASE_URL is not set in Environment Variables!');
}

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
        kyc_status VARCHAR(20) DEFAULT 'None',
        kyc_full_name TEXT DEFAULT NULL,
        national_id VARCHAR(64) DEFAULT NULL,
        balance_usd NUMERIC(14, 2) DEFAULT 0.00,
        locked_usd NUMERIC(14, 2) DEFAULT 0.00,
        welcome_claimed INT DEFAULT 0,
        stage1_claimed INT DEFAULT 0,
        stage2_claimed INT DEFAULT 0,
        stage3_claimed INT DEFAULT 0,
        stage4_claimed INT DEFAULT 0,
        referred_by VARCHAR(64) DEFAULT NULL,
        fake_attempts INT DEFAULT 0,
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
        pool_target VARCHAR(20) DEFAULT 'ETB_OWNER',
        currency VARCHAR(10) NOT NULL,
        amount NUMERIC(14, 2) NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        fx_rate_used NUMERIC(10, 2) DEFAULT 194.00,
        payment_method VARCHAR(50) NOT NULL,
        destination_account TEXT DEFAULT '',
        transaction_ref VARCHAR(128) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        verified_by VARCHAR(64) DEFAULT NULL,
        eat_time TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS nbiyu_ledger (
        id SERIAL PRIMARY KEY,
        tx_code VARCHAR(32) UNIQUE NOT NULL,
        direction VARCHAR(10) NOT NULL, -- 'IN' or 'OUT'
        telegram_id VARCHAR(64) NOT NULL,
        user_name TEXT,
        channel VARCHAR(40) NOT NULL,
        destination_account TEXT NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL,
        tx_ref TEXT NOT NULL,
        verified_by VARCHAR(64) NOT NULL,
        eat_timestamp TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        pool_source VARCHAR(20) DEFAULT 'ETB_OWNER',
        amount_usd NUMERIC(14, 2) NOT NULL,
        amount_etb NUMERIC(14, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        account_number TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        eat_time TEXT,
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
        fee_usd NUMERIC(14, 2) DEFAULT 0.00,
        net_usd NUMERIC(14, 2) DEFAULT 0.00,
        amount_etb NUMERIC(14, 2) NOT NULL,
        price_rate NUMERIC(14, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        receiving_id TEXT DEFAULT NULL,
        payment_ref TEXT DEFAULT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes'),
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

    // Safe column upgrades on existing databases
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'None';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_full_name TEXT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id VARCHAR(64) DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_usd NUMERIC(14, 2) DEFAULT 0.00;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fake_attempts INT DEFAULT 0;
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS pool_target VARCHAR(20) DEFAULT 'ETB_OWNER';
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS fx_rate_used NUMERIC(10, 2) DEFAULT 194.00;
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS destination_account TEXT DEFAULT '';
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS verified_by VARCHAR(64) DEFAULT NULL;
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS eat_time TEXT;
      ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS pool_source VARCHAR(20) DEFAULT 'ETB_OWNER';
      ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS eat_time TEXT;
      ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS card_type VARCHAR(20) DEFAULT 'VISA';
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS fee_usd NUMERIC(14, 2) DEFAULT 0.00;
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS net_usd NUMERIC(14, 2) DEFAULT 0.00;
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS receiving_id TEXT DEFAULT NULL;
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes');
    `);

    // Performance Indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_deposits_tx_ref ON deposits(transaction_ref);
      CREATE INDEX IF NOT EXISTS idx_nbiyu_dir ON nbiyu_ledger(direction);
      CREATE INDEX IF NOT EXISTS idx_p2p_trades_code ON p2p_trades(trade_code);
    `);

    const fxRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'fx_rate'`);
    if (fxRes.rows.length === 0) {
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1)`, [CURRENT_FX_RATE.toString()]);
    } else {
      CURRENT_FX_RATE = parseFloat(fxRes.rows[0].value) || 194.00;
    }

    const adsCount = await pool.query('SELECT COUNT(*) FROM p2p_ads');
    if (parseInt(adsCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, min_limit_etb, max_limit_etb, payment_methods)
        VALUES 
        ('SYSTEM_VERIFIED_1', 'Abebe_Crypto_ET', 'BUY', 194.00, 5000.00, 500.00, 100000.00, 'Telebirr, CBE'),
        ('SYSTEM_VERIFIED_2', 'EthioFin_Express', 'SELL', 194.50, 8500.00, 1000.00, 150000.00, 'CBE, Abyssinia')
      `);
    }

    console.log(`✅ Neon PostgreSQL Ready | Rate: 1 USD = ${CURRENT_FX_RATE} ETB | Admin Group: ${ADMIN_GROUP_ID}`);
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

// ═════════════════════ ANTI-FAKE & ON-CHAIN VERIFICATION ENGINE ═════════════════════

async function recordFakeAttempt(telegramId, reason) {
  if (!pool) return 0;
  try {
    const r = await pool.query(
      `UPDATE users SET fake_attempts = fake_attempts + 1,
       is_banned = CASE WHEN fake_attempts + 1 >= 3 THEN 1 ELSE is_banned END
       WHERE telegram_id = $1 RETURNING fake_attempts, is_banned`,
      [telegramId.toString()]
    );
    if (r.rows.length > 0 && r.rows[0].is_banned === 1) {
      notifyAdminGroup(`🚫 <b>AUTO-BANNED SCAMMER:</b>\nUser <code>${telegramId}</code> banned after 3 fake submissions.\nReason: ${reason}`);
    }
    return r.rows[0]?.fake_attempts || 1;
  } catch { return 0; }
}

// 1. ETB Verify Server Check (Telebirr & CBE)
async function verifyETBWithServer(method, ref, amount) {
  if (!VERIFY_SECRET) return { verified: false, rejected: false, manual: true };
  try {
    const isTele = method.toLowerCase().includes('tele');
    const targetAccount = isTele ? WALLETS_CONFIG.etb.telebirr.number : WALLETS_CONFIG.etb.cbe.number;
    const resp = await fetch(`${VERIFY_SERVER}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VERIFY_SECRET}`,
        'x-secret-token': VERIFY_SECRET
      },
      body: JSON.stringify({
        method: isTele ? 'telebirr' : 'cbe',
        account: targetAccount,
        transaction_ref: ref.trim(),
        amount: parseFloat(amount)
      })
    });
    const data = await resp.json();
    if (data && (data.verified === true || data.status === 'SUCCESS')) {
      return { verified: true, rejected: false };
    }
    if (resp.status === 400 || resp.status === 404 || data?.verified === false) {
      return { verified: false, rejected: true, reason: data?.error || data?.message || 'Receipt not found on Verify Server.' };
    }
    return { verified: false, rejected: false, manual: true };
  } catch (err) {
    console.warn('Verify server unreachable, routing to manual:', err.message);
    return { verified: false, rejected: false, manual: true };
  }
}

// 2. BSC (BEP-20) On-Chain RPC Verifier
async function verifyBscTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, rejected: true, reason: 'Invalid BEP-20 TxHash format (must start with 0x and be 66 chars).' };
  }
  try {
    const rpcRes = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
    });
    const rpcData = await rpcRes.json();
    const receipt = rpcData?.result;
    if (!receipt) {
      return { verified: false, rejected: true, reason: 'BEP-20 TxHash not found on BNB Smart Chain.' };
    }
    if (receipt.status !== '0x1') {
      return { verified: false, rejected: true, reason: 'BEP-20 transaction failed on-chain.' };
    }

    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
    const USDC_BSC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
    const cleanTarget = expectedRecipient.toLowerCase().replace('0x', '').padStart(64, '0');

    let matchedUsd = 0;
    for (const log of (receipt.logs || [])) {
      const addr = (log.address || '').toLowerCase();
      if ((addr === USDT_BSC || addr === USDC_BSC) && log.topics?.[0] === TRANSFER_SIG && log.topics?.[2]?.toLowerCase() === '0x' + cleanTarget) {
        // BSC USDT/USDC has 18 decimals
        const rawWei = BigInt(log.data || '0x0');
        const cents = Number(rawWei / (10n ** 16n));
        matchedUsd += cents / 100;
      }
    }

    if (matchedUsd <= 0) {
      return { verified: false, rejected: true, reason: `No USDT/USDC transfer to Nbiyu BEP-20 wallet found in this hash.` };
    }
    if (matchedUsd < expectedAmountUsd * 0.95) {
      return { verified: false, rejected: true, reason: `Amount mismatch: on-chain is $${matchedUsd.toFixed(2)}, claimed $${expectedAmountUsd}.` };
    }

    return { verified: true, rejected: false, actualUsd: matchedUsd };
  } catch (err) {
    console.warn('BSC RPC check error:', err.message);
    return { verified: false, rejected: false, manual: true };
  }
}

// 3. TRON (TRC-20) On-Chain Verifier
async function verifyTronTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, rejected: true, reason: 'Invalid TRC-20 TxHash format (must be 64 hex chars).' };
  }
  if (!expectedRecipient.startsWith('T')) {
    return { verified: false, rejected: false, manual: true };
  }
  try {
    const r = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`);
    if (!r.ok) return { verified: false, rejected: false, manual: true };
    const data = await r.json();
    if (!data || !data.hash) {
      return { verified: false, rejected: true, reason: 'TRC-20 transaction not found on TRON network.' };
    }
    if (data.contractRet !== 'SUCCESS') {
      return { verified: false, rejected: true, reason: 'TRC-20 transaction did not succeed.' };
    }

    const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    let matchedUsd = 0;
    for (const tr of (data.trc20TransferInfo || [])) {
      if (tr.contract_address === USDT_TRC20 && tr.to_address === expectedRecipient) {
        matchedUsd += Number(BigInt(tr.amount_str || '0') / 10000n) / 100;
      }
    }

    if (matchedUsd <= 0) {
      return { verified: false, rejected: true, reason: 'No USDT transfer to Nbiyu TRC-20 address found.' };
    }
    if (matchedUsd < expectedAmountUsd * 0.95) {
      return { verified: false, rejected: true, reason: `Amount mismatch: on-chain $${matchedUsd.toFixed(2)}, claimed $${expectedAmountUsd}.` };
    }

    return { verified: true, rejected: false, actualUsd: matchedUsd };
  } catch (err) {
    console.warn('Tronscan check error:', err.message);
    return { verified: false, rejected: false, manual: true };
  }
}

// 4. BTC On-Chain Verifier
async function verifyBtcTransaction(txHash, expectedRecipient) {
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, rejected: true, reason: 'Invalid Bitcoin TxHash format.' };
  }
  try {
    const r = await fetch(`https://mempool.space/api/tx/${txHash}`);
    if (r.status === 404) return { verified: false, rejected: true, reason: 'BTC transaction not found on Mempool.' };
    if (!r.ok) return { verified: false, rejected: false, manual: true };
    const tx = await r.json();
    const hit = (tx.vout || []).some(o => o.scriptpubkey_address === expectedRecipient);
    if (!hit) return { verified: false, rejected: true, reason: 'BTC output does not match Nbiyu BTC address.' };
    return { verified: false, rejected: false, manual: true }; // Confirm exact USD manually via admin
  } catch {
    return { verified: false, rejected: false, manual: true };
  }
}

// 5. Internal Exchange ID Syntax Firewall (Binance, OKX, Bybit, Bitget, KuCoin)
function validateExchangeOrderSyntax(ref) {
  const clean = ref.trim();
  if (clean.length < 6 || clean.length > 64) {
    return { valid: false, reason: 'Order ID must be 6–64 characters long.' };
  }
  if (/^(test|fake|1234|0000|asdf|admin|null|undefined)/i.test(clean)) {
    return { valid: false, reason: 'Invalid or placeholder Order ID rejected.' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
    return { valid: false, reason: 'Order ID contains invalid characters.' };
  }
  return { valid: true };
}

// ═════════════════════ TELEGRAM HELPERS & GROUP ALERTS ═════════════════════
async function notifyAdminGroup(message) {
  if (!BINANCE_BOT_TOKEN || !ADMIN_GROUP_ID) return;
  try {
    await fetch(TG_APP_MESSAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_GROUP_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('Failed to notify admin group:', e.message);
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

// ═════════════════════ BROADCAST RUNNER (100% INTACT + HTML GUARD) ═════════════════════
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

  if (csv.trim().startsWith('<!DOCTYPE') || csv.includes('<html') || csv.includes('<script')) {
    throw new Error('SHEET_URL returned HTML instead of CSV. Publish sheet as Comma-separated values (.csv).');
  }

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
    const uid  = (cols[userIdCol] || '').trim();
    if (uid && /^\d+$/.test(uid)) {
      const username = usernameCol >= 0 ? (cols[usernameCol] || '') : '';
      users.push({ userId: uid, username: username.trim() });
    }
  }
  console.log(`✅ Loaded ${users.length} valid Telegram users from Sheet.`);
  return users;
}

// ═════════════════════ MINI APP REST APIS ═════════════════════

app.get('/health', (req, res) => res.status(200).send('OK'));

// 1. Unified Config & Wallets (Served directly from WALLETS_CONFIG)
app.get('/api/config', (req, res) => {
  res.json({
    app_name: 'Binance Ethiopia Dollar Vault',
    fx_rate: CURRENT_FX_RATE,
    p2p_fee_percent: P2P_FEE_PERCENT,
    min_withdraw_usd: MIN_WITHDRAW_USD,
    min_withdraw_etb: MIN_WITHDRAW_USD * CURRENT_FX_RATE,
    bot_username: BINANCE_BOT_USER,
    require_kyc: REQUIRE_KYC,
    accounts: {
      cbe: WALLETS_CONFIG.etb.cbe,
      telebirr: WALLETS_CONFIG.etb.telebirr,
      binance_pay: WALLETS_CONFIG.nbiyu.binance_pay.value,
      okx_id: WALLETS_CONFIG.nbiyu.okx_id.value,
      bybit_id: WALLETS_CONFIG.nbiyu.bybit_id.value,
      bitget_id: WALLETS_CONFIG.nbiyu.bitget_id.value,
      kucoin_id: WALLETS_CONFIG.nbiyu.kucoin_id.value,
      usdt_bep20: WALLETS_CONFIG.nbiyu.usdt_bep20.value,
      usdt_trc20: WALLETS_CONFIG.nbiyu.usdt_trc20.value,
      trx_address: WALLETS_CONFIG.nbiyu.trx_address.value,
      usdt_ton: WALLETS_CONFIG.nbiyu.usdt_ton.value,
      btc: WALLETS_CONFIG.nbiyu.btc.value,
      eth: WALLETS_CONFIG.nbiyu.eth.value,
      sol: WALLETS_CONFIG.nbiyu.sol.value,
      bnb: WALLETS_CONFIG.nbiyu.bnb.value
    }
  });
});

// 2. Auth & Sync
app.post('/api/auth', async (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  if (!pool) return res.json({ user: { balance_usd: 0.00, locked_usd: 0.00, kyc_status: 'None' }, isNew: false });

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (userResult.rows.length === 0) {
      const validRef = (ref_by && ref_by !== telegram_id.toString()) ? ref_by : null;
      const insertResult = await pool.query(
        `INSERT INTO users (telegram_id, first_name, last_name, username, balance_usd, kyc_status, referred_by) 
         VALUES ($1, $2, $3, $4, 0.00, 'None', $5) RETURNING *`,
        [telegram_id.toString(), first_name || 'User', last_name || '', username || '', validRef]
      );

      if (validRef) {
        await pool.query(
          `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [validRef, telegram_id.toString()]
        );
      }

      notifyAdminGroup(`👤 <b>New User Registered:</b>\nName: ${first_name}\nID: <code>${telegram_id}</code>\nRef: ${validRef || 'None'}\n🕒 ${formatEAT()}`);
      return res.json({ user: insertResult.rows[0], isNew: true });
    }
    if (userResult.rows[0].is_banned === 1) {
      return res.status(403).json({ error: 'Account banned due to suspicious activity.' });
    }
    res.json({ user: userResult.rows[0], isNew: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Submit KYC
app.post('/api/kyc/submit', async (req, res) => {
  const { telegram_id, phone_number, full_name, national_id } = req.body;
  if (!telegram_id || !phone_number || !full_name || !national_id) {
    return res.status(400).json({ error: 'All KYC fields are required' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    await pool.query(
      `UPDATE users SET phone_number = $1, kyc_full_name = $2, national_id = $3, kyc_status = 'Pending' WHERE telegram_id = $4`,
      [phone_number, full_name, national_id, telegram_id.toString()]
    );

    notifyAdminGroup(
      `🪪 <b>New KYC Submitted:</b>\n👤 User: <code>${telegram_id}</code>\n📛 Name: ${full_name}\n📱 Phone: ${phone_number}\n🆔 ID: <code>${national_id}</code>\n🕒 ${formatEAT()}`
    );

    res.json({ success: true, kyc_status: 'Pending', message: 'Pending (waiting for admin review in Telegram)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Welcome Bonus ($0.50 USD)
app.post('/api/claim-welcome', async (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.50;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const update = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, welcome_claimed = 1 
       WHERE telegram_id = $2 AND welcome_claimed = 0 AND is_banned = 0 RETURNING balance_usd`,
      [BONUS_USD, telegram_id.toString()]
    );
    if (update.rowCount === 0) return res.status(400).json({ error: 'Welcome bonus already claimed!' });

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'WELCOME_BONUS', $2, 'Welcome Gift')`,
      [telegram_id.toString(), BONUS_USD]
    );
    res.json({ success: true, balance_usd: parseFloat(update.rows[0].balance_usd), message: '🎉 $0.50 USD Welcome Bonus Credited!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Strict Task Stages (1 - 4)
app.post('/api/claim-stage', async (req, res) => {
  const { telegram_id, stage } = req.body;
  const stageNum = parseInt(stage);
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = uRes.rows[0];
    if (user.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });

    let rewardUSD = 0;
    let col = '';

    if (stageNum === 1) {
      if (user.stage1_claimed === 1) return res.status(400).json({ error: 'Stage 1 already claimed' });
      if (REQUIRE_KYC && user.kyc_status !== 'Approved') {
        return res.status(400).json({ error: 'Stage 1 requires KYC status to be Approved.' });
      }
      rewardUSD = 1.00; col = 'stage1_claimed';
    } else if (stageNum === 2) {
      if (user.stage1_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 1 first' });
      if (user.stage2_claimed === 1) return res.status(400).json({ error: 'Stage 2 already claimed' });
      const depCheck = await pool.query(`SELECT COUNT(*) FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`, [telegram_id.toString()]);
      if (parseInt(depCheck.rows[0].count) === 0) {
        return res.status(400).json({ error: 'Stage 2 requires at least 1 approved Add Funds deposit.' });
      }
      rewardUSD = 2.50; col = 'stage2_claimed';
    } else if (stageNum === 3) {
      if (user.stage2_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 2 first' });
      if (user.stage3_claimed === 1) return res.status(400).json({ error: 'Stage 3 already claimed' });
      const refCheck = await pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]);
      const inviteCount = parseInt(refCheck.rows[0].count);
      if (inviteCount < 5) {
        return res.status(400).json({ error: `Stage 3 requires 5 active invites (${inviteCount}/5).` });
      }
      rewardUSD = 5.00; col = 'stage3_claimed';
    } else if (stageNum === 4) {
      if (user.stage3_claimed !== 1) return res.status(400).json({ error: 'Complete Stage 3 first' });
      if (user.stage4_claimed === 1) return res.status(400).json({ error: 'Stage 4 already claimed' });
      const refCheck = await pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]);
      const inviteCount = parseInt(refCheck.rows[0].count);
      const depSum = await pool.query(`SELECT COALESCE(SUM(amount_usd), 0) AS total_usd FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`, [telegram_id.toString()]);
      const totalDep = parseFloat(depSum.rows[0].total_usd);
      if (inviteCount < 20 && totalDep < 16.00) {
        return res.status(400).json({ error: `Stage 4 requires 20 invites (${inviteCount}/20) OR $16+ approved funds ($${totalDep.toFixed(2)}/$16).` });
      }
      rewardUSD = 40.00; col = 'stage4_claimed';
    } else {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const upRes = await pool.query(
      `UPDATE users SET balance_usd = balance_usd + $1, ${col} = 1 WHERE telegram_id = $2 AND ${col} = 0 RETURNING balance_usd`,
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

// 6. Add Funds (ANTI-FAKE FIREWALL + ETB VERIFY SERVER + NBIYU ON-CHAIN & LEDGER)
const handleAddFunds = async (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref } = req.body;
  if (!telegram_id || !transaction_ref || !amount || !payment_method) {
    return res.status(400).json({ error: 'Missing amount, payment method, or Transaction ID.' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const cleanRef = transaction_ref.trim();
  const amountVal = parseFloat(amount);
  if (!amountVal || amountVal <= 0) return res.status(400).json({ error: 'Invalid amount.' });

  const walletMeta = getWalletDetails(payment_method);
  if (!walletMeta || !walletMeta.value) {
    return res.status(400).json({ error: `Payment method ${payment_method} is not active.` });
  }

  try {
    // 1. Check User & Ban Status
    const uRes = await pool.query('SELECT first_name, username, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User not registered.' });
    if (uRes.rows[0].is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    const userLabel = uRes.rows[0].username ? `@${uRes.rows[0].username}` : uRes.rows[0].first_name;

    // 2. Duplicate TxID Check (Before doing anything)
    const exist = await pool.query('SELECT id FROM deposits WHERE transaction_ref = $1', [cleanRef]);
    if (exist.rows.length > 0) {
      await recordFakeAttempt(telegram_id, `Duplicate TxID reuse: ${cleanRef}`);
      return res.status(400).json({ error: 'This Transaction ID has already been used!' });
    }

    let amountUSD = currency === 'ETB' ? (amountVal / CURRENT_FX_RATE) : amountVal;
    amountUSD = Math.round(amountUSD * 100) / 100;

    // 3. Anti-Fake & Auto-Verification Routing
    let verResult = { verified: false, rejected: false, manual: true };

    if (walletMeta.pool === 'ETB_OWNER') {
      if (cleanRef.length < 6) {
        await recordFakeAttempt(telegram_id, `Invalid ETB ref: ${cleanRef}`);
        return res.status(400).json({ error: 'Invalid CBE/Telebirr transaction reference format.' });
      }
      verResult = await verifyETBWithServer(payment_method, cleanRef, amountVal);
    } else if (walletMeta.type === 'ONCHAIN_BSC') {
      verResult = await verifyBscTransaction(cleanRef, walletMeta.value, amountUSD);
    } else if (walletMeta.type === 'ONCHAIN_TRON') {
      verResult = await verifyTronTransaction(cleanRef, walletMeta.value, amountUSD);
    } else if (walletMeta.type === 'ONCHAIN_BTC') {
      verResult = await verifyBtcTransaction(cleanRef, walletMeta.value);
    } else if (walletMeta.type === 'EXCHANGE_ID') {
      const syn = validateExchangeOrderSyntax(cleanRef);
      if (!syn.valid) {
        await recordFakeAttempt(telegram_id, `Invalid Exchange ID (${payment_method}): ${cleanRef}`);
        return res.status(400).json({ error: syn.reason });
      }
      verResult = { verified: false, rejected: false, manual: true };
    }

    // 4. HARD REJECT FAKE SUBMISSIONS (Never reaches Admin Group!)
    if (verResult.rejected) {
      await recordFakeAttempt(telegram_id, verResult.reason);
      return res.status(400).json({ error: `❌ Verification Failed: ${verResult.reason}` });
    }

    const eatNow = formatEAT();
    const finalUsd = verResult.actualUsd ? Math.round(verResult.actualUsd * 100) / 100 : amountUSD;
    const status = verResult.verified ? 'APPROVED' : 'PENDING';
    const verifiedBy = verResult.verified ? (walletMeta.pool === 'ETB_OWNER' ? 'VERIFY_SERVER' : 'AUTO_ONCHAIN') : null;

    // 5. Atomic DB Commit
    const client = await pool.connect();
    let depositId;
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO deposits (telegram_id, pool_target, currency, amount, amount_usd, fx_rate_used, payment_method, destination_account, transaction_ref, status, verified_by, eat_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [telegram_id.toString(), walletMeta.pool, currency, amountVal, finalUsd, CURRENT_FX_RATE, payment_method, walletMeta.value, cleanRef, status, verifiedBy, eatNow]
      );
      depositId = ins.rows[0].id;

      if (status === 'APPROVED') {
        await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [finalUsd, telegram_id.toString()]);
        await client.query(
          `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`,
          [telegram_id.toString(), finalUsd, `${verifiedBy}: ${payment_method} (${cleanRef})`]
        );

        // If Dollar went to Nbiyu's wallet, record exact inflow in nbiyu_ledger!
        if (walletMeta.pool === 'USD_NBIYU') {
          const txCode = `NBY-IN-${depositId}-${Date.now().toString().slice(-4)}`;
          await client.query(
            `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
             VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [txCode, telegram_id.toString(), userLabel, payment_method, walletMeta.value, finalUsd, cleanRef, verifiedBy, eatNow]
          );
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // 6. Send Clean Notice ONLY to Admin Group (only REAL/VALIDATED requests reach here!)
    if (status === 'APPROVED') {
      notifyAdminGroup(
        `✅ <b>VERIFIED FUNDS RECEIVED (${walletMeta.pool === 'USD_NBIYU' ? 'NBIYU USD' : 'OWNER ETB'})</b>\n` +
        `👤 User: ${userLabel} (<code>${telegram_id}</code>)\n` +
        `💵 Amount: <b>$${finalUsd.toFixed(2)} USD</b> (${amountVal} ${currency})\n` +
        `🏦 Channel: <b>${walletMeta.label}</b>\n` +
        `📍 Destination: <code>${walletMeta.value}</code>\n` +
        `🧾 Ref: <code>${cleanRef}</code>\n` +
        `🤖 Checked by: <b>${verifiedBy}</b>\n` +
        `🕒 ${eatNow}`
      );
    } else {
      notifyAdminGroup(
        `⏳ <b>PENDING VERIFICATION (${walletMeta.pool === 'USD_NBIYU' ? 'NBIYU WALLET' : 'OWNER ETB'})</b>\n` +
        `🆔 Deposit ID: <b>#${depositId}</b>\n` +
        `👤 User: ${userLabel} (<code>${telegram_id}</code>)\n` +
        `💵 Claimed: <b>$${finalUsd.toFixed(2)} USD</b> (${amountVal} ${currency})\n` +
        `🏦 Channel: <b>${walletMeta.label}</b>\n` +
        `📍 Wallet/ID: <code>${walletMeta.value}</code>\n` +
        `🧾 Order/TxID: <code>${cleanRef}</code>\n` +
        `🕒 ${eatNow}\n` +
        `👉 Approve in Admin Panel after confirming receipt!`
      );
    }

    res.json({
      success: true,
      verified: status === 'APPROVED',
      message: status === 'APPROVED'
        ? `🎉 Verified! $${finalUsd.toFixed(2)} USD credited to your Vault.`
        : 'Submitted! Waiting for verification in Admin Group (5–15 mins).',
      deposit_id: depositId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/funds/add', handleAddFunds);
app.post('/api/deposit/submit', handleAddFunds);

// 7. Store: Virtual Cards (VISA & MASTERCARD) & Phone Numbers
app.post('/api/cards/order', async (req, res) => {
  const { telegram_id, card_type, transaction_ref } = req.body;
  if (!transaction_ref) return res.status(400).json({ error: 'Transaction ID is required' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const chosenType = (card_type && card_type.toUpperCase().includes('MASTER')) ? 'MASTERCARD' : 'VISA';
  const prefix = chosenType === 'MASTERCARD' ? '5326' : '4129';
  const randomCard = `${prefix} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)}`;
  const randomCVV = Math.floor(100 + Math.random() * 900).toString();

  try {
    await pool.query(
      `INSERT INTO virtual_cards (telegram_id, card_type, card_number, expiry, cvv, balance_usd, status) VALUES ($1, $2, $3, '12/29', $4, 0.00, 'ACTIVE')`,
      [telegram_id.toString(), chosenType, randomCard, randomCVV]
    );
    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'CARD_ORDER', 1.50, $2)`,
      [telegram_id.toString(), `${chosenType} Card Activation`]
    );
    notifyAdminGroup(`💳 <b>New ${chosenType} Order:</b>\n👤 User: <code>${telegram_id}</code>\n🧾 Ref: <code>${transaction_ref}</code>\n🕒 ${formatEAT()}`);
    res.json({
      success: true,
      message: `🎉 Your ${chosenType} card is now active!`,
      card: { type: chosenType, number: randomCard, expiry: '12/29', cvv: randomCVV, balance_usd: 0.00 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services/buy-number', async (req, res) => {
  const { telegram_id, country, service } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const fakePhone = (country === 'UK' ? '+44 ' : '+1 ') + Math.floor(2000000000 + Math.random() * 8000000000);
  const fakeOTP = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await pool.query(
      `INSERT INTO phone_orders (telegram_id, country, service, phone_number, otp_code) VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id.toString(), country || 'US', service || 'TikTok', fakePhone, fakeOTP]
    );
    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'PHONE_ORDER', 1.50, $2)`,
      [telegram_id.toString(), `Virtual Number (${service})`]
    );
    res.json({ success: true, phone_number: fakePhone, otp_code: fakeOTP, service });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Withdrawals (Tracks ETB_OWNER vs USD_NBIYU Source Pool!)
app.post('/api/withdraw', async (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);
  if (!amount || amount < MIN_WITHDRAW_USD) {
    return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAW_USD.toFixed(2)} USD.` });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const isCrypto = /usdt|btc|eth|sol|ton|bnb|binance|bybit/i.test(payment_method || '');
  const poolSource = isCrypto ? 'USD_NBIYU' : 'ETB_OWNER';
  const eatNow = formatEAT();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deduct = await client.query(
      `UPDATE users SET balance_usd = balance_usd - $1 WHERE telegram_id = $2 AND balance_usd >= $1 AND is_banned = 0 RETURNING balance_usd`,
      [amount, telegram_id.toString()]
    );
    if (deduct.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient Vault balance or account banned!' });
    }

    const amountETB = Math.round(amount * CURRENT_FX_RATE * 100) / 100;
    const wIns = await client.query(
      `INSERT INTO withdrawals (telegram_id, pool_source, amount_usd, amount_etb, payment_method, account_number, eat_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [telegram_id.toString(), poolSource, amount, amountETB, payment_method, account_number, eatNow]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'WITHDRAW', $2, $3)`,
      [telegram_id.toString(), amount, `Withdrawal #${wIns.rows[0].id} via ${payment_method}`]
    );
    await client.query('COMMIT');

    notifyAdminGroup(
      `🚨 <b>WITHDRAWAL REQUEST (#${wIns.rows[0].id} · ${poolSource === 'USD_NBIYU' ? 'NBIYU PAYS USD' : 'OWNER PAYS ETB'})</b>\n` +
      `👤 User: <code>${telegram_id}</code>\n` +
      `💵 Amount: <b>$${amount.toFixed(2)} USD</b> (${amountETB.toLocaleString()} ETB)\n` +
      `🏦 Method: <b>${payment_method}</b>\n` +
      `💳 Account: <code>${account_number}</code>\n` +
      `🕒 ${eatNow}`
    );

    res.json({ success: true, balance_usd: parseFloat(deduct.rows[0].balance_usd), message: 'Withdrawal request submitted!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
        return res.status(400).json({ error: `Next spin available in ${(24 - hoursDiff).toFixed(1)} hours.` });
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

// ═════════════════════ P2P MARKETPLACE APIS ═════════════════════

app.get('/api/p2p/ads', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const ads = await pool.query(`
      SELECT a.*, u.kyc_status FROM p2p_ads a
      LEFT JOIN users u ON a.creator_id = u.telegram_id
      WHERE a.status = 'ACTIVE' ORDER BY a.id DESC
    `);
    res.json(ads.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/ads/create', async (req, res) => {
  const { telegram_id, creator_name, trade_type, price_etb, amount_usd, payment_methods, min_limit, max_limit } = req.body;
  if (!telegram_id || !trade_type || !price_etb || !amount_usd) return res.status(400).json({ error: 'Missing fields' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const uRes = await pool.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    if (REQUIRE_KYC && (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved')) {
      return res.status(403).json({ error: 'KYC verification is required before posting P2P ads.' });
    }

    const amtUSD = parseFloat(amount_usd);
    const rateETB = parseFloat(price_etb);

    if (trade_type.toUpperCase() === 'SELL') {
      const lockRes = await pool.query(
        `UPDATE users SET balance_usd = balance_usd - $1, locked_usd = locked_usd + $1 WHERE telegram_id = $2 AND balance_usd >= $1 RETURNING balance_usd`,
        [amtUSD, telegram_id.toString()]
      );
      if (lockRes.rowCount === 0) return res.status(400).json({ error: 'Insufficient USD balance for SELL ad.' });
    }

    const adRes = await pool.query(
      `INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, min_limit_etb, max_limit_etb, payment_methods)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [telegram_id.toString(), creator_name || 'Trader', trade_type.toUpperCase(), rateETB, amtUSD, parseFloat(min_limit) || 250.00, parseFloat(max_limit) || 100000.00, payment_methods || 'Telebirr, CBE']
    );

    notifyAdminGroup(`📢 <b>New P2P Ad:</b> ${creator_name} (${trade_type.toUpperCase()} $${amtUSD} @ ${rateETB} ETB)\n🕒 ${formatEAT()}`);
    res.json({ success: true, ad: adRes.rows[0], message: 'P2P Ad published!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/create', async (req, res) => {
  const { buyer_id, ad_id, amount_etb, payment_method, receiving_id } = req.body;
  if (!buyer_id || !ad_id || !amount_etb) return res.status(400).json({ error: 'Missing trade parameters' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const uRes = await pool.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [buyer_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Account banned.' });
    if (REQUIRE_KYC && (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved')) {
      return res.status(403).json({ error: 'KYC verification is required before trading.' });
    }

    const adRes = await pool.query('SELECT * FROM p2p_ads WHERE id = $1 AND status = $2', [ad_id, 'ACTIVE']);
    if (adRes.rows.length === 0) return res.status(404).json({ error: 'Ad not found or inactive' });

    const ad = adRes.rows[0];
    const etbAmt = parseFloat(amount_etb);
    const rawUsdt = etbAmt / parseFloat(ad.price_etb);
    const calc = calcOrder(rawUsdt, parseFloat(ad.price_etb), P2P_FEE_PERCENT);

    const tradeCode = 'P2P-' + Math.floor(100000 + Math.random() * 900000);
    const tradeRes = await pool.query(
      `INSERT INTO p2p_trades (trade_code, ad_id, buyer_id, seller_id, amount_usd, fee_usd, net_usd, amount_etb, price_rate, payment_method, receiving_id, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', NOW() + INTERVAL '15 minutes') RETURNING *`,
      [tradeCode, ad.id, buyer_id.toString(), ad.creator_id, calc.gross, calc.fee, calc.net, calc.etbTotal, ad.price_etb, payment_method || 'Telebirr/CBE', receiving_id || '']
    );

    notifyAdminGroup(`🤝 <b>P2P Trade (${tradeCode}):</b>\nBuyer: <code>${buyer_id}</code>\nGross: $${calc.gross} | Fee (3%): $${calc.fee} | Net: $${calc.net}\nETB: ${calc.etbTotal}\n🕒 ${formatEAT()}`);
    res.json({ success: true, trade: tradeRes.rows[0], message: 'Order created! Complete payment within 15 minutes.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/mark-paid', async (req, res) => {
  const { trade_code, payment_ref } = req.body;
  if (!trade_code || !payment_ref) return res.status(400).json({ error: 'Trade code and payment reference required' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  try {
    const tRes = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1', [trade_code]);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    const trade = tRes.rows[0];

    if (trade.expires_at && new Date(trade.expires_at) < new Date()) {
      await pool.query(`UPDATE p2p_trades SET status = 'EXPIRED' WHERE trade_code = $1`, [trade_code]);
      return res.status(400).json({ error: 'Order has expired (15-minute window passed).' });
    }

    await pool.query(`UPDATE p2p_trades SET status = 'PAID', payment_ref = $1 WHERE trade_code = $2`, [payment_ref.trim(), trade_code]);
    notifyAdminGroup(`🧾 <b>P2P Paid (${trade_code}):</b> Ref: <code>${payment_ref}</code>\n🕒 ${formatEAT()}`);
    res.json({ success: true, message: 'Payment proof submitted! Awaiting verification.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/p2p/trades/release', async (req, res) => {
  const { trade_code } = req.body;
  if (!trade_code) return res.status(400).json({ error: 'Trade code required' });
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query('SELECT * FROM p2p_trades WHERE trade_code = $1 AND status IN ($2, $3)', [trade_code, 'PENDING', 'PAID']);
    if (tRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Trade not found or already released' });
    }

    const trade = tRes.rows[0];
    const releaseAmt = parseFloat(trade.net_usd) > 0 ? parseFloat(trade.net_usd) : parseFloat(trade.amount_usd);

    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [releaseAmt, trade.buyer_id]);
    await client.query('UPDATE p2p_trades SET status = $1 WHERE trade_code = $2', ['RELEASED', trade_code]);
    await client.query('COMMIT');

    notifyAdminGroup(`✅ <b>P2P Released (${trade_code}):</b> $${releaseAmt} USDT credited to <code>${trade.buyer_id}</code>\n🕒 ${formatEAT()}`);
    res.json({ success: true, message: `$${releaseAmt} USDT released to buyer!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ═════════════════════ ADMIN ANALYTICS & CONTROL APIS ═════════════════════

// 1. Full System Analytics (Owner ETB Pool + Nbiyu Exact Dollar Pool + Breakdown)
app.get('/api/admin/analytics', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const usersStat = await pool.query(`
      SELECT COUNT(*) AS total_users, 
             COUNT(*) FILTER (WHERE kyc_status = 'Approved') AS verified_users,
             COUNT(*) FILTER (WHERE kyc_status = 'Pending') AS pending_kycs,
             COUNT(*) FILTER (WHERE is_banned = 1) AS banned_users,
             COALESCE(SUM(balance_usd), 0) AS total_user_vault_usd
      FROM users
    `);

    const etbIn = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_etb FROM deposits WHERE pool_target = 'ETB_OWNER' AND status = 'APPROVED'`);
    const etbOut = await pool.query(`SELECT COALESCE(SUM(amount_etb), 0) AS total_etb FROM withdrawals WHERE pool_source = 'ETB_OWNER' AND status = 'COMPLETED'`);

    const nbiyuIn = await pool.query(`SELECT COALESCE(SUM(amount_usd), 0) AS total_in FROM nbiyu_ledger WHERE direction = 'IN'`);
    const nbiyuOut = await pool.query(`SELECT COALESCE(SUM(amount_usd), 0) AS total_out FROM nbiyu_ledger WHERE direction = 'OUT'`);
    const nbiyuByChannel = await pool.query(`
      SELECT channel,
             COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount_usd ELSE 0 END), 0) AS in_usd,
             COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount_usd ELSE 0 END), 0) AS out_usd,
             COUNT(*) AS tx_count
      FROM nbiyu_ledger
      GROUP BY channel
      ORDER BY in_usd DESC
    `);

    const pendingCounts = await pool.query(`
      SELECT (SELECT COUNT(*) FROM deposits WHERE status = 'PENDING') AS pending_deposits,
             (SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING') AS pending_withdrawals,
             (SELECT COUNT(*) FROM p2p_trades WHERE status IN ('PENDING', 'PAID')) AS active_p2p_trades
    `);

    const nIn = parseFloat(nbiyuIn.rows[0].total_in);
    const nOut = parseFloat(nbiyuOut.rows[0].total_out);
    const eIn = parseFloat(etbIn.rows[0].total_etb);
    const eOut = parseFloat(etbOut.rows[0].total_etb);

    res.json({
      fx_rate: CURRENT_FX_RATE,
      users: usersStat.rows[0],
      etb_owner_pool: {
        total_in_etb: eIn,
        total_out_etb: eOut,
        net_held_etb: eIn - eOut
      },
      nbiyu_dollar_pool: {
        total_in_usd: nIn,
        total_out_usd: nOut,
        net_held_usd: Math.round((nIn - nOut) * 100) / 100,
        by_channel: nbiyuByChannel.rows
      },
      pending: pendingCounts.rows[0],
      wallets_config: WALLETS_CONFIG
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Nbiyu Exact Dollar Ledger
app.get('/api/admin/nbiyu-ledger', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const rows = await pool.query(`SELECT * FROM nbiyu_ledger ORDER BY id DESC LIMIT 100`);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Pending Queues (Deposits, Withdrawals, KYCs, P2P Trades)
app.get('/api/admin/pending', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const deps = await pool.query(`SELECT * FROM deposits WHERE status = 'PENDING' ORDER BY id DESC`);
    const withs = await pool.query(`SELECT * FROM withdrawals WHERE status = 'PENDING' ORDER BY id DESC`);
    const kycs = await pool.query(`SELECT telegram_id, first_name, username, phone_number, kyc_full_name, national_id, created_at FROM users WHERE kyc_status = 'Pending' ORDER BY id DESC`);
    const trades = await pool.query(`SELECT * FROM p2p_trades WHERE status IN ('PENDING', 'PAID') ORDER BY id DESC`);
    res.json({ pending_deposits: deps.rows, pending_withdrawals: withs.rows, pending_kycs: kycs.rows, active_p2p_trades: trades.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Users Directory
app.get('/api/admin/users', auth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const q = req.query.q ? `%${req.query.q.trim()}%` : null;
  try {
    const rows = q
      ? await pool.query(`SELECT * FROM users WHERE telegram_id ILIKE $1 OR first_name ILIKE $1 OR username ILIKE $1 ORDER BY id DESC LIMIT 50`, [q])
      : await pool.query(`SELECT * FROM users ORDER BY id DESC LIMIT 50`);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Approve Deposit (Atomic + Writes to Nbiyu Ledger if USD_NBIYU!)
app.post('/api/admin/approve-deposit', auth, async (req, res) => {
  const { deposit_id } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dRes = await client.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING'`, [deposit_id]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending deposit not found' });
    }
    const dep = dRes.rows[0];
    const eatNow = formatEAT();

    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [dep.amount_usd, dep.telegram_id]);
    await client.query(`UPDATE deposits SET status = 'APPROVED', verified_by = 'ADMIN_MANUAL', eat_time = $1 WHERE id = $2`, [eatNow, deposit_id]);
    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`,
      [dep.telegram_id, dep.amount_usd, `Approved Ref: ${dep.transaction_ref}`]
    );

    if (dep.pool_target === 'USD_NBIYU') {
      const uInfo = await client.query(`SELECT first_name, username FROM users WHERE telegram_id = $1`, [dep.telegram_id]);
      const uName = uInfo.rows[0]?.username ? `@${uInfo.rows[0].username}` : (uInfo.rows[0]?.first_name || 'User');
      const txCode = `NBY-IN-${deposit_id}-${Date.now().toString().slice(-4)}`;
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
         VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, 'ADMIN_MANUAL', $8)`,
        [txCode, dep.telegram_id, uName, dep.payment_method, dep.destination_account || '', dep.amount_usd, dep.transaction_ref, eatNow]
      );
    }

    await client.query('COMMIT');
    notifyAdminGroup(`✅ <b>ADMIN APPROVED DEPOSIT #${deposit_id}:</b>\n💵 $${dep.amount_usd} USD (${dep.pool_target})\n👤 User: <code>${dep.telegram_id}</code>\n🕒 ${eatNow}`);
    res.json({ success: true, message: `Deposit #${deposit_id} ($${dep.amount_usd} USD) approved!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 6. Reject Deposit (Counts as Fake Attempt!)
app.post('/api/admin/reject-deposit', auth, async (req, res) => {
  const { deposit_id, reason } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    const dRes = await pool.query(`UPDATE deposits SET status = 'REJECTED' WHERE id = $1 AND status = 'PENDING' RETURNING telegram_id`, [deposit_id]);
    if (dRes.rowCount === 0) return res.status(404).json({ error: 'Pending deposit not found' });
    await recordFakeAttempt(dRes.rows[0].telegram_id, reason || 'Rejected by Admin');
    res.json({ success: true, message: `Deposit #${deposit_id} rejected.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Approve Withdrawal (Logs OUT in nbiyu_ledger if USD_NBIYU!)
app.post('/api/admin/approve-withdrawal', auth, async (req, res) => {
  const { withdrawal_id, payout_ref } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING'`, [withdrawal_id]);
    if (wRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending withdrawal not found' });
    }
    const w = wRes.rows[0];
    const eatNow = formatEAT();

    await client.query(`UPDATE withdrawals SET status = 'COMPLETED', eat_time = $1 WHERE id = $2`, [eatNow, withdrawal_id]);

    if (w.pool_source === 'USD_NBIYU') {
      const txCode = `NBY-OUT-${withdrawal_id}-${Date.now().toString().slice(-4)}`;
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp)
         VALUES ($1, 'OUT', $2, 'Payout', $3, $4, $5, $6, 'ADMIN_PAYOUT', $7)`,
        [txCode, w.telegram_id, w.payment_method, w.account_number, w.amount_usd, payout_ref || `WD-${withdrawal_id}`, eatNow]
      );
    }

    await client.query('COMMIT');
    notifyAdminGroup(`💸 <b>WITHDRAWAL PAID #${withdrawal_id}:</b> $${w.amount_usd} USD via ${w.payment_method}\n🕒 ${eatNow}`);
    res.json({ success: true, message: `Withdrawal #${withdrawal_id} marked COMPLETED.` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 8. Reject Withdrawal (Refunds User)
app.post('/api/admin/reject-withdrawal', auth, async (req, res) => {
  const { withdrawal_id } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING'`, [withdrawal_id]);
    if (wRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending withdrawal not found' });
    }
    const w = wRes.rows[0];
    await client.query(`UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [w.amount_usd, w.telegram_id]);
    await client.query(`UPDATE withdrawals SET status = 'REJECTED' WHERE id = $1`, [withdrawal_id]);
    await client.query('COMMIT');
    res.json({ success: true, message: `Withdrawal #${withdrawal_id} rejected and $${w.amount_usd} refunded.` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 9. KYC Review
app.post('/api/admin/kyc/review', auth, async (req, res) => {
  const { telegram_id, decision } = req.body;
  if (!telegram_id || !['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Valid telegram_id and decision required' });
  }
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    await pool.query(`UPDATE users SET kyc_status = $1 WHERE telegram_id = $2`, [decision, telegram_id.toString()]);
    notifyAdminGroup(`🪪 <b>KYC ${decision.toUpperCase()}:</b> User <code>${telegram_id}</code>`);
    res.json({ success: true, message: `KYC for ${telegram_id} marked ${decision}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Set Dynamic Dollar Rate
app.post('/api/admin/set-rate', auth, async (req, res) => {
  const { rate } = req.body;
  const newRate = parseFloat(rate);
  if (!newRate || newRate <= 0) return res.status(400).json({ error: 'Valid rate required' });

  CURRENT_FX_RATE = newRate;
  if (pool) {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [newRate.toString()]
    );
  }
  notifyAdminGroup(`⚙️ <b>Dollar Rate Updated:</b> 1 USD = <b>${newRate} ETB</b>`);
  res.json({ success: true, message: `Rate updated to 1 USD = ${newRate} ETB` });
});

// 11. Adjust User Balance / Ban / Unban
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

app.post('/api/admin/ban-user', auth, async (req, res) => {
  const { telegram_id, banned } = req.body;
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  try {
    await pool.query(`UPDATE users SET is_banned = $1, fake_attempts = 0 WHERE telegram_id = $2`, [banned ? 1 : 0, telegram_id.toString()]);
    res.json({ success: true, message: `User ${telegram_id} ${banned ? 'banned' : 'unbanned'}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════ SWAP BROADCAST API ROUTES (100% INTACT) ═════════════════════

app.get('/status', (req, res) => res.json({
  server:         'Unified Binance ET Vault + Nbiyu Ledger + Swap Broadcast Server ✅',
  active_fx_rate: `1 USD = ${CURRENT_FX_RATE} ETB`,
  app_bot:        BINANCE_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  broadcast_bot:  BROADCAST_BOT_TOKEN ? '✅ Active' : '❌ Missing',
  sheet_url:      SHEET_URL ? '✅ Set' : '❌ Missing',
  broadcast:      broadcastJob.running ? `🔄 Running — ${broadcastJob.sent}/${broadcastJob.total}` : '⏹️ Idle'
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

// ═════════════════════ CRASH PREVENTION & STARTUP ═════════════════════
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(PORT, HOST, () => {
  console.log(`🚀 Unified Binance ET + Nbiyu Ledger + Broadcast Server running on http://${HOST}:${PORT}`);
  initDB();
});
