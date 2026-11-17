








try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// ═════════════════════ 1. ENV CONFIG ═════════════════════
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const BINANCE_BOT_TOKEN   = process.env.BINANCE_BOT_TOKEN || '';
const BINANCE_BOT_USER    = process.env.BINANCE_BOT_USERNAME || 'Binanceethopiapartnerbot';
const OFFICIAL_CHANNEL    = process.env.OFFICIAL_CHANNEL || '@Binance_ethiopa';
const ADMIN_GROUP_ID      = process.env.ADMIN_CHAT_ID || '-1004443564071';
const PUBLIC_SERVER_URL   = (process.env.PUBLIC_SERVER_URL || 'https://swap-broadcast-server.app.aletcloud.com').replace(/\/+$/, '');

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '';
const ADMIN_KEY           = process.env.ADMIN_KEY || 'SWAP_ADMIN_2026';
const SHEET_URL           = process.env.SHEET_URL || '';

const VERIFY_SERVER_BASE  = (process.env.VERIFY_SERVER_URL || 'https://verifiy-server.app.aletcloud.com').replace(/\/+$/, '');
const VERIFY_SECRET       = process.env.VERIFY_SECRET || process.env.VERIFY_TOKEN || '';

const TG_APP_API = `https://api.telegram.org/bot${BINANCE_BOT_TOKEN}`;
const TG_BC_API  = `https://api.telegram.org/bot${BROADCAST_BOT_TOKEN}`;

let configCache = { data: null, expiresAt: 0 };
let p2pAdsCache = { data: null, expiresAt: 0 };
function invalidateConfigCache() { configCache.expiresAt = 0; }
function invalidateP2PCache() { p2pAdsCache.expiresAt = 0; }

// ═════════════════════ 2. HELPERS ═════════════════════
function formatEAT(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(date) + ' EAT';
  } catch { return date.toISOString(); }
}

function calcOrder(usdt, price, percent = 1) {
  const grossCents = Math.round(Number(((Number(usdt) || 0) * 100).toFixed(6)));
  const pct = Number(percent) || 0;
  const feeCents = Math.round(Number(((grossCents * pct) / 100).toFixed(6)));
  const netCents = grossCents - feeCents;
  const priceCents = Math.round(Number(((Number(price) || 0) * 100).toFixed(6)));
  const etbTotal = Math.round(Number(((grossCents * priceCents) / 100).toFixed(6))) / 100;
  return { gross: grossCents / 100, fee: feeCents / 100, net: netCents / 100, etbTotal };
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findActiveAccount(accounts, methodKey) {
  const m = String(methodKey || '').trim().toLowerCase();
  return accounts.find(a => a.key_slug.toLowerCase() === m || a.label.toLowerCase() === m);
}

// ═════════════════════ 3. CORS & STATIC ═════════════════════
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
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═════════════════════ 4. NEON POSTGRESQL ═════════════════════
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 6000
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
}

async function getSystemConfig() {
  const now = Date.now();
  if (configCache.data && now < configCache.expiresAt) return configCache.data;
  const fallback = { fx_rate: 194.00, stage4_min_invites: 10, stage4_min_deposit_usd: 16.00, p2p_fee_percent: 1, min_withdraw_usd: 3.00, accounts: [] };
  if (!pool) return fallback;
  try {
    const [sRes, aRes] = await Promise.all([
      pool.query('SELECT key, value FROM system_settings'),
      pool.query('SELECT * FROM payment_accounts WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC')
    ]);
    const map = {};
    sRes.rows.forEach(r => { map[r.key] = r.value; });
    const data = {
      fx_rate: parseFloat(map.fx_rate) || 194.00,
      stage4_min_invites: parseInt(map.stage4_min_invites) || 10,
      stage4_min_deposit_usd: parseFloat(map.stage4_min_deposit_usd) || 16.00,
      p2p_fee_percent: parseFloat(map.p2p_fee_percent) || 1,
      min_withdraw_usd: parseFloat(map.min_withdraw_usd) || 3.00,
      accounts: aRes.rows
    };
    configCache = { data, expiresAt: now + 60000 };
    return data;
  } catch { return fallback; }
}

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS voucher_usd NUMERIC(14, 2) DEFAULT 0.00;
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS receive_mode VARCHAR(20) DEFAULT 'VAULT';
      ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS buyer_rating INT DEFAULT NULL;
      CREATE TABLE IF NOT EXISTS card_topups (
        id SERIAL PRIMARY KEY, telegram_id VARCHAR(64) NOT NULL, card_id INT NOT NULL,
        amount_usd NUMERIC(14, 2) NOT NULL, fee_usd NUMERIC(14, 2) DEFAULT 0.00,
        status VARCHAR(20) DEFAULT 'PENDING', eat_time TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await getSystemConfig();
    console.log('✅ Neon PostgreSQL connected & ready.');
  } catch (err) { console.error('❌ DB init warning:', err.message); }
}

// ═════════════════════ 5. TELEGRAM HELPERS ═════════════════════
async function tgCall(method, body) {
  if (!BINANCE_BOT_TOKEN) return null;
  try {
    const r = await fetch(`${TG_APP_API}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return null; }
}

async function notifyAdminGroup(text, replyMarkup = null) {
  if (!BINANCE_BOT_TOKEN || !ADMIN_GROUP_ID) return null;
  const payload = { chat_id: ADMIN_GROUP_ID, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall('sendMessage', payload);
}

async function sendBase64PhotoToGroup(dataUrl, caption, replyMarkup = null) {
  if (!BINANCE_BOT_TOKEN || !ADMIN_GROUP_ID || !dataUrl || !dataUrl.startsWith('data:image/')) {
    return notifyAdminGroup(caption, replyMarkup);
  }
  try {
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!m) return notifyAdminGroup(caption, replyMarkup);
    const form = new FormData();
    form.append('chat_id', ADMIN_GROUP_ID);
    form.append('photo', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'upload.jpg');
    form.append('caption', caption.slice(0, 1020));
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    const r = await fetch(`${TG_APP_API}/sendPhoto`, { method: 'POST', body: form });
    const d = await r.json();
    if (!d.ok) return notifyAdminGroup(caption, replyMarkup);
    return d;
  } catch { return notifyAdminGroup(caption, replyMarkup); }
}

async function notifyUserDM(telegramId, msgEn, msgAm) {
  if (!BINANCE_BOT_TOKEN || !telegramId || String(telegramId).startsWith('guest_')) return;
  let lang = 'en';
  if (pool) {
    try {
      const r = await pool.query('SELECT preferred_lang FROM users WHERE telegram_id = $1', [telegramId.toString()]);
      if (r.rows[0]?.preferred_lang) lang = r.rows[0].preferred_lang;
    } catch (_) {}
  }
  const text = lang === 'am' ? `${msgAm}\n\n${msgEn}` : `${msgEn}\n\n${msgAm}`;
  await tgCall('sendMessage', { chat_id: telegramId.toString(), text, parse_mode: 'HTML' });
}

async function checkChannelMembership(telegramId) {
  if (!BINANCE_BOT_TOKEN || String(telegramId).startsWith('guest_')) return { ok: true, joined: true };
  try {
    const d = await tgCall('getChatMember', { chat_id: OFFICIAL_CHANNEL, user_id: Number(telegramId) || telegramId });
    if (!d || !d.ok) return { ok: false, joined: true };
    return { ok: true, joined: ['creator', 'administrator', 'member', 'restricted'].includes(d.result?.status) };
  } catch { return { ok: false, joined: true }; }
}

// ═════════════════════ 6. VERIFY SERVER & ANTI-FAKE ═════════════════════
async function recordFakeAttempt(telegramId, reason) {
  if (!pool) return;
  try {
    const r = await pool.query(
      `UPDATE users SET fake_attempts = fake_attempts + 1, is_banned = CASE WHEN fake_attempts + 1 >= 3 THEN 1 ELSE is_banned END WHERE telegram_id = $1 RETURNING is_banned`,
      [telegramId.toString()]
    );
    if (r.rows[0]?.is_banned === 1) notifyAdminGroup(`🚫 <b>AUTO-BANNED:</b> <code>${escHtml(telegramId)}</code> (${escHtml(reason)})`);
  } catch (_) {}
}

async function verifyETBWithServer(ref, expectedAmount, smsText = '') {
  if (!VERIFY_SECRET) return { outcome: 'MANUAL' };
  try {
    const params = new URLSearchParams({ token: VERIFY_SECRET });
    if (smsText && smsText.trim().length > 15) params.append('sms', smsText.trim());
    else { params.append('ref', ref.trim()); params.append('amount', String(parseFloat(expectedAmount))); }
    const resp = await fetch(`${VERIFY_SERVER_BASE}/api/verify?${params.toString()}`);
    const data = await resp.json();
    const st = data?.status;
    if (st === 'Verified') return { outcome: 'VERIFIED', amount: parseFloat(data.amount || expectedAmount), ref: data.ref || data.transaction_id || ref };
    if (st === 'Pending' || st === 'Resolving') return { outcome: 'RETRY', status: st, message: `Bank confirmation is ${st}. Retry in 1 minute.` };
    if (['AlreadyUsed', 'InvalidAmount', 'Invalid_Transaction_Type'].includes(st)) return { outcome: 'REJECT', reason: `Payment rejected (${st}).` };
    if (data?.error) return { outcome: 'REJECT', reason: data.error };
    return { outcome: 'MANUAL' };
  } catch { return { outcome: 'MANUAL' }; }
}

async function verifyBscTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return { outcome: 'REJECT', reason: 'Invalid BEP-20 TxHash format.' };
  try {
    const rpcRes = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
    });
    const receipt = (await rpcRes.json())?.result;
    if (!receipt) return { outcome: 'REJECT', reason: 'TxHash not found on BSC.' };
    if (receipt.status !== '0x1') return { outcome: 'REJECT', reason: 'Transaction failed on-chain.' };
    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
    const USDC_BSC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
    const cleanTarget = expectedRecipient.toLowerCase().replace('0x', '').padStart(64, '0');
    let matchedUsd = 0;
    for (const log of (receipt.logs || [])) {
      const addr = (log.address || '').toLowerCase();
      if ((addr === USDT_BSC || addr === USDC_BSC) && log.topics?.[0] === TRANSFER_SIG && log.topics?.[2]?.toLowerCase() === '0x' + cleanTarget) {
        matchedUsd += Number(BigInt(log.data || '0x0') / (10n ** 16n)) / 100;
      }
    }
    if (matchedUsd <= 0) return { outcome: 'REJECT', reason: 'No USDT transfer to our BEP-20 wallet found.' };
    if (matchedUsd < expectedAmountUsd * 0.95) return { outcome: 'REJECT', reason: `On-chain $${matchedUsd.toFixed(2)} < claimed $${expectedAmountUsd}.` };
    return { outcome: 'VERIFIED', amountUsd: matchedUsd };
  } catch { return { outcome: 'MANUAL' }; }
}

async function verifyTronTransaction(txHash, expectedRecipient, expectedAmountUsd) {
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) return { outcome: 'REJECT', reason: 'Invalid TRC-20 TxHash format.' };
  if (!expectedRecipient.startsWith('T')) return { outcome: 'MANUAL' };
  try {
    const r = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`);
    if (!r.ok) return { outcome: 'MANUAL' };
    const data = await r.json();
    if (!data?.hash) return { outcome: 'REJECT', reason: 'TxHash not found on TRON.' };
    if (data.contractRet !== 'SUCCESS') return { outcome: 'REJECT', reason: 'TRON transaction failed.' };
    let matchedUsd = 0;
    for (const tr of (data.trc20TransferInfo || [])) {
      if (tr.contract_address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' && tr.to_address === expectedRecipient) {
        matchedUsd += Number(BigInt(tr.amount_str || '0') / 10000n) / 100;
      }
    }
    if (matchedUsd <= 0) return { outcome: 'REJECT', reason: 'No USDT transfer to our TRC-20 wallet.' };
    if (matchedUsd < expectedAmountUsd * 0.95) return { outcome: 'REJECT', reason: `On-chain $${matchedUsd.toFixed(2)} < claimed.` };
    return { outcome: 'VERIFIED', amountUsd: matchedUsd };
  } catch { return { outcome: 'MANUAL' }; }
}

function validateExchangeOrderSyntax(ref) {
  const clean = ref.trim();
  if (clean.length < 6 || clean.length > 80) return { valid: false, reason: 'Order ID must be 6–80 characters.' };
  if (/^(test|fake|1234|0000|asdf|admin|null|undefined)/i.test(clean)) return { valid: false, reason: 'Invalid Order ID rejected.' };
  return { valid: true };
}

async function isDuplicateRefAnywhere(cleanRef) {
  const [d, s, p] = await Promise.all([
    pool.query('SELECT id FROM deposits WHERE transaction_ref = $1', [cleanRef]),
    pool.query('SELECT id FROM store_orders WHERE transaction_ref = $1', [cleanRef]),
    pool.query('SELECT id FROM p2p_trades WHERE payment_ref = $1', [cleanRef])
  ]);
  return d.rows.length > 0 || s.rows.length > 0 || p.rows.length > 0;
}

// ═════════════════════ 7. SHARED APPROVAL & REJECTION HANDLERS ═════════════════════
async function approveDepositById(depositId, actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dRes = await client.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [depositId]);
    if (dRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Deposit not found' }; }
    const dep = dRes.rows[0], eatNow = formatEAT();
    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [dep.amount_usd, dep.telegram_id]);
    await client.query(`UPDATE deposits SET status = 'APPROVED', verified_by = $1, eat_time = $2 WHERE id = $3`, [actor, eatNow, depositId]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'ADD_FUNDS', $2, $3)`, [dep.telegram_id, dep.amount_usd, `Approved Ref: ${dep.transaction_ref}`]);
    if (dep.pool_target === 'USD_NBIYU') {
      const uInfo = await client.query(`SELECT first_name, username FROM users WHERE telegram_id = $1`, [dep.telegram_id]);
      const uName = uInfo.rows[0]?.username ? `@${uInfo.rows[0].username}` : (uInfo.rows[0]?.first_name || 'User');
      await client.query(
        `INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp) VALUES ($1,'IN',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`NBY-IN-${depositId}-${Date.now().toString().slice(-4)}`, dep.telegram_id, uName, dep.payment_method, dep.destination_account || '', dep.amount_usd, dep.transaction_ref, actor, eatNow]
      );
    }
    await client.query('COMMIT');
    notifyUserDM(dep.telegram_id, `✅ <b>Add Funds Approved!</b> +$${Number(dep.amount_usd).toFixed(2)} USD added.`, `✅ <b>ገንዘብ ማስገባትዎ ጸድቋል!</b> +$${Number(dep.amount_usd).toFixed(2)} USD ገቢ ሆኗል።`);
    return { ok: true, deposit: dep };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

async function rejectDepositById(depositId, reason = 'Payment not received', actor = 'ADMIN') {
  const r = await pool.query(`UPDATE deposits SET status = 'REJECTED', reject_reason = $1, verified_by = $2 WHERE id = $3 AND status = 'PENDING' RETURNING *`, [reason, actor, depositId]);
  if (r.rowCount === 0) return { ok: false, error: 'Pending deposit not found' };
  await recordFakeAttempt(r.rows[0].telegram_id, reason);
  notifyUserDM(r.rows[0].telegram_id, `❌ <b>Add Funds Rejected (#${depositId})</b>\nReason: ${escHtml(reason)}`, `❌ <b>ክፍያዎ ውድቅ ተደርጓል (#${depositId})</b>\nምክንያት: ${escHtml(reason)}`);
  return { ok: true };
}

async function approveStoreOrderById(orderId, actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query(`SELECT * FROM store_orders WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [orderId]);
    if (oRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Order not found' }; }
    const ord = oRes.rows[0], eatNow = formatEAT();
    let deliveryInfo = 'Activated';
    if (ord.product_id === 'VISA' || ord.product_id === 'MASTERCARD') {
      const prefix = ord.product_id === 'MASTERCARD' ? '5326' : '4129';
      const cardNum = `${prefix} ${Math.floor(1000+Math.random()*9000)} ${Math.floor(1000+Math.random()*9000)} ${Math.floor(1000+Math.random()*9000)}`;
      const cvv = Math.floor(100+Math.random()*900).toString();
      await client.query(`INSERT INTO virtual_cards (order_id, telegram_id, card_type, card_number, expiry, cvv, balance_usd, status) VALUES ($1,$2,$3,$4,'12/29',$5,0.00,'ACTIVE')`, [ord.id, ord.telegram_id, ord.product_id, cardNum, cvv]);
      deliveryInfo = `${ord.product_id}: ${cardNum} | Exp: 12/29 | CVV: ${cvv}`;
    } else if (ord.product_id === 'PHONE_US') {
      const num = `+1 ${Math.floor(2000000000+Math.random()*8000000000)}`, otp = Math.floor(100000+Math.random()*900000).toString();
      await client.query(`INSERT INTO phone_orders (order_id, telegram_id, country, service, phone_number, otp_code) VALUES ($1,$2,'US',$3,$4,$5)`, [ord.id, ord.telegram_id, ord.service_details || 'General', num, otp]);
      deliveryInfo = `Number: ${num} | OTP: ${otp}`;
    }
    await client.query(`UPDATE store_orders SET status = 'DELIVERED', delivery_data = $1, verified_by = $2, eat_time = $3 WHERE id = $4`, [deliveryInfo, actor, eatNow, orderId]);
    if (ord.pool_target === 'USD_NBIYU') {
      await client.query(`INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp) VALUES ($1,'IN',$2,'Store Buyer',$3,'Store Checkout',$4,$5,$6,$7)`, [`NBY-ST-${ord.id}`, ord.telegram_id, ord.payment_method, ord.price_usd, ord.transaction_ref, actor, eatNow]);
    }
    await client.query('COMMIT');
    notifyUserDM(ord.telegram_id, `🎉 <b>Store Order Approved (${ord.order_code})</b>\n<code>${escHtml(deliveryInfo)}</code>`, `🎉 <b>የሱቅ ትዕዛዝዎ ጸድቋል (${ord.order_code})</b>\n<code>${escHtml(deliveryInfo)}</code>`);
    return { ok: true, deliveryInfo };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

async function rejectStoreOrderById(orderId, reason = 'Payment not verified', actor = 'ADMIN') {
  const r = await pool.query(`UPDATE store_orders SET status = 'REJECTED', reject_reason = $1, verified_by = $2 WHERE id = $3 AND status = 'PENDING' RETURNING *`, [reason, actor, orderId]);
  if (r.rowCount === 0) return { ok: false, error: 'Order not found' };
  await recordFakeAttempt(r.rows[0].telegram_id, reason);
  notifyUserDM(r.rows[0].telegram_id, `❌ <b>Store Order Rejected (${r.rows[0].order_code})</b>\nReason: ${escHtml(reason)}`, `❌ <b>የሱቅ ትዕዛዝዎ ውድቅ ተደርጓል</b>\nምክንያት: ${escHtml(reason)}`);
  return { ok: true };
}

async function approveWithdrawalById(withdrawalId, payoutRef = '', actor = 'ADMIN') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [withdrawalId]);
    if (wRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Withdrawal not found' }; }
    const w = wRes.rows[0], eatNow = formatEAT();
    await client.query(`UPDATE withdrawals SET status = 'COMPLETED', payout_ref = $1, eat_time = $2 WHERE id = $3`, [payoutRef || `WD-${withdrawalId}`, eatNow, withdrawalId]);
    if (w.pool_source === 'USD_NBIYU') {
      await client.query(`INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp) VALUES ($1,'OUT',$2,'Withdrawal',$3,$4,$5,$6,$7,$8)`, [`NBY-OUT-${withdrawalId}-${Date.now().toString().slice(-4)}`, w.telegram_id, w.payment_method, w.account_number, w.amount_usd, payoutRef || `WD-${withdrawalId}`, actor, eatNow]);
    }
    await client.query('COMMIT');
    notifyUserDM(w.telegram_id, `💸 <b>Withdrawal Paid (#${withdrawalId})!</b> $${Number(w.amount_usd).toFixed(2)} sent to ${escHtml(w.account_number)}.`, `💸 <b>ያወጡት ገንዘብ ተልኳል (#${withdrawalId})!</b>`);
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

async function rejectWithdrawalById(withdrawalId, reason = 'Invalid account') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [withdrawalId]);
    if (wRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Withdrawal not found' }; }
    const w = wRes.rows[0];
    await client.query(`UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [w.amount_usd, w.telegram_id]);
    await client.query(`UPDATE withdrawals SET status = 'REJECTED', reject_reason = $1 WHERE id = $2`, [reason, withdrawalId]);
    await client.query('COMMIT');
    notifyUserDM(w.telegram_id, `↩️ <b>Withdrawal Rejected &amp; Refunded (#${withdrawalId})</b>\nReason: ${escHtml(reason)}`, `↩️ <b>የማውጣት ጥያቄዎ ውድቅ ሆኖ ብሩ ተመልሷል</b>\nምክንያት: ${escHtml(reason)}`);
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

async function reviewKycByUserId(telegramId, decision, reason = null) {
  await pool.query(`UPDATE users SET kyc_status = $1, kyc_reject_reason = $2 WHERE telegram_id = $3`, [decision, decision === 'Rejected' ? (reason || 'Documents unclear') : null, telegramId.toString()]);
  if (decision === 'Approved') {
    notifyUserDM(telegramId, `✅ <b>KYC Approved!</b> Full P2P &amp; Convert access unlocked.`, `✅ <b>የማንነት ማረጋገጫዎ (KYC) ጸድቋል!</b>`);
  } else {
    notifyUserDM(telegramId, `❌ <b>KYC Rejected</b>\nReason: ${escHtml(reason || 'Resubmit clearer photos')}`, `❌ <b>KYC ውድቅ ተደርጓል</b>\nምክንያት: ${escHtml(reason || 'ግልጽ ፎቶ ይላኩ')}`);
  }
  return { ok: true };
}

async function releaseP2PTradeByCode(tradeCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(`SELECT * FROM p2p_trades WHERE trade_code = $1 AND status IN ('PENDING','PAID','VERIFYING','DISPUTED') FOR UPDATE`, [tradeCode]);
    if (tRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Trade not found or closed' }; }
    const trade = tRes.rows[0];
    const releaseAmt = parseFloat(trade.net_usd) > 0 ? parseFloat(trade.net_usd) : parseFloat(trade.amount_usd);

    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [releaseAmt, trade.buyer_id]);
    if (!String(trade.seller_id).startsWith('SYSTEM_')) {
      await client.query('UPDATE users SET locked_usd = GREATEST(0, locked_usd - $1) WHERE telegram_id = $2', [trade.amount_usd, trade.seller_id]);
    }
    const payoutStatus = trade.seller_payout_account ? 'PENDING_PAYOUT' : 'NONE';
    await client.query(`UPDATE p2p_trades SET status = 'RELEASED', seller_payout_status = $1 WHERE trade_code = $2`, [payoutStatus, tradeCode]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, 'P2P_RELEASE', $2, $3)`, [trade.buyer_id, releaseAmt, `P2P ${tradeCode} Released`]);
    await client.query('COMMIT');

    notifyUserDM(trade.buyer_id, `✅ <b>P2P Released (${tradeCode})!</b> +$${releaseAmt.toFixed(2)} USDT credited.`, `✅ <b>የ P2P ትዕዛዝዎ ተለቋል (${tradeCode})!</b> +$${releaseAmt.toFixed(2)} ገብቷል።`);
    if (!String(trade.seller_id).startsWith('SYSTEM_')) {
      notifyUserDM(trade.seller_id, `💰 <b>P2P Sold (${tradeCode})!</b> Net payout ${Number(trade.seller_payout_etb).toLocaleString()} ETB queued for ${escHtml(trade.seller_payout_account)}.`, `💰 <b>ዶላርዎ ተሽጧል!</b> ${Number(trade.seller_payout_etb).toLocaleString()} ETB ወደ ${escHtml(trade.seller_payout_account)} ይላካል።`);
    }
    return { ok: true, releaseAmt };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

async function rejectP2PTradeByCode(tradeCode, reason = 'Payment not verified') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(`SELECT * FROM p2p_trades WHERE trade_code = $1 AND status IN ('PENDING','PAID','VERIFYING','DISPUTED') FOR UPDATE`, [tradeCode]);
    if (tRes.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Trade not found' }; }
    const trade = tRes.rows[0];
    await client.query(`UPDATE p2p_trades SET status = 'REJECTED', reject_reason = $1 WHERE trade_code = $2`, [reason, tradeCode]);
    const adCheck = await client.query(`SELECT trade_type FROM p2p_ads WHERE id = $1`, [trade.ad_id]);
    if (adCheck.rows[0]?.trade_type === 'BUY' && !String(trade.seller_id).startsWith('SYSTEM_')) {
      await client.query(`UPDATE users SET locked_usd = GREATEST(0, locked_usd - $1), balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [trade.amount_usd, trade.seller_id]);
    }
    await client.query(`UPDATE p2p_ads SET remaining_usd = remaining_usd + $1 WHERE id = $2`, [trade.amount_usd, trade.ad_id]);
    await client.query('COMMIT');
    invalidateP2PCache();
    notifyUserDM(trade.buyer_id, `❌ <b>P2P Rejected (${tradeCode})</b>\nReason: ${escHtml(reason)}`, `❌ <b>P2P ትዕዛዝዎ ውድቅ ተደርጓል</b>\nምክንያት: ${escHtml(reason)}`);
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: e.message }; } finally { client.release(); }
}

// ═════════════════════ 8. TELEGRAM WEBHOOK ═════════════════════
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update || !pool) return;
  try {
    if (update.message?.text?.startsWith('/start') && update.message.chat?.type === 'private') {
      await tgCall('sendMessage', {
        chat_id: update.message.chat.id,
        text: `👋 Welcome <b>${escHtml(update.message.from?.first_name || 'Friend')}</b> to <b>Binance Ethiopia</b>!\n\n📢 Channel: ${OFFICIAL_CHANNEL}`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🚀 Open Mini App', url: `https://t.me/${BINANCE_BOT_USER}/binance` }]] }
      });
      return;
    }

    if (update.callback_query) {
      const cq = update.callback_query, chatId = String(cq.message?.chat?.id || '');
      if (chatId !== String(ADMIN_GROUP_ID)) return;
      const adminTag = cq.from?.username ? `@${cq.from.username}` : (cq.from?.first_name || 'Admin');
      const parts = (cq.data || '').split(':'), action = parts[0], targetId = parts[1];

      if (action === 'dep_app') {
        const r = await approveDepositById(parseInt(targetId), adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Approved!' : r.error });
        if (r.ok) {
          tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption||''}\n\n✅ <b>APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
          tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text||''}\n\n✅ <b>APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
        }
      } else if (action === 'sto_app') {
        const r = await approveStoreOrderById(parseInt(targetId), adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Delivered!' : r.error });
        if (r.ok) {
          tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption||''}\n\n✅ <b>DELIVERED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
          tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text||''}\n\n✅ <b>DELIVERED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
        }
      } else if (action === 'wdr_app') {
        const r = await approveWithdrawalById(parseInt(targetId), `TG-${adminTag}`, adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Marked Paid!' : r.error });
        if (r.ok) tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text||''}\n\n💸 <b>PAID by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
      } else if (action === 'kyc_app') {
        await reviewKycByUserId(targetId, 'Approved');
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'KYC Approved!' });
        tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text||''}\n\n✅ <b>KYC APPROVED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
      } else if (action === 'p2p_rel') {
        const r = await releaseP2PTradeByCode(targetId);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Released!' : r.error });
        if (r.ok) {
          tgCall('editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message.caption||''}\n\n🔓 <b>RELEASED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
          tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `${cq.message.text||''}\n\n🔓 <b>RELEASED by ${escHtml(adminTag)}</b>`, parse_mode: 'HTML' }).catch(()=>{});
        }
      } else if (['dep_rej', 'sto_rej', 'wdr_rej', 'kyc_rej', 'p2p_rej'].includes(action)) {
        const tType = { dep_rej: 'DEPOSIT', sto_rej: 'STORE', wdr_rej: 'WITHDRAW', kyc_rej: 'KYC', p2p_rej: 'P2P' }[action];
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
        await notifyAdminGroup(`Select rejection reason for <b>${tType} #${escHtml(targetId)}</b>:`, {
          inline_keyboard: [
            [{ text: '🚫 Fake / Not Received', callback_data: `rej_pick:${tType}:${targetId}:fake` }],
            [{ text: '🚫 Blurry / Unclear Photo', callback_data: `rej_pick:${tType}:${targetId}:blurry` }],
            [{ text: '🚫 Wrong Amount / Info', callback_data: `rej_pick:${tType}:${targetId}:amount` }],
            [{ text: '✍️ Write Custom Reason', callback_data: `rej_cust:${tType}:${targetId}` }]
          ]
        });
      } else if (action === 'rej_pick') {
        const [, tType, tId, code] = parts;
        const reason = { fake: 'Fake receipt or payment not received.', blurry: 'Blurry/unclear photo.', amount: 'Wrong amount or account mismatch.' }[code] || 'Verification failed.';
        await executeRejectionByType(tType, tId, reason, adminTag);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Rejected!' });
        tgCall('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `❌ <b>${tType} #${escHtml(tId)} REJECTED by ${escHtml(adminTag)}</b>\nReason: ${escHtml(reason)}`, parse_mode: 'HTML' });
      } else if (action === 'rej_cust') {
        const [, tType, tId] = parts;
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
        const sent = await tgCall('sendMessage', {
          chat_id: chatId, text: `✍️ ${escHtml(adminTag)}, reply to THIS message with rejection reason for <b>${tType} #${escHtml(tId)}</b>:`,
          parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true }
        });
        if (sent?.ok) await pool.query(`INSERT INTO telegram_pending_replies (message_id, target_type, target_id, admin_tg_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [sent.result.message_id, tType, tId, String(cq.from.id)]);
      }
    }

    if (update.message?.reply_to_message && String(update.message.chat?.id) === String(ADMIN_GROUP_ID)) {
      const pRes = await pool.query(`DELETE FROM telegram_pending_replies WHERE message_id = $1 RETURNING *`, [update.message.reply_to_message.message_id]);
      if (pRes.rows.length > 0 && update.message.text) {
        const row = pRes.rows[0], adminTag = update.message.from?.username ? `@${update.message.from.username}` : 'Admin';
        await executeRejectionByType(row.target_type, row.target_id, update.message.text.trim(), adminTag);
        await notifyAdminGroup(`❌ <b>${row.target_type} #${escHtml(row.target_id)} REJECTED</b>\nReason sent: <i>${escHtml(update.message.text.trim())}</i>`);
      }
    }
  } catch (err) { console.error('Webhook err:', err.message); }
});

async function executeRejectionByType(tType, tId, reason, actor) {
  if (tType === 'DEPOSIT') return rejectDepositById(parseInt(tId), reason, actor);
  if (tType === 'STORE') return rejectStoreOrderById(parseInt(tId), reason, actor);
  if (tType === 'WITHDRAW') return rejectWithdrawalById(parseInt(tId), reason);
  if (tType === 'KYC') return reviewKycByUserId(tId, 'Rejected', reason);
  if (tType === 'P2P') return rejectP2PTradeByCode(tId, reason);
}

// ═════════════════════ 9. MINI APP APIS ═════════════════════
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/config', async (req, res) => {
  const cfg = await getSystemConfig();
  res.json({
    app_name: 'Binance Ethiopia Dollar Vault', fx_rate: cfg.fx_rate,
    stage4_min_invites: cfg.stage4_min_invites, stage4_min_deposit_usd: cfg.stage4_min_deposit_usd,
    p2p_fee_percent: cfg.p2p_fee_percent, min_withdraw_usd: cfg.min_withdraw_usd,
    min_withdraw_etb: cfg.min_withdraw_usd * cfg.fx_rate, bot_username: BINANCE_BOT_USER,
    channel_url: 'https://t.me/Binance_ethiopa', accounts: cfg.accounts
  });
});

app.post('/api/auth', async (req, res) => {
  const { telegram_id, first_name, last_name, username, ref_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  if (!pool) return res.json({ user: { balance_usd: 0, voucher_usd: 0, locked_usd: 0, kyc_status: 'None', prize_tickets: 0 }, isNew: false });

  try {
    let userRow;
    let isNew = false;
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows.length === 0) {
      isNew = true;
      const validRef = (ref_by && ref_by !== telegram_id.toString()) ? ref_by : null;
      const ins = await pool.query(
        `INSERT INTO users (telegram_id, first_name, last_name, username, balance_usd, voucher_usd, kyc_status, referred_by) VALUES ($1,$2,$3,$4,0.00,0.00,'None',$5) RETURNING *`,
        [telegram_id.toString(), first_name || 'User', last_name || '', username || '', validRef]
      );
      if (validRef) await pool.query(`INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [validRef, telegram_id.toString()]);
      userRow = ins.rows[0];
    } else {
      userRow = uRes.rows[0];
    }
    if (userRow.is_banned === 1) return res.status(403).json({ error: 'Account suspended.' });

    const [refC, depSum] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`, [telegram_id.toString()]),
      pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS tot FROM deposits WHERE telegram_id = $1 AND status = 'APPROVED'`, [telegram_id.toString()])
    ]);
    userRow.prize_tickets = parseInt(refC.rows[0].count) + Math.floor(parseFloat(depSum.rows[0].tot) / 5);
    res.json({ user: userRow, isNew });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/preferences', async (req, res) => {
  const { telegram_id, preferred_lang, onboarding_done } = req.body;
  if (!telegram_id || !pool) return res.json({ ok: true });
  await pool.query(`UPDATE users SET preferred_lang = COALESCE($1, preferred_lang), onboarding_done = COALESCE($2, onboarding_done) WHERE telegram_id = $3`, [preferred_lang || null, onboarding_done !== undefined ? onboarding_done : null, telegram_id.toString()]).catch(()=>{});
  res.json({ ok: true });
});

app.post('/api/kyc/submit', async (req, res) => {
  const { telegram_id, phone_number, full_name, national_id, id_photo_base64, selfie_base64 } = req.body;
  if (!telegram_id || !phone_number || !full_name || !national_id) return res.status(400).json({ error: 'All KYC fields required' });
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  await pool.query(`UPDATE users SET phone_number=$1, kyc_full_name=$2, national_id=$3, kyc_status='Pending', kyc_reject_reason=NULL WHERE telegram_id=$4`, [phone_number, full_name, national_id, telegram_id.toString()]);
  if (id_photo_base64) await sendBase64PhotoToGroup(id_photo_base64, `🪪 <b>ID Photo</b> — ${escHtml(full_name)} (<code>${escHtml(telegram_id)}</code>)`);
  if (selfie_base64) await sendBase64PhotoToGroup(selfie_base64, `🤳 <b>Selfie</b> — ${escHtml(full_name)} (<code>${escHtml(telegram_id)}</code>)`);
  await notifyAdminGroup(`🪪 <b>KYC REQUEST</b>\n👤 <code>${escHtml(telegram_id)}</code>\n📛 ${escHtml(full_name)}\n📱 ${escHtml(phone_number)}\n🆔 <code>${escHtml(national_id)}</code>\n🕒 ${formatEAT()}`, {
    inline_keyboard: [[{ text: '✅ Approve KYC', callback_data: `kyc_app:${telegram_id}` }, { text: '❌ Reject KYC', callback_data: `kyc_rej:${telegram_id}` }]]
  });
  res.json({ success: true, kyc_status: 'Pending', message: 'Pending (waiting for admin review in Telegram)' });
});

// Sustainable Bonus Amounts: Welcome $0.15, Stage 1 $0.25, Stage 2 $0.50, Stage 3 $1.50 (VOUCHER), Stage 4 $5.00 (VOUCHER)
app.post('/api/claim-welcome', async (req, res) => {
  const { telegram_id } = req.body;
  const BONUS_USD = 0.15;
  if (!pool) return res.status(500).json({ error: 'DB offline' });
  try {
    const uRes = await pool.query('SELECT welcome_claimed, channel_joined, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (!uRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (uRes.rows[0].is_banned === 1) return res.status(403).json({ error: 'Banned' });
    if (uRes.rows[0].welcome_claimed === 1) return res.status(400).json({ error: 'Already claimed!' });

    if (uRes.rows[0].channel_joined === 0) {
      const ch = await checkChannelMembership(telegram_id);
      if (!ch.joined) return res.status(400).json({ need_channel: true, channel_url: 'https://t.me/Binance_ethiopa', error: 'Join @Binance_ethiopa channel first!' });
      await pool.query('UPDATE users SET channel_joined = 1 WHERE telegram_id = $1', [telegram_id.toString()]);
    }
    const up = await pool.query(`UPDATE users SET balance_usd = balance_usd + $1, welcome_claimed = 1 WHERE telegram_id = $2 AND welcome_claimed = 0 RETURNING balance_usd`, [BONUS_USD, telegram_id.toString()]);
    if (up.rowCount === 0) return res.status(400).json({ error: 'Already claimed' });
    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'WELCOME_BONUS',$2,'Starter Vault Gift')`, [telegram_id.toString(), BONUS_USD]);
    res.json({ success: true, balance_usd: parseFloat(up.rows[0].balance_usd), message: '🎉 $0.15 USD Welcome Bonus Credited!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/claim-stage', async (req, res) => {
  const { telegram_id, stage } = req.body;
  const s = parseInt(stage);
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  try {
    const cfg = await getSystemConfig();
    const uRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    const user = uRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned === 1) return res.status(403).json({ error: 'Banned' });

    let rewardUSD = 0, col = '', isVoucher = false;
    if (s === 1) {
      if (user.stage1_claimed) return res.status(400).json({ error: 'Stage 1 claimed' });
      if (user.kyc_status !== 'Approved') return res.status(400).json({ error: 'Stage 1 requires Approved KYC.' });
      rewardUSD = 0.25; col = 'stage1_claimed';
    } else if (s === 2) {
      if (!user.stage1_claimed) return res.status(400).json({ error: 'Complete Stage 1 first' });
      if (user.stage2_claimed) return res.status(400).json({ error: 'Stage 2 claimed' });
      const dep = await pool.query(`SELECT COUNT(*) FROM deposits WHERE telegram_id=$1 AND status='APPROVED'`, [telegram_id.toString()]);
      if (parseInt(dep.rows[0].count) === 0) return res.status(400).json({ error: 'Stage 2 requires 1 approved Add Funds deposit.' });
      rewardUSD = 0.50; col = 'stage2_claimed';
    } else if (s === 3) {
      if (!user.stage2_claimed) return res.status(400).json({ error: 'Complete Stage 2 first' });
      if (user.stage3_claimed) return res.status(400).json({ error: 'Stage 3 claimed' });
      const ref = await pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id=$1`, [telegram_id.toString()]);
      if (parseInt(ref.rows[0].count) < 5) return res.status(400).json({ error: `Stage 3 requires 5 invites (${ref.rows[0].count}/5).` });
      rewardUSD = 1.50; col = 'stage3_claimed'; isVoucher = true;
    } else if (s === 4) {
      if (!user.stage3_claimed) return res.status(400).json({ error: 'Complete Stage 3 first' });
      if (user.stage4_claimed) return res.status(400).json({ error: 'Stage 4 claimed' });
      const [ref, dep] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM referrals WHERE referrer_id=$1`, [telegram_id.toString()]),
        pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS tot FROM deposits WHERE telegram_id=$1 AND status='APPROVED'`, [telegram_id.toString()])
      ]);
      const inv = parseInt(ref.rows[0].count), dTot = parseFloat(dep.rows[0].tot);
      if (inv < cfg.stage4_min_invites || dTot < cfg.stage4_min_deposit_usd) {
        return res.status(400).json({ error: `Stage 4 requires ${cfg.stage4_min_invites} invites (${inv}/${cfg.stage4_min_invites}) AND $${cfg.stage4_min_deposit_usd}+ deposits ($${dTot.toFixed(2)}).` });
      }
      rewardUSD = 5.00; col = 'stage4_claimed'; isVoucher = true;
    } else { return res.status(400).json({ error: 'Invalid stage' }); }

    const targetCol = isVoucher ? 'voucher_usd' : 'balance_usd';
    const up = await pool.query(
      `UPDATE users SET ${targetCol} = ${targetCol} + $1, ${col} = 1 WHERE telegram_id = $2 AND ${col} = 0 RETURNING balance_usd, voucher_usd`,
      [rewardUSD, telegram_id.toString()]
    );
    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1, $2, $3, $4)`, [telegram_id.toString(), isVoucher ? 'VOUCHER_REWARD' : 'STAGE_REWARD', rewardUSD, `Stage ${s} ${isVoucher ? 'Fee Voucher' : 'Cash Reward'}`]);
    res.json({ success: true, is_voucher: isVoucher, reward_usd: rewardUSD, balance_usd: parseFloat(up.rows[0].balance_usd), voucher_usd: parseFloat(up.rows[0].voucher_usd) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/daily-spin', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id || !pool) return res.status(400).json({ error: 'Invalid request' });
  const now = new Date();
  try {
    const uRes = await pool.query('SELECT balance_usd, kyc_status, last_spin_at, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    const user = uRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned === 1) return res.status(403).json({ error: 'Banned' });
    if (user.kyc_status !== 'Approved') return res.status(400).json({ error: 'Daily Spin requires Approved KYC.' });
    if (user.last_spin_at && ((now - new Date(user.last_spin_at)) / 3600000) < 24) {
      return res.status(400).json({ error: `Next spin available in ${(24 - ((now - new Date(user.last_spin_at)) / 3600000)).toFixed(1)}h.` });
    }
    const wonUSD = parseFloat(((Math.random() * 0.04) + 0.01).toFixed(2)); // $0.01 - $0.05 sustainable
    const up = await pool.query('UPDATE users SET balance_usd = balance_usd + $1, last_spin_at = $2 WHERE telegram_id = $3 RETURNING balance_usd', [wonUSD, now.toISOString(), telegram_id.toString()]);
    await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'SPIN_WIN',$2,'Daily Spin')`, [telegram_id.toString(), wonUSD]);
    res.json({ success: true, won_usd: wonUSD, balance_usd: parseFloat(up.rows[0].balance_usd) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════ 10. INTERNAL ACCOUNT-TO-ACCOUNT TRANSFER (1% FEE / VOUCHER COVERED) ═════════════════════
app.post('/api/transfer/lookup', async (req, res) => {
  const q = String(req.body.query || '').trim().replace(/^@/, '');
  if (!q || !pool) return res.status(400).json({ error: 'Enter recipient Telegram ID or @username' });
  const r = await pool.query(`SELECT telegram_id, first_name, last_name, username FROM users WHERE telegram_id = $1 OR LOWER(username) = LOWER($1) LIMIT 1`, [q]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Recipient not found on Binance Ethiopia.' });
  const u = r.rows[0];
  res.json({ found: true, telegram_id: u.telegram_id, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), username: u.username });
});

app.post('/api/transfer/send', async (req, res) => {
  const { from_id, to_query, amount_usd } = req.body;
  const amt = parseFloat(amount_usd);
  if (!from_id || !to_query || !amt || amt < 0.50) return res.status(400).json({ error: 'Minimum transfer is $0.50 USD.' });
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  const cleanTarget = String(to_query).trim().replace(/^@/, '');
  const cfg = await getSystemConfig();
  const calc = calcOrder(amt, 1, cfg.p2p_fee_percent); // 1% (0.01) fee

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [senderRes, recvRes] = await Promise.all([
      client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [from_id.toString()]),
      client.query('SELECT * FROM users WHERE telegram_id = $1 OR LOWER(username) = LOWER($1) LIMIT 1 FOR UPDATE', [cleanTarget])
    ]);
    if (senderRes.rows.length === 0 || recvRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sender or recipient not found.' });
    }
    const sender = senderRes.rows[0], recv = recvRes.rows[0];
    if (sender.telegram_id === recv.telegram_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer to yourself.' });
    }
    if (sender.is_banned === 1) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Account banned.' }); }

    // Cover 1% fee with voucher_usd if available!
    let voucherUsed = 0;
    let cashDebit = calc.gross;
    if (parseFloat(sender.voucher_usd) >= calc.fee) {
      voucherUsed = calc.fee;
    } else {
      cashDebit = Math.round((calc.gross + calc.fee) * 100) / 100;
    }

    if (parseFloat(sender.balance_usd) < cashDebit) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient balance (need $${cashDebit.toFixed(2)} USD).` });
    }

    const upSender = await client.query(
      `UPDATE users SET balance_usd = balance_usd - $1, voucher_usd = voucher_usd - $2 WHERE telegram_id = $3 RETURNING balance_usd, voucher_usd`,
      [cashDebit, voucherUsed, sender.telegram_id]
    );
    await client.query(`UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [calc.gross, recv.telegram_id]);

    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'TRANSFER_OUT',$2,$3)`, [sender.telegram_id, cashDebit, `Sent to ${recv.first_name} (${recv.telegram_id}) | Fee: $${calc.fee}`]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'TRANSFER_IN',$2,$3)`, [recv.telegram_id, calc.gross, `Received from ${sender.first_name} (${sender.telegram_id})`]);
    await client.query('COMMIT');

    notifyUserDM(recv.telegram_id, `💸 <b>You Received $${calc.gross.toFixed(2)} USD!</b>\nFrom: ${escHtml(sender.first_name)}`, `💸 <b>$${calc.gross.toFixed(2)} USD ደርሶዎታል!</b>\nከ: ${escHtml(sender.first_name)}`);
    notifyAdminGroup(`🔁 <b>INTERNAL TRANSFER:</b> $${calc.gross.toFixed(2)} (Fee: $${calc.fee.toFixed(2)}${voucherUsed > 0 ? ' [Voucher]' : ''})\nFrom: <code>${sender.telegram_id}</code> → To: <code>${recv.telegram_id}</code>`);

    res.json({
      success: true,
      balance_usd: parseFloat(upSender.rows[0].balance_usd),
      voucher_usd: parseFloat(upSender.rows[0].voucher_usd),
      message: `Sent $${calc.gross.toFixed(2)} USD to ${recv.first_name}! (Fee: $${calc.fee.toFixed(2)}${voucherUsed > 0 ? ' covered by Voucher' : ''})`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ═════════════════════ 11. ADD FUNDS, STORE & CARD TOP-UP ═════════════════════
const handleAddFunds = async (req, res) => {
  const { telegram_id, currency, amount, payment_method, transaction_ref, sms_text, screenshot_base64 } = req.body;
  const cleanRef = (transaction_ref || '').trim();
  if (!telegram_id || !payment_method || (!cleanRef && !sms_text)) return res.status(400).json({ error: 'Missing required fields.' });
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  try {
    const cfg = await getSystemConfig();
    const acc = findActiveAccount(cfg.accounts, payment_method);
    if (!acc || !acc.account_value) return res.status(400).json({ error: 'Payment method unavailable.' });

    const uRes = await pool.query('SELECT first_name, username, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (!uRes.rows[0]) return res.status(404).json({ error: 'User not found.' });
    if (uRes.rows[0].is_banned === 1) return res.status(403).json({ error: 'Banned.' });
    const userLabel = uRes.rows[0].username ? `@${uRes.rows[0].username}` : uRes.rows[0].first_name;

    const effectiveRef = cleanRef || `SMS_${Date.now()}_${telegram_id}`;
    if (cleanRef && await isDuplicateRefAnywhere(cleanRef)) {
      await recordFakeAttempt(telegram_id, `Duplicate TxID: ${cleanRef}`);
      return res.status(400).json({ error: 'Transaction ID already used!' });
    }

    let amountVal = parseFloat(amount) || 0;
    let amountUSD = currency === 'ETB' ? (amountVal / cfg.fx_rate) : amountVal;

    let ver = { outcome: 'MANUAL' };
    if (acc.pool_type === 'ETB_OWNER') {
      ver = await verifyETBWithServer(cleanRef, amountVal, sms_text);
      if (ver.outcome === 'VERIFIED' && ver.amount) { amountVal = ver.amount; amountUSD = amountVal / cfg.fx_rate; }
    } else if (acc.network_type === 'ONCHAIN_BSC') ver = await verifyBscTransaction(cleanRef, acc.account_value, amountUSD);
    else if (acc.network_type === 'ONCHAIN_TRON') ver = await verifyTronTransaction(cleanRef, acc.account_value, amountUSD);
    else if (acc.network_type === 'EXCHANGE_ID') {
      const syn = validateExchangeOrderSyntax(cleanRef);
      if (!syn.valid) { await recordFakeAttempt(telegram_id, `Bad Exchange ID: ${cleanRef}`); return res.status(400).json({ error: syn.reason }); }
    }

    if (ver.outcome === 'RETRY') return res.status(200).json({ success: false, retryable: true, status: ver.status, message: ver.message });
    if (ver.outcome === 'REJECT') { await recordFakeAttempt(telegram_id, ver.reason); return res.status(400).json({ error: `❌ ${ver.reason}` }); }

    const finalUsd = Math.round((ver.amountUsd || amountUSD) * 100) / 100;
    if (finalUsd <= 0) return res.status(400).json({ error: 'Invalid amount.' });

    const eatNow = formatEAT(), status = ver.outcome === 'VERIFIED' ? 'APPROVED' : 'PENDING';
    const verifiedBy = ver.outcome === 'VERIFIED' ? (acc.pool_type === 'ETB_OWNER' ? 'VERIFY_SERVER' : 'AUTO_ONCHAIN') : null;
    const dbRef = ver.ref || effectiveRef;

    const client = await pool.connect();
    let depositId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO deposits (telegram_id, pool_target, currency, amount, amount_usd, fx_rate_used, payment_method, destination_account, transaction_ref, status, verified_by, eat_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [telegram_id.toString(), acc.pool_type, currency, amountVal, finalUsd, cfg.fx_rate, acc.key_slug, acc.account_value, dbRef, status, verifiedBy, eatNow]
      );
      depositId = ins.rows[0].id;
      if (status === 'APPROVED') {
        await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2', [finalUsd, telegram_id.toString()]);
        await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'ADD_FUNDS',$2,$3)`, [telegram_id.toString(), finalUsd, `${verifiedBy}: ${acc.label}`]);
        if (acc.pool_type === 'USD_NBIYU') {
          await client.query(`INSERT INTO nbiyu_ledger (tx_code, direction, telegram_id, user_name, channel, destination_account, amount_usd, tx_ref, verified_by, eat_timestamp) VALUES ($1,'IN',$2,$3,$4,$5,$6,$7,$8,$9)`, [`NBY-IN-${depositId}-${Date.now().toString().slice(-4)}`, telegram_id.toString(), userLabel, acc.label, acc.account_value, finalUsd, dbRef, verifiedBy, eatNow]);
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    if (status === 'APPROVED') {
      notifyAdminGroup(`✅ <b>VERIFIED ADD FUNDS (${acc.pool_type})</b>\n👤 ${escHtml(userLabel)}\n💵 <b>$${finalUsd.toFixed(2)}</b> (${amountVal} ${currency})\n🏦 ${escHtml(acc.label)}\n🧾 <code>${escHtml(dbRef)}</code>\n🕒 ${eatNow}`);
    } else {
      const cap = `⏳ <b>PENDING ADD FUNDS #${depositId} (${acc.pool_type})</b>\n👤 ${escHtml(userLabel)} (<code>${telegram_id}</code>)\n💵 <b>$${finalUsd.toFixed(2)}</b> (${amountVal} ${currency})\n🏦 ${escHtml(acc.label)}\n📍 To: <code>${escHtml(acc.account_value)}</code>\n🧾 <code>${escHtml(dbRef)}</code>\n🕒 ${eatNow}`;
      await sendBase64PhotoToGroup(screenshot_base64, cap, { inline_keyboard: [[{ text: '✅ Approve', callback_data: `dep_app:${depositId}` }, { text: '❌ Reject', callback_data: `dep_rej:${depositId}` }]] });
    }
    res.json({ success: true, verified: status === 'APPROVED', message: status === 'APPROVED' ? `🎉 Verified! $${finalUsd.toFixed(2)} USD credited.` : 'Submitted! Waiting for admin review in Telegram.', deposit_id: depositId });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
app.post('/api/funds/add', handleAddFunds);
app.post('/api/deposit/submit', handleAddFunds);

const STORE_CATALOG = {
  VISA:       { name: 'International Virtual Visa Card', priceUsd: 1.50 },
  MASTERCARD: { name: 'International Virtual MasterCard', priceUsd: 1.50 },
  PHONE_US:   { name: 'USA (+1) Virtual Phone Number', priceUsd: 1.50 },
  TG_PREMIUM: { name: 'Telegram Premium (3 Months)', priceUsd: 10.00 },
  AUTOBOT:    { name: '30-Day Cloud Auto-Pilot', priceUsd: 2.00 }
};

app.post('/api/store/order', async (req, res) => {
  const { telegram_id, product_id, currency, payment_method, transaction_ref, sms_text, service_details, screenshot_base64 } = req.body;
  const prod = STORE_CATALOG[product_id], cleanRef = (transaction_ref || '').trim();
  if (!prod || !telegram_id || !payment_method || (!cleanRef && !sms_text)) return res.status(400).json({ error: 'Invalid order details.' });
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  try {
    const cfg = await getSystemConfig();
    const acc = findActiveAccount(cfg.accounts, payment_method);
    if (!acc || !acc.account_value) return res.status(400).json({ error: 'Method unavailable.' });
    const uRes = await pool.query('SELECT is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Banned.' });
    if (cleanRef && await isDuplicateRefAnywhere(cleanRef)) { await recordFakeAttempt(telegram_id, `Dup Store TxID: ${cleanRef}`); return res.status(400).json({ error: 'TxID already used!' }); }

    const expectedEtb = Math.round(prod.priceUsd * cfg.fx_rate * 100) / 100;
    let ver = { outcome: 'MANUAL' };
    if (acc.pool_type === 'ETB_OWNER') ver = await verifyETBWithServer(cleanRef, expectedEtb, sms_text);
    else if (acc.network_type === 'ONCHAIN_BSC') ver = await verifyBscTransaction(cleanRef, acc.account_value, prod.priceUsd);
    else if (acc.network_type === 'ONCHAIN_TRON') ver = await verifyTronTransaction(cleanRef, acc.account_value, prod.priceUsd);
    else if (acc.network_type === 'EXCHANGE_ID') { const syn = validateExchangeOrderSyntax(cleanRef); if (!syn.valid) return res.status(400).json({ error: syn.reason }); }

    if (ver.outcome === 'RETRY') return res.status(200).json({ success: false, retryable: true, message: ver.message });
    if (ver.outcome === 'REJECT') { await recordFakeAttempt(telegram_id, ver.reason); return res.status(400).json({ error: `❌ ${ver.reason}` }); }

    const orderCode = 'STR-' + Math.floor(100000 + Math.random() * 900000);
    const dbRef = ver.ref || cleanRef || `SMS_${Date.now()}`;
    const ins = await pool.query(
      `INSERT INTO store_orders (order_code, telegram_id, product_id, product_name, price_usd, price_etb, currency, payment_method, pool_target, transaction_ref, service_details, status, eat_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12) RETURNING id`,
      [orderCode, telegram_id.toString(), product_id, prod.name, prod.priceUsd, expectedEtb, currency || 'ETB', acc.key_slug, acc.pool_type, dbRef, service_details || '', formatEAT()]
    );
    const orderId = ins.rows[0].id;
    if (ver.outcome === 'VERIFIED') {
      const ful = await approveStoreOrderById(orderId, acc.pool_type === 'ETB_OWNER' ? 'VERIFY_SERVER' : 'AUTO_ONCHAIN');
      return res.json({ success: true, verified: true, message: `🎉 Verified! ${ful.deliveryInfo}`, order_code: orderCode });
    }
    const cap = `🛍️ <b>STORE ORDER #${orderId} (${orderCode})</b>\n📦 ${escHtml(prod.name)}\n👤 <code>${telegram_id}</code>\n💵 $${prod.priceUsd.toFixed(2)} (${expectedEtb} ETB)\n🏦 ${escHtml(acc.label)}\n🧾 <code>${escHtml(dbRef)}</code>`;
    await sendBase64PhotoToGroup(screenshot_base64, cap, { inline_keyboard: [[{ text: '✅ Deliver', callback_data: `sto_app:${orderId}` }, { text: '❌ Reject', callback_data: `sto_rej:${orderId}` }]] });
    res.json({ success: true, verified: false, message: `Order ${orderCode} submitted!`, order_code: orderCode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cards/topup', async (req, res) => {
  const { telegram_id, card_id, amount_usd } = req.body;
  const amt = parseFloat(amount_usd);
  if (!telegram_id || !card_id || !amt || amt < 5) return res.status(400).json({ error: 'Minimum card top-up is $5.00 USD.' });
  if (!pool) return res.status(500).json({ error: 'DB offline' });

  const cfg = await getSystemConfig();
  const calc = calcOrder(amt, 1, cfg.p2p_fee_percent); // 1% fee
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uRes = await client.query('SELECT balance_usd, voucher_usd FROM users WHERE telegram_id = $1 FOR UPDATE', [telegram_id.toString()]);
    const cRes = await client.query('SELECT * FROM virtual_cards WHERE id = $1 AND telegram_id = $2 FOR UPDATE', [card_id, telegram_id.toString()]);
    if (!uRes.rows[0] || !cRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Card or user not found.' }); }

    const user = uRes.rows[0], card = cRes.rows[0];
    let voucherUsed = 0, cashDebit = calc.gross;
    if (parseFloat(user.voucher_usd) >= calc.fee) voucherUsed = calc.fee;
    else cashDebit = Math.round((calc.gross + calc.fee) * 100) / 100;

    if (parseFloat(user.balance_usd) < cashDebit) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Need $${cashDebit.toFixed(2)} USD in Vault.` }); }

    const upU = await client.query(`UPDATE users SET balance_usd = balance_usd - $1, voucher_usd = voucher_usd - $2 WHERE telegram_id = $3 RETURNING balance_usd, voucher_usd`, [cashDebit, voucherUsed, telegram_id.toString()]);
    await client.query(`UPDATE virtual_cards SET balance_usd = balance_usd + $1 WHERE id = $2`, [calc.gross, card_id]);
    await client.query(`INSERT INTO card_topups (telegram_id, card_id, amount_usd, fee_usd, status, eat_time) VALUES ($1,$2,$3,$4,'COMPLETED',$5)`, [telegram_id.toString(), card_id, calc.gross, calc.fee, formatEAT()]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'CARD_TOPUP',$2,$3)`, [telegram_id.toString(), cashDebit, `Top-up ${card.card_type} ••••${String(card.card_number).slice(-4)}`]);
    await client.query('COMMIT');

    notifyAdminGroup(`💳 <b>CARD TOP-UP REQUEST</b>\n👤 User: <code>${telegram_id}</code>\n💳 Card: ${card.card_type} <code>${card.card_number}</code>\n💵 Load: <b>+$${calc.gross.toFixed(2)} USD</b>\n🕒 ${formatEAT()}`);
    res.json({ success: true, balance_usd: parseFloat(upU.rows[0].balance_usd), voucher_usd: parseFloat(upU.rows[0].voucher_usd), message: `$${calc.gross.toFixed(2)} loaded to your ${card.card_type}!` });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/api/store/my', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id || !pool) return res.json({ cards: [], orders: [], phones: [] });
  const [cards, orders, phones] = await Promise.all([
    pool.query('SELECT * FROM virtual_cards WHERE telegram_id = $1 ORDER BY id DESC', [telegram_id.toString()]),
    pool.query('SELECT * FROM store_orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()]),
    pool.query('SELECT * FROM phone_orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()])
  ]);
  res.json({ cards: cards.rows, orders: orders.rows, phones: phones.rows });
});

app.post('/api/withdraw', async (req, res) => {
  const { telegram_id, amount_usd, payment_method, account_number } = req.body;
  const amount = parseFloat(amount_usd);
  if (!pool) return res.status(500).json({ error: 'DB offline' });
  const cfg = await getSystemConfig();
  if (!amount || amount < cfg.min_withdraw_usd) return res.status(400).json({ error: `Minimum withdrawal is $${cfg.min_withdraw_usd.toFixed(2)} USD.` });

  const calc = calcOrder(amount, cfg.fx_rate, cfg.p2p_fee_percent); // 1% fee
  const poolSource = /usdt|btc|eth|sol|ton|bnb|binance|bybit|okx|bitget|kucoin/i.test(payment_method || '') ? 'USD_NBIYU' : 'ETB_OWNER';
  const eatNow = formatEAT();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deduct = await client.query(`UPDATE users SET balance_usd = balance_usd - $1 WHERE telegram_id = $2 AND balance_usd >= $1 AND is_banned = 0 RETURNING balance_usd`, [calc.gross, telegram_id.toString()]);
    if (deduct.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance!' }); }
    const amountETB = Math.round(calc.net * cfg.fx_rate * 100) / 100;
    const wIns = await client.query(`INSERT INTO withdrawals (telegram_id, pool_source, amount_usd, amount_etb, payment_method, account_number, eat_time) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [telegram_id.toString(), poolSource, calc.net, amountETB, payment_method, account_number, eatNow]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'WITHDRAW',$2,$3)`, [telegram_id.toString(), calc.gross, `Withdraw #${wIns.rows[0].id} (1% fee: $${calc.fee}) via ${payment_method}`]);
    await client.query('COMMIT');

    const wId = wIns.rows[0].id;
    notifyAdminGroup(`🚨 <b>WITHDRAWAL #${wId} (${poolSource})</b>\n👤 <code>${telegram_id}</code>\n💵 Net Payout: <b>$${calc.net.toFixed(2)}</b> (${amountETB.toLocaleString()} ETB)\n🏦 ${escHtml(payment_method)}: <code>${escHtml(account_number)}</code>\n🕒 ${eatNow}`, {
      inline_keyboard: [[{ text: '💸 Mark Paid', callback_data: `wdr_app:${wId}` }, { text: '↩️ Reject & Refund', callback_data: `wdr_rej:${wId}` }]]
    });
    res.json({ success: true, balance_usd: parseFloat(deduct.rows[0].balance_usd), message: `Withdrawal requested! Net $${calc.net.toFixed(2)} (after 1% fee).` });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/api/user/transactions', async (req, res) => {
  if (!req.query.telegram_id || !pool) return res.json([]);
  const rows = await pool.query('SELECT * FROM transactions WHERE telegram_id = $1 ORDER BY id DESC LIMIT 25', [req.query.telegram_id.toString()]);
  res.json(rows.rows);
});

// ═════════════════════ 12. P2P MARKETPLACE WITH REAL STATS & RATINGS ═════════════════════
app.get('/api/p2p/ads', async (req, res) => {
  if (!pool) return res.json([]);
  const now = Date.now();
  if (p2pAdsCache.data && now < p2pAdsCache.expiresAt) return res.json(p2pAdsCache.data);
  try {
    const ads = await pool.query(`
      SELECT a.*, u.kyc_status,
        COALESCE(s.completed_cnt, 0) AS completed_orders,
        COALESCE(s.total_cnt, 0) AS total_orders,
        ROUND(COALESCE(s.avg_rating, 0), 1) AS avg_rating
      FROM p2p_ads a
      LEFT JOIN users u ON a.creator_id = u.telegram_id
      LEFT JOIN (
        SELECT seller_id,
          COUNT(*) FILTER (WHERE status = 'RELEASED') AS completed_cnt,
          COUNT(*) AS total_cnt,
          AVG(buyer_rating) FILTER (WHERE buyer_rating IS NOT NULL) AS avg_rating
        FROM p2p_trades GROUP BY seller_id
      ) s ON a.creator_id = s.seller_id
      WHERE a.status = 'ACTIVE' AND a.remaining_usd > 0
      ORDER BY completed_cnt DESC, a.id DESC
    `);
    const enriched = ads.rows.map(ad => {
      const tot = parseInt(ad.total_orders || 0), comp = parseInt(ad.completed_orders || 0);
      const rate = tot > 0 ? Math.round((comp / tot) * 1000) / 10 : null;
      const isTop = String(ad.creator_id).startsWith('SYSTEM_') || (comp >= 5 && (rate || 0) >= 90);
      return { ...ad, completion_rate: rate, is_top_seller: isTop };
    });
    p2pAdsCache = { data: enriched, expiresAt: now + 15000 };
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/p2p/my', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id || !pool) return res.json({ my_ads: [], my_trades: [] });
  const [ads, trades] = await Promise.all([
    pool.query('SELECT * FROM p2p_ads WHERE creator_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()]),
    pool.query('SELECT * FROM p2p_trades WHERE buyer_id = $1 OR seller_id = $1 ORDER BY id DESC LIMIT 20', [telegram_id.toString()])
  ]);
  res.json({ my_ads: ads.rows, my_trades: trades.rows });
});

app.post('/api/p2p/ads/create', async (req, res) => {
  const { telegram_id, creator_name, trade_type, price_etb, amount_usd, payment_methods, min_limit, max_limit, seller_payout_method, seller_payout_account } = req.body;
  if (!telegram_id || !trade_type || !price_etb || !amount_usd) return res.status(400).json({ error: 'Missing fields' });
  const typeUpper = trade_type.toUpperCase();
  if (typeUpper === 'SELL' && (!seller_payout_method || !seller_payout_account)) return res.status(400).json({ error: 'Enter your CBE or Telebirr payout account!' });

  try {
    const uRes = await pool.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [telegram_id.toString()]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Banned' });
    if (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved') return res.status(403).json({ error: 'KYC verification required.' });

    const amtUSD = parseFloat(amount_usd), rateETB = parseFloat(price_etb);
    if (typeUpper === 'SELL') {
      const lockRes = await pool.query(`UPDATE users SET balance_usd = balance_usd - $1, locked_usd = locked_usd + $1 WHERE telegram_id = $2 AND balance_usd >= $1`, [amtUSD, telegram_id.toString()]);
      if (lockRes.rowCount === 0) return res.status(400).json({ error: 'Insufficient USD Vault balance.' });
    }
    const adRes = await pool.query(
      `INSERT INTO p2p_ads (creator_id, creator_name, trade_type, price_etb, amount_usd, remaining_usd, min_limit_etb, max_limit_etb, payment_methods, seller_payout_method, seller_payout_account) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [telegram_id.toString(), creator_name || 'Trader', typeUpper, rateETB, amtUSD, parseFloat(min_limit)||250, parseFloat(max_limit)||100000, payment_methods || 'Telebirr, CBE', seller_payout_method || null, seller_payout_account || null]
    );
    invalidateP2PCache();
    notifyAdminGroup(`📢 <b>New P2P Ad:</b> ${escHtml(creator_name)} (${typeUpper} $${amtUSD} @ ${rateETB} ETB)`);
    res.json({ success: true, ad: adRes.rows[0], message: 'P2P Ad published!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/p2p/ads/cancel', async (req, res) => {
  const { telegram_id, ad_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const aRes = await client.query(`SELECT * FROM p2p_ads WHERE id=$1 AND creator_id=$2 AND status='ACTIVE' FOR UPDATE`, [ad_id, telegram_id.toString()]);
    if (aRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active ad not found' }); }
    const ad = aRes.rows[0];
    if (ad.trade_type === 'SELL' && parseFloat(ad.remaining_usd) > 0) {
      await client.query(`UPDATE users SET locked_usd = GREATEST(0, locked_usd - $1), balance_usd = balance_usd + $1 WHERE telegram_id = $2`, [ad.remaining_usd, telegram_id.toString()]);
    }
    await client.query(`UPDATE p2p_ads SET status='CANCELLED', remaining_usd=0 WHERE id=$1`, [ad_id]);
    await client.query('COMMIT');
    invalidateP2PCache();
    res.json({ success: true, message: 'Ad cancelled & escrow unlocked.' });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.post('/api/p2p/trades/create', async (req, res) => {
  const { user_id, buyer_id, ad_id, amount_usdt, payment_method, receive_mode, receiving_id, seller_payout_account } = req.body;
  const actorId = String(user_id || buyer_id || '');
  if (!actorId || !ad_id || !amount_usdt) return res.status(400).json({ error: 'Missing trade parameters' });

  const client = await pool.connect();
  try {
    const cfg = await getSystemConfig();
    const uRes = await client.query('SELECT kyc_status, is_banned FROM users WHERE telegram_id = $1', [actorId]);
    if (uRes.rows[0]?.is_banned === 1) return res.status(403).json({ error: 'Banned' });
    if (!uRes.rows[0] || uRes.rows[0].kyc_status !== 'Approved') return res.status(403).json({ error: 'KYC verification required.' });

    await client.query('BEGIN');
    const calc = calcOrder(parseFloat(amount_usdt), 0, cfg.p2p_fee_percent);
    const adRes = await client.query(`UPDATE p2p_ads SET remaining_usd = remaining_usd - $1 WHERE id=$2 AND status='ACTIVE' AND remaining_usd >= $1 RETURNING *`, [calc.gross, ad_id]);
    if (adRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ad unavailable or insufficient USDT.' }); }
    const ad = adRes.rows[0];
    if (String(ad.creator_id) === actorId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot trade on your own ad.' }); }

    let finalBuyerId, finalSellerId, sellerPayoutStr;
    if (ad.trade_type === 'BUY') {
      if (!seller_payout_account) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter your CBE/Telebirr account.' }); }
      const lockSell = await client.query(`UPDATE users SET balance_usd = balance_usd - $1, locked_usd = locked_usd + $1 WHERE telegram_id = $2 AND balance_usd >= $1`, [calc.gross, actorId]);
      if (lockSell.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient Vault balance.' }); }
      finalSellerId = actorId; finalBuyerId = ad.creator_id;
      sellerPayoutStr = `${payment_method || 'Telebirr/CBE'}: ${seller_payout_account}`;
    } else {
      finalBuyerId = actorId; finalSellerId = ad.creator_id;
      sellerPayoutStr = ad.seller_payout_account ? `${ad.seller_payout_method || ''}: ${ad.seller_payout_account}` : null;
    }

    const finalCalc = calcOrder(calc.gross, parseFloat(ad.price_etb), cfg.p2p_fee_percent);
    const sellerPayoutEtb = Math.round(finalCalc.net * parseFloat(ad.price_etb) * 100) / 100;
    const tradeCode = 'P2P-' + Math.floor(100000 + Math.random() * 900000);
    const tradeRes = await client.query(
      `INSERT INTO p2p_trades (trade_code, ad_id, buyer_id, seller_id, amount_usd, fee_usd, net_usd, amount_etb, seller_payout_etb, price_rate, payment_method, receive_mode, receiving_id, seller_payout_account, status, expires_at, eat_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING',NOW() + INTERVAL '15 minutes',$15) RETURNING *`,
      [tradeCode, ad.id, finalBuyerId, finalSellerId, finalCalc.gross, finalCalc.fee, finalCalc.net, finalCalc.etbTotal, sellerPayoutEtb, ad.price_etb, payment_method || 'CBE', receive_mode || 'VAULT', receiving_id || 'IN_APP_VAULT', sellerPayoutStr, formatEAT()]
    );
    await client.query('COMMIT');
    invalidateP2PCache();

    // Find Platform Escrow account matching the chosen method so buyer sees EXACTLY where to pay!
    const escrowAcc = findActiveAccount(cfg.accounts, payment_method) || cfg.accounts.find(a => a.pool_type === 'ETB_OWNER') || null;
    res.json({ success: true, trade: tradeRes.rows[0], escrow_account: escrowAcc, server_now: new Date().toISOString(), message: 'Order created! Complete within 15 minutes.' });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.get('/api/p2p/trades/:trade_code', async (req, res) => {
  if (!pool) return res.status(404).json({ error: 'DB offline' });
  const cfg = await getSystemConfig();
  const r = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1', [req.params.trade_code]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  let trade = r.rows[0];
  if (trade.status === 'PENDING' && trade.expires_at && new Date(trade.expires_at) < new Date()) {
    const up = await pool.query(`UPDATE p2p_trades SET status='EXPIRED' WHERE trade_code=$1 AND status='PENDING' RETURNING *`, [trade.trade_code]);
    if (up.rowCount > 0) {
      trade = up.rows[0];
      const adCheck = await pool.query(`SELECT trade_type FROM p2p_ads WHERE id=$1`, [trade.ad_id]);
      if (adCheck.rows[0]?.trade_type === 'BUY' && !String(trade.seller_id).startsWith('SYSTEM_')) {
        await pool.query(`UPDATE users SET locked_usd=GREATEST(0,locked_usd-$1), balance_usd=balance_usd+$1 WHERE telegram_id=$2`, [trade.amount_usd, trade.seller_id]);
      }
      await pool.query(`UPDATE p2p_ads SET remaining_usd=remaining_usd+$1 WHERE id=$2`, [trade.amount_usd, trade.ad_id]);
      invalidateP2PCache();
    }
  }
  const escrowAcc = findActiveAccount(cfg.accounts, trade.payment_method) || cfg.accounts.find(a => a.pool_type === 'ETB_OWNER') || null;
  res.json({ trade, escrow_account: escrowAcc, server_now: new Date().toISOString() });
});

app.post('/api/p2p/trades/mark-paid', async (req, res) => {
  const { trade_code, payment_ref, screenshot_base64 } = req.body;
  if (!trade_code || !payment_ref) return res.status(400).json({ error: 'Trade code & TxID required' });
  try {
    const tRes = await pool.query('SELECT * FROM p2p_trades WHERE trade_code = $1', [trade_code]);
    if (!tRes.rows[0]) return res.status(404).json({ error: 'Trade not found' });
    const trade = tRes.rows[0];
    if (trade.status !== 'PENDING') return res.status(400).json({ error: `Order is already ${trade.status}.` });
    if (trade.expires_at && new Date(trade.expires_at) < new Date()) {
      await pool.query(`UPDATE p2p_trades SET status='EXPIRED' WHERE trade_code=$1`, [trade_code]);
      await pool.query(`UPDATE p2p_ads SET remaining_usd=remaining_usd+$1 WHERE id=$2`, [trade.amount_usd, trade.ad_id]);
      invalidateP2PCache();
      return res.status(400).json({ error: 'Order expired.' });
    }
    if (await isDuplicateRefAnywhere(payment_ref.trim())) {
      await recordFakeAttempt(trade.buyer_id, `Dup P2P TxID: ${payment_ref}`);
      return res.status(400).json({ error: 'Transaction ID already used!' });
    }
    await pool.query(`UPDATE p2p_trades SET status='VERIFYING', payment_ref=$1 WHERE trade_code=$2`, [payment_ref.trim(), trade_code]);
    const cap = `🤝 <b>P2P PAYMENT PROOF (${trade_code})</b>\n👤 Buyer: <code>${trade.buyer_id}</code>\n💵 Paid: <b>${trade.amount_etb} ETB</b>\n🪙 Net Release: <b>$${trade.net_usd} USDT</b> (1% Fee: $${trade.fee_usd})\n📍 Mode: ${trade.receive_mode} (<code>${escHtml(trade.receiving_id)}</code>)\n🏦 Via: ${escHtml(trade.payment_method)}\n🧾 Ref: <code>${escHtml(payment_ref)}</code>\n💼 Seller Payout: ${escHtml(trade.seller_payout_account || 'System')}\n🕒 ${formatEAT()}`;
    await sendBase64PhotoToGroup(screenshot_base64, cap, { inline_keyboard: [[{ text: '🔓 Release Crypto', callback_data: `p2p_rel:${trade_code}` }, { text: '❌ Reject', callback_data: `p2p_rej:${trade_code}` }]] });
    res.json({ success: true, status: 'VERIFYING', message: 'Proof sent! Tap Refresh Status after verification.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/p2p/trades/cancel', async (req, res) => {
  const { trade_code, telegram_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(`SELECT * FROM p2p_trades WHERE trade_code=$1 AND status='PENDING' FOR UPDATE`, [trade_code]);
    if (!tRes.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only PENDING orders can be cancelled.' }); }
    const trade = tRes.rows[0];
    if (telegram_id && String(trade.buyer_id) !== String(telegram_id) && String(trade.seller_id) !== String(telegram_id)) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not authorized.' });
    }
    await client.query(`UPDATE p2p_trades SET status='CANCELLED' WHERE trade_code=$1`, [trade_code]);
    const adCheck = await client.query(`SELECT trade_type FROM p2p_ads WHERE id=$1`, [trade.ad_id]);
    if (adCheck.rows[0]?.trade_type === 'BUY' && !String(trade.seller_id).startsWith('SYSTEM_')) {
      await client.query(`UPDATE users SET locked_usd=GREATEST(0,locked_usd-$1), balance_usd=balance_usd+$1 WHERE telegram_id=$2`, [trade.amount_usd, trade.seller_id]);
    }
    await client.query(`UPDATE p2p_ads SET remaining_usd=remaining_usd+$1 WHERE id=$2`, [trade.amount_usd, trade.ad_id]);
    await client.query('COMMIT');
    invalidateP2PCache();
    res.json({ success: true, message: 'Order cancelled & liquidity restored.' });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.post('/api/p2p/trades/dispute', async (req, res) => {
  const { trade_code, reason } = req.body;
  await pool.query(`UPDATE p2p_trades SET status='DISPUTED' WHERE trade_code=$1`, [trade_code]);
  notifyAdminGroup(`⚠️ <b>P2P DISPUTE (${escHtml(trade_code)})</b>\nReason: ${escHtml(reason || 'User disputed')}\n🕒 ${formatEAT()}`, {
    inline_keyboard: [[{ text: '🔓 Release Crypto', callback_data: `p2p_rel:${trade_code}` }, { text: '❌ Reject & Cancel', callback_data: `p2p_rej:${trade_code}` }]]
  });
  res.json({ success: true, message: 'Dispute opened.' });
});

app.post('/api/p2p/trades/rate', async (req, res) => {
  const { trade_code, buyer_id, rating } = req.body;
  const r = Math.min(5, Math.max(1, parseInt(rating) || 5));
  await pool.query(`UPDATE p2p_trades SET buyer_rating=$1 WHERE trade_code=$2 AND buyer_id=$3 AND status='RELEASED'`, [r, trade_code, String(buyer_id)]);
  invalidateP2PCache();
  res.json({ success: true, message: `Rated ${r} ★! Thank you.` });
});

// ═════════════════════ 13. ADMIN APIS ═════════════════════
app.get('/api/admin/accounts', auth, async (req, res) => {
  const rows = await pool.query('SELECT * FROM payment_accounts ORDER BY sort_order ASC, id ASC');
  res.json(rows.rows);
});
app.post('/api/admin/accounts/add', auth, async (req, res) => {
  const { key_slug, pool_type, currency_group, label, account_value, account_holder, network_type, is_active } = req.body;
  await pool.query(`INSERT INTO payment_accounts (key_slug, pool_type, currency_group, label, account_value, account_holder, network_type, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [key_slug, pool_type||'USD_NBIYU', currency_group||'CRYPTO', label, account_value||'', account_holder||'', network_type||'EXCHANGE_ID', is_active!==false]);
  invalidateConfigCache();
  res.json({ success: true, message: 'Account added!' });
});
app.post('/api/admin/accounts/update', auth, async (req, res) => {
  const { id, label, account_value, account_holder, is_active } = req.body;
  await pool.query(`UPDATE payment_accounts SET label=COALESCE($1,label), account_value=COALESCE($2,account_value), account_holder=COALESCE($3,account_holder), is_active=COALESCE($4,is_active) WHERE id=$5`, [label, account_value, account_holder, is_active, id]);
  invalidateConfigCache();
  res.json({ success: true, message: 'Account updated!' });
});
app.post('/api/admin/accounts/delete', auth, async (req, res) => {
  await pool.query('DELETE FROM payment_accounts WHERE id = $1', [req.body.id]);
  invalidateConfigCache();
  res.json({ success: true, message: 'Account deleted!' });
});

app.get('/api/admin/analytics', auth, async (req, res) => {
  const cfg = await getSystemConfig();
  const [usersStat, etbIn, etbOut, nbiyuIn, nbiyuOut, nbiyuByChan, pendingCnts] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total_users, COUNT(*) FILTER (WHERE kyc_status='Approved') AS verified_users, COUNT(*) FILTER (WHERE kyc_status='Pending') AS pending_kycs, COUNT(*) FILTER (WHERE is_banned=1) AS banned_users, COALESCE(SUM(balance_usd),0) AS total_user_vault_usd FROM users`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total_etb FROM deposits WHERE pool_target='ETB_OWNER' AND status='APPROVED'`),
    pool.query(`SELECT COALESCE(SUM(amount_etb),0) AS total_etb FROM withdrawals WHERE pool_source='ETB_OWNER' AND status='COMPLETED'`),
    pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total_in FROM nbiyu_ledger WHERE direction='IN'`),
    pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total_out FROM nbiyu_ledger WHERE direction='OUT'`),
    pool.query(`SELECT channel, COALESCE(SUM(CASE WHEN direction='IN' THEN amount_usd ELSE 0 END),0) AS in_usd, COALESCE(SUM(CASE WHEN direction='OUT' THEN amount_usd ELSE 0 END),0) AS out_usd, COUNT(*) AS tx_count FROM nbiyu_ledger GROUP BY channel ORDER BY in_usd DESC`),
    pool.query(`SELECT (SELECT COUNT(*) FROM deposits WHERE status='PENDING') AS pending_deposits, (SELECT COUNT(*) FROM store_orders WHERE status='PENDING') AS pending_store, (SELECT COUNT(*) FROM withdrawals WHERE status='PENDING') AS pending_withdrawals, (SELECT COUNT(*) FROM p2p_trades WHERE status IN ('PENDING','PAID','VERIFYING','DISPUTED')) AS active_p2p_trades, (SELECT COUNT(*) FROM p2p_trades WHERE seller_payout_status='PENDING_PAYOUT') AS pending_seller_payouts`)
  ]);
  const nIn = parseFloat(nbiyuIn.rows[0].total_in), nOut = parseFloat(nbiyuOut.rows[0].total_out);
  const eIn = parseFloat(etbIn.rows[0].total_etb), eOut = parseFloat(etbOut.rows[0].total_etb);
  res.json({ fx_rate: cfg.fx_rate, users: usersStat.rows[0], etb_owner_pool: { total_in_etb: eIn, total_out_etb: eOut, net_held_etb: eIn - eOut }, nbiyu_dollar_pool: { total_in_usd: nIn, total_out_usd: nOut, net_held_usd: Math.round((nIn - nOut)*100)/100, by_channel: nbiyuByChan.rows }, pending: pendingCnts.rows[0] });
});
app.get('/api/admin/nbiyu-ledger', auth, async (req, res) => { res.json((await pool.query('SELECT * FROM nbiyu_ledger ORDER BY id DESC LIMIT 150')).rows); });
app.get('/api/admin/pending', auth, async (req, res) => {
  const [deps, stores, withs, kycs, trades, payouts] = await Promise.all([
    pool.query(`SELECT * FROM deposits WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT * FROM store_orders WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT * FROM withdrawals WHERE status='PENDING' ORDER BY id DESC`),
    pool.query(`SELECT telegram_id, first_name, username, phone_number, kyc_full_name, national_id, created_at FROM users WHERE kyc_status='Pending' ORDER BY id DESC`),
    pool.query(`SELECT * FROM p2p_trades WHERE status IN ('PENDING','PAID','VERIFYING','DISPUTED') ORDER BY id DESC`),
    pool.query(`SELECT * FROM p2p_trades WHERE status='RELEASED' AND seller_payout_status='PENDING_PAYOUT' ORDER BY id DESC`)
  ]);
  res.json({ pending_deposits: deps.rows, pending_store_orders: stores.rows, pending_withdrawals: withs.rows, pending_kycs: kycs.rows, active_p2p_trades: trades.rows, pending_seller_payouts: payouts.rows });
});
app.get('/api/admin/users', auth, async (req, res) => {
  const q = req.query.q ? `%${req.query.q.trim()}%` : null;
  const rows = q ? await pool.query(`SELECT * FROM users WHERE telegram_id ILIKE $1 OR first_name ILIKE $1 OR username ILIKE $1 ORDER BY id DESC LIMIT 50`, [q]) : await pool.query(`SELECT * FROM users ORDER BY id DESC LIMIT 50`);
  res.json(rows.rows);
});
app.post('/api/admin/approve-deposit', auth, async (req, res) => { const r = await approveDepositById(req.body.deposit_id, 'ADMIN_PANEL'); r.ok ? res.json({ success: true, message: 'Approved!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/reject-deposit', auth, async (req, res) => { const r = await rejectDepositById(req.body.deposit_id, req.body.reason || 'Rejected', 'ADMIN_PANEL'); r.ok ? res.json({ success: true, message: 'Rejected!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/approve-store', auth, async (req, res) => { const r = await approveStoreOrderById(req.body.order_id, 'ADMIN_PANEL'); r.ok ? res.json({ success: true, message: 'Delivered!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/reject-store', auth, async (req, res) => { const r = await rejectStoreOrderById(req.body.order_id, req.body.reason || 'Rejected', 'ADMIN_PANEL'); r.ok ? res.json({ success: true, message: 'Rejected!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/approve-withdrawal', auth, async (req, res) => { const r = await approveWithdrawalById(req.body.withdrawal_id, req.body.payout_ref, 'ADMIN_PANEL'); r.ok ? res.json({ success: true, message: 'Paid!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/reject-withdrawal', auth, async (req, res) => { const r = await rejectWithdrawalById(req.body.withdrawal_id, req.body.reason || 'Rejected'); r.ok ? res.json({ success: true, message: 'Refunded!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/kyc/review', auth, async (req, res) => { await reviewKycByUserId(req.body.telegram_id, req.body.decision, req.body.reason); res.json({ success: true, message: `KYC ${req.body.decision}` }); });
app.post('/api/admin/p2p/release', auth, async (req, res) => { const r = await releaseP2PTradeByCode(req.body.trade_code); r.ok ? res.json({ success: true, message: 'Released!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/p2p/reject', auth, async (req, res) => { const r = await rejectP2PTradeByCode(req.body.trade_code, req.body.reason || 'Rejected'); r.ok ? res.json({ success: true, message: 'Rejected!' }) : res.status(400).json({ error: r.error }); });
app.post('/api/admin/p2p/mark-seller-paid', auth, async (req, res) => { await pool.query(`UPDATE p2p_trades SET seller_payout_status='PAID' WHERE trade_code=$1`, [req.body.trade_code]); res.json({ success: true, message: 'Seller marked PAID!' }); });
app.post('/api/admin/set-rate', auth, async (req, res) => {
  const newRate = parseFloat(req.body.rate);
  if (!newRate || newRate <= 0) return res.status(400).json({ error: 'Valid rate required' });
  await pool.query(`INSERT INTO system_settings (key, value) VALUES ('fx_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [newRate.toString()]);
  invalidateConfigCache();
  notifyAdminGroup(`⚙️ <b>Dollar Rate:</b> 1 USD = <b>${newRate} ETB</b>`);
  res.json({ success: true, message: `Rate updated to ${newRate} ETB` });
});
app.post('/api/admin/adjust-balance', auth, async (req, res) => {
  const { telegram_id, amount_usd, action, reason } = req.body;
  const amt = parseFloat(amount_usd), op = action === 'DEDUCT' ? '-' : '+';
  const up = await pool.query(`UPDATE users SET balance_usd = balance_usd ${op} $1 WHERE telegram_id = $2 RETURNING balance_usd`, [amt, String(telegram_id)]);
  if (up.rowCount === 0) return res.status(404).json({ error: 'User not found' });
  await pool.query(`INSERT INTO transactions (telegram_id, type, amount_usd, details) VALUES ($1,'ADMIN_ADJUST',$2,$3)`, [String(telegram_id), amt, reason || 'Admin adjust']);
  res.json({ success: true, new_balance_usd: parseFloat(up.rows[0].balance_usd) });
});
app.post('/api/admin/ban-user', auth, async (req, res) => {
  await pool.query(`UPDATE users SET is_banned = $1, fake_attempts = 0 WHERE telegram_id = $2`, [req.body.banned ? 1 : 0, String(req.body.telegram_id)]);
  res.json({ success: true, message: req.body.banned ? 'Banned.' : 'Unbanned.' });
});

// ═════════════════════ 14. SWAP BROADCAST ENGINE (100% INTACT) ═════════════════════
let broadcastJob = { running: false, paused: false, stop: false, sent: 0, failed: 0, total: 0, startedAt: null, log: [] };
function personalise(text, username) { const name = (username && username !== 'None' && username !== 'undefined' && username.trim() !== '') ? username.trim() : 'ተጠቃሚ'; return text.replace(/\{username\}/gi, name); }
function mdToHtml(text) { return text.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>').replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>'); }
async function sendBroadcastMsg(uid, rawText, username, photo, replyMarkup) {
  const htmlText = mdToHtml(personalise(rawText, username));
  if (photo) {
    try {
      const body = { chat_id: uid, photo, caption: htmlText, parse_mode: 'HTML' }; if (replyMarkup) body.reply_markup = replyMarkup;
      const d = await (await fetch(`${TG_BC_API}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (d.ok) return { success: true }; if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    } catch (_) {}
  }
  try {
    const body = { chat_id: uid, text: htmlText, parse_mode: 'HTML' }; if (replyMarkup) body.reply_markup = replyMarkup;
    const d = await (await fetch(`${TG_BC_API}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (d.ok) return { success: true }; if (d.error_code === 429) return { rateLimited: true, wait: (d.parameters?.retry_after || 3) + 1 };
    return { success: false, reason: d.description };
  } catch (e) { return { success: false, reason: e.message }; }
}
async function runBroadcast(users, text, photo, replyMarkup) {
  broadcastJob = { running: true, paused: false, stop: false, sent: 0, failed: 0, total: users.length, startedAt: new Date().toISOString(), log: [] };
  for (let i = 0; i < users.length; i++) {
    if (broadcastJob.stop) { appendLog('⏹️ Stopped at ' + i); break; }
    while (broadcastJob.paused) { await sleep(1000); if (broadcastJob.stop) break; }
    if (broadcastJob.stop) break;
    const { userId, username } = users[i];
    const r = await sendBroadcastMsg(userId, text, username || '', photo, replyMarkup);
    if (r.rateLimited) { appendLog('⚠️ Rate limited ' + r.wait + 's'); await sleep(r.wait * 1000); i--; continue; }
    if (r.success) broadcastJob.sent++; else { broadcastJob.failed++; appendLog('❌ ' + userId + ': ' + (r.reason || 'unknown')); }
    await sleep(35);
  }
  broadcastJob.running = false; appendLog('✅ Done — Sent: ' + broadcastJob.sent + ' | Failed: ' + broadcastJob.failed);
}
function appendLog(msg) { broadcastJob.log.push(msg); if (broadcastJob.log.length > 150) broadcastJob.log.shift(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchUsers() {
  if (!SHEET_URL) throw new Error('SHEET_URL not set');
  const res = await fetch(SHEET_URL); if (!res.ok) throw new Error('Sheet HTTP ' + res.status);
  const csv = await res.text();
  if (csv.trim().startsWith('<!DOCTYPE') || csv.includes('<html') || csv.includes('<script')) throw new Error('SHEET_URL returned HTML instead of CSV.');
  const lines = csv.trim().split('\n'); if (lines.length < 2) throw new Error('Sheet empty');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  let uidCol = headers.findIndex(h => ['_id','userid','user_id','chat_id','telegramid','telegram_id'].includes(h) || h.includes('userid') || h.includes('user_id'));
  if (uidCol === -1) uidCol = 0;
  let unameCol = headers.findIndex(h => ['username','user_name','name'].includes(h) || h.includes('username'));
  const users = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const uid = (cols[uidCol] || '').trim();
    if (uid && /^\d+$/.test(uid)) users.push({ userId: uid, username: unameCol >= 0 ? (cols[unameCol] || '').trim() : '' });
  }
  return users;
}

app.get('/status', async (req, res) => {
  const cfg = await getSystemConfig();
  res.json({ server: 'Unified Binance ET Vault + Nbiyu Ledger + Swap Broadcast ✅', fx_rate: `1 USD = ${cfg.fx_rate} ETB`, app_bot: BINANCE_BOT_TOKEN ? '✅' : '❌', broadcast_bot: BROADCAST_BOT_TOKEN ? '✅' : '❌', broadcast: broadcastJob.running ? `🔄 ${broadcastJob.sent}/${broadcastJob.total}` : '⏹️ Idle' });
});
app.post('/broadcast/start', auth, async (req, res) => {
  if (broadcastJob.running) return res.status(409).json({ error: 'Broadcast already running.' });
  const { text, photo, btnText, btnUrl, users: usersPayload, user_ids } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const replyMarkup = (btnText && btnUrl && btnUrl.startsWith('http')) ? { inline_keyboard: [[{ text: btnText, url: btnUrl }]] } : null;
  let users;
  if (Array.isArray(usersPayload) && usersPayload.length > 0) users = usersPayload.map(u => ({ userId: String(u.userId||u.id||''), username: u.username||u.name||'' })).filter(u => u.userId);
  else if (Array.isArray(user_ids) && user_ids.length > 0) users = user_ids.map(id => ({ userId: String(id), username: '' }));
  else { try { users = await fetchUsers(); } catch (e) { return res.status(500).json({ error: e.message }); } }
  runBroadcast(users, text, photo || '', replyMarkup);
  res.json({ ok: true, message: 'Broadcast started', total: users.length });
});
app.post('/broadcast/pause', auth, (req, res) => { broadcastJob.paused = true; res.json({ ok: true, message: 'Paused' }); });
app.post('/broadcast/resume', auth, (req, res) => { broadcastJob.paused = false; res.json({ ok: true, message: 'Resumed' }); });
app.post('/broadcast/stop', auth, (req, res) => { broadcastJob.stop = true; broadcastJob.running = false; broadcastJob.paused = false; res.json({ ok: true, message: 'Stopped' }); });
app.get('/broadcast/status', auth, (req, res) => res.json({ running: broadcastJob.running, paused: broadcastJob.paused, sent: broadcastJob.sent, failed: broadcastJob.failed, total: broadcastJob.total, pct: broadcastJob.total ? Math.round((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total * 100) : 0, startedAt: broadcastJob.startedAt, lastLog: broadcastJob.log.slice(-4) }));

// ═════════════════════ 15. START & WEBHOOK ═════════════════════
process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Unhandled:', r));
app.listen(PORT, HOST, () => {
  console.log(`🚀 Unified Server on http://${HOST}:${PORT}`);
  initDB();
  if (BINANCE_BOT_TOKEN && PUBLIC_SERVER_URL) {
    tgCall('setWebhook', { url: `${PUBLIC_SERVER_URL}/api/telegram/webhook`, allowed_updates: ['message', 'callback_query'] })
      .then(d => console.log('🔗 Webhook:', d?.ok ? '✅ Active' : d?.description));
  }
});

