const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';

// Persistent SQLite path: honors SQLITE_DATA_DIR or /data if mounted, otherwise local dir
const resolvedDataDir = (() => {
  if (process.env.SQLITE_DATA_DIR) {
    return path.resolve(process.env.SQLITE_DATA_DIR);
  }
  if (fs.existsSync('/data')) {
    return '/data';
  }
  return __dirname;
})();

fs.mkdirSync(resolvedDataDir, { recursive: true });
const DB_PATH = path.join(resolvedDataDir, 'aurex_vault.sqlite');
const LEGACY_DB_PATH = path.join(__dirname, 'aurex_vault.sqlite');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let db = null;
let SQL = null;

const VIP_PLANS = [
  { level: 1, name: 'VIP 1', amount: 10, days: 20, daily_return: 0.85, min_invites: 0 },
  { level: 2, name: 'VIP 2', amount: 25, days: 20, daily_return: 2.25, min_invites: 0 },
  { level: 3, name: 'VIP 3', amount: 50, days: 20, daily_return: 4.75, min_invites: 0 },
  { level: 4, name: 'VIP 4', amount: 100, days: 20, daily_return: 10.0, min_invites: 0 },
  { level: 5, name: 'VIP 5', amount: 250, days: 25, daily_return: 26.5, min_invites: 0 },
  { level: 6, name: 'VIP 6', amount: 500, days: 30, daily_return: 58.0, min_invites: 3 },
  { level: 7, name: 'VIP 7', amount: 1000, days: 30, daily_return: 122.0, min_invites: 3 },
  { level: 8, name: 'VIP 8', amount: 2500, days: 30, daily_return: 320.0, min_invites: 3 },
  { level: 9, name: 'VIP 9', amount: 5000, days: 30, daily_return: 680.0, min_invites: 3 }
];

// Strictly <= $1.00 rewards as configured
const SPIN_PRIZES = [0.20, 0.30, 0.50, 0.70];
const CHANNEL_JOIN_REWARD = 0.50;

function normalizePhone(rawPhone, dialCode = '') {
  const cleanDial = String(dialCode || '').replace(/[^\d+]/g, '').trim();
  const digitsOnly = String(rawPhone || '').replace(/\D/g, '').trim();
  if (!digitsOnly) return '';
  if (cleanDial) {
    const dialDigits = cleanDial.replace(/\D/g, '');
    const stripped = digitsOnly.startsWith(dialDigits)
      ? digitsOnly.slice(dialDigits.length)
      : digitsOnly.replace(/^0+/, '');
    return `+${dialDigits}${stripped}`;
  }
  return String(rawPhone || '').startsWith('+') ? `+${digitsOnly}` : digitsOnly;
}

function hashPassword(password, salt = null) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), actualSalt, 64).toString('hex');
  return `${actualSalt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    return storedHash === String(password);
  }
  const [salt, expectedHex] = storedHash.split(':');
  const actualBuf = crypto.scryptSync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function saveDb() {
  if (!db) return;
  const binary = db.export();
  const buffer = Buffer.from(binary);
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, DB_PATH);
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function execSql(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function ensureUserColumns() {
  const cols = queryAll('PRAGMA table_info(users)').map((c) => c.name);
  if (!cols.includes('pending_spin_reward')) {
    db.run('ALTER TABLE users ADD COLUMN pending_spin_reward REAL NOT NULL DEFAULT 0');
  }
  if (!cols.includes('channel_reward_claimed')) {
    db.run('ALTER TABLE users ADD COLUMN channel_reward_claimed INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('telegram_username')) {
    db.run('ALTER TABLE users ADD COLUMN telegram_username TEXT');
  }
  saveDb();
}

function insertNewUser({
  userUid,
  refCode,
  fullName,
  phone,
  passwordHash,
  referredByUid,
  dialCode,
  countryCode,
  countryFlag,
  nowIso
}) {
  const tableInfo = queryAll('PRAGMA table_info(users)');
  const columnMap = {
    user_uid: userUid,
    ref_code: refCode,
    full_name: fullName,
    phone,
    password_hash: passwordHash,
    referred_by_uid: referredByUid,
    dial_code: dialCode || '+92',
    country_code: countryCode || 'PK',
    country_flag: countryFlag || '🇵🇰',
    balance: 0,
    pending_spin_reward: 0,
    team_rebate: 0,
    vip_level: 0,
    active_invites: 0,
    spins_left: 2,
    first_deposit_done: 0,
    channel_reward_claimed: 0,
    telegram_username: null,
    created_at: nowIso
  };

  const colsToInsert = [];
  const params = [];

  for (const col of tableInfo) {
    if (col.name === 'id') continue;
    if (Object.prototype.hasOwnProperty.call(columnMap, col.name)) {
      colsToInsert.push(col.name);
      params.push(columnMap[col.name]);
    } else if (col.notnull === 1 && col.dflt_value === null) {
      colsToInsert.push(col.name);
      params.push('');
    }
  }

  const placeholders = colsToInsert.map(() => '?').join(', ');
  execSql(
    `INSERT INTO users (${colsToInsert.join(', ')}) VALUES (${placeholders})`,
    params
  );
}

function hasActiveVipPlan(userId, nowIso = new Date().toISOString()) {
  const row = queryOne(
    `SELECT id FROM vip_subscriptions
     WHERE user_id = ? AND status = 'active' AND expires_at > ?
     ORDER BY id DESC LIMIT 1`,
    [userId, nowIso]
  );
  return Boolean(row);
}

function generateUnique7DigitUid() {
  for (let i = 0; i < 1000; i++) {
    const uid = String(crypto.randomInt(1000000, 9999999));
    const existing = queryOne('SELECT id FROM users WHERE user_uid = ? OR ref_code = ?', [uid, uid]);
    if (!existing) return uid;
  }
  throw new Error('Unable to generate unique 7-digit user ID');
}

function generateOrderCode() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return `ORD-${yyyy}${mm}${dd}-${rand}`;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSetting(key, fallback = '') {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  execSql(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

function sanitizeUser(userRow) {
  if (!userRow) return null;
  const { password_hash, ...safe } = userRow;
  return {
    ...safe,
    balance: Number(Number(safe.balance || 0).toFixed(2)),
    pending_spin_reward: Number(Number(safe.pending_spin_reward || 0).toFixed(2)),
    team_rebate: Number(Number(safe.team_rebate || 0).toFixed(2)),
    vip_level: Number(safe.vip_level || 0),
    active_invites: Number(safe.active_invites || 0),
    spins_left: Number(safe.spins_left || 0),
    first_deposit_done: Number(safe.first_deposit_done || 0),
    channel_reward_claimed: Number(safe.channel_reward_claimed || 0),
    has_active_plan: hasActiveVipPlan(safe.id)
  };
}

function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  const session = queryOne('SELECT user_id FROM sessions WHERE token = ?', [token]);
  if (!session) return null;
  return queryOne('SELECT * FROM users WHERE id = ?', [session.user_id]);
}

function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Invalid admin secret' });
  }
  next();
}

async function initDatabase() {
  SQL = await initSqlJs();

  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uid TEXT UNIQUE NOT NULL,
      ref_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      referred_by_uid TEXT,
      balance REAL NOT NULL DEFAULT 0,
      pending_spin_reward REAL NOT NULL DEFAULT 0,
      team_rebate REAL NOT NULL DEFAULT 0,
      vip_level INTEGER NOT NULL DEFAULT 0,
      active_invites INTEGER NOT NULL DEFAULT 0,
      spins_left INTEGER NOT NULL DEFAULT 2,
      first_deposit_done INTEGER NOT NULL DEFAULT 0,
      channel_reward_claimed INTEGER NOT NULL DEFAULT 0,
      telegram_username TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vip_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_uid TEXT NOT NULL,
      vip_level INTEGER NOT NULL,
      amount REAL NOT NULL,
      days INTEGER NOT NULL,
      daily_return REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      user_uid TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      network TEXT,
      wallet_address TEXT,
      proof_data TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_uid TEXT NOT NULL,
      reward REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_uid TEXT NOT NULL,
      sender TEXT NOT NULL,
      message_text TEXT,
      media_type TEXT,
      media_data TEXT,
      created_at TEXT NOT NULL
    );
  `);

  ensureUserColumns();

  const existingUsers = queryAll('SELECT id, phone FROM users');
  for (const row of existingUsers) {
    const clean = normalizePhone(row.phone);
    if (clean && clean !== row.phone) {
      const conflict = queryOne('SELECT id FROM users WHERE phone = ? AND id != ?', [clean, row.id]);
      if (!conflict) {
        db.run('UPDATE users SET phone = ? WHERE id = ?', [clean, row.id]);
      }
    }
  }

  const defaultSettings = {
    trc20_wallet: 'T9yD14Nj9j7xAB41GeiX9h2kQ8pL5mN2vR',
    bep20_wallet: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    telegram_channel: 'https://t.me/AurexVaultOfficial',
    telegram_support: 'https://t.me/AurexVaultSupport'
  };
  for (const [key, val] of Object.entries(defaultSettings)) {
    const existing = queryOne('SELECT key FROM settings WHERE key = ?', [key]);
    if (!existing) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, val]);
    }
  }

  saveDb();
}

// Auth Endpoints (accepts both snake_case and camelCase payloads)
app.post('/api/auth/register', (req, res) => {
  try {
    const body = req.body || {};
    const fullName = String(body.full_name ?? body.fullName ?? '').trim();
    const dialCode = String(body.dial_code ?? body.dialCode ?? '').trim();
    const countryCode = String(body.country_code ?? body.countryCode ?? 'PK').trim();
    const countryFlag = String(body.country_flag ?? body.countryFlag ?? '🇵🇰').trim();
    const rawPhone = body.phone ?? body.mobile ?? '';
    const phone = normalizePhone(rawPhone, dialCode);
    const password = String(body.password ?? '');
    const refCodeInput = String(body.ref_code ?? body.inviteCode ?? body.invite_code ?? '').trim();

    if (!fullName || !phone || !password) {
      return res.status(400).json({ error: 'Full name, phone number, and password are required.' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
    }

    const existingPhone = queryOne('SELECT id, user_uid FROM users WHERE phone = ?', [phone]);
    if (existingPhone) {
      return res.status(409).json({
        error: 'An account already exists with this phone number. Only one account is allowed per phone number.'
      });
    }

    let referredByUid = null;
    if (refCodeInput) {
      const referrer = queryOne('SELECT user_uid FROM users WHERE user_uid = ? OR ref_code = ?', [
        refCodeInput,
        refCodeInput
      ]);
      if (referrer) {
        referredByUid = referrer.user_uid;
      }
    }

    const userUid = generateUnique7DigitUid();
    const passwordHash = hashPassword(password);
    const nowIso = new Date().toISOString();

    insertNewUser({
      userUid,
      refCode: userUid,
      fullName,
      phone,
      passwordHash,
      referredByUid,
      dialCode,
      countryCode,
      countryFlag,
      nowIso
    });

    const createdUser = queryOne('SELECT * FROM users WHERE user_uid = ?', [userUid]);
    const token = generateToken();
    execSql('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [
      token,
      createdUser.id,
      nowIso
    ]);

    return res.status(201).json({
      token,
      user: sanitizeUser(createdUser),
      orders: [],
      wallets: {
        TRC20: getSetting('trc20_wallet', ''),
        BEP20: getSetting('bep20_wallet', '')
      }
    });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({
        error: 'An account already exists with this phone number. Only one account is allowed per phone number.'
      });
    }
    console.error('Register error:', err);
    return res.status(500).json({
      error: 'Failed to register account.',
      details: err.message
    });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const dialCode = String(body.dial_code ?? body.dialCode ?? '').trim();
    const rawPhone = body.phone ?? body.mobile ?? '';
    const password = String(body.password ?? '');

    if (!String(rawPhone).trim() || !password) {
      return res.status(400).json({ error: 'Phone number and password are required.' });
    }

    const normalizedWithDial = normalizePhone(rawPhone, dialCode);
    const normalizedDirect = normalizePhone(rawPhone);

    const user =
      queryOne('SELECT * FROM users WHERE phone = ?', [normalizedWithDial]) ||
      queryOne('SELECT * FROM users WHERE phone = ?', [normalizedDirect]);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    const token = generateToken();
    const nowIso = new Date().toISOString();
    execSql('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, user.id, nowIso]);

    const orders = queryAll('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [user.id]);

    return res.json({
      token,
      user: sanitizeUser(user),
      orders,
      wallets: {
        TRC20: getSetting('trc20_wallet', ''),
        BEP20: getSetting('bep20_wallet', '')
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Failed to sign in.' });
  }
});

app.get('/api/user/profile', requireAuth, (req, res) => {
  const freshUser = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const subscriptions = queryAll(
    'SELECT * FROM vip_subscriptions WHERE user_id = ? ORDER BY id DESC',
    [req.user.id]
  );
  const orders = queryAll('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
  const spinLogs = queryAll('SELECT * FROM spin_logs WHERE user_id = ? ORDER BY id DESC', [req.user.id]);

  return res.json({
    user: sanitizeUser(freshUser),
    vip_plans: VIP_PLANS,
    subscriptions,
    orders,
    spin_logs: spinLogs,
    wallets: {
      TRC20: getSetting('trc20_wallet', ''),
      BEP20: getSetting('bep20_wallet', '')
    },
    telegram: {
      channel: getSetting('telegram_channel', 'https://t.me/AurexVaultOfficial'),
      support: getSetting('telegram_support', 'https://t.me/AurexVaultSupport'),
      join_reward: CHANNEL_JOIN_REWARD
    }
  });
});

// Telegram Channel Join Reward
app.post('/api/rewards/channel-join', requireAuth, (req, res) => {
  try {
    const rawHandle = String(req.body.telegram_username || req.body.telegramUsername || '').trim();
    const cleanHandle = rawHandle.replace(/^@+/, '');

    if (!cleanHandle || cleanHandle.length < 3) {
      return res.status(400).json({ error: 'Please enter a valid Telegram @username.' });
    }

    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (Number(user.channel_reward_claimed || 0) === 1) {
      return res.status(400).json({ error: 'Channel join reward has already been claimed.' });
    }

    const nextBalance = Number((Number(user.balance || 0) + CHANNEL_JOIN_REWARD).toFixed(2));
    execSql(
      'UPDATE users SET balance = ?, channel_reward_claimed = 1, telegram_username = ? WHERE id = ?',
      [nextBalance, `@${cleanHandle}`, user.id]
    );

    const updatedUser = queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
    return res.json({
      reward: CHANNEL_JOIN_REWARD,
      user: sanitizeUser(updatedUser)
    });
  } catch (err) {
    console.error('Channel join reward error:', err);
    return res.status(500).json({ error: 'Failed to claim channel join reward.' });
  }
});

// VIP Plans & Activation
app.get('/api/vip/plans', requireAuth, (req, res) => {
  const freshUser = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const plansWithStatus = VIP_PLANS.map((plan) => ({
    ...plan,
    unlocked: Number(freshUser.active_invites || 0) >= plan.min_invites
  }));
  return res.json({
    plans: plansWithStatus,
    active_invites: Number(freshUser.active_invites || 0),
    current_vip_level: Number(freshUser.vip_level || 0)
  });
});

app.post('/api/vip/activate', requireAuth, (req, res) => {
  try {
    const level = Number(req.body.vip_level || req.body.level);
    const plan = VIP_PLANS.find((p) => p.level === level);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid VIP plan selected.' });
    }

    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (Number(user.active_invites || 0) < plan.min_invites) {
      return res.status(403).json({
        error: `${plan.name} requires at least ${plan.min_invites} depositing invites.`
      });
    }

    if (Number(user.balance || 0) < plan.amount) {
      return res.status(400).json({
        error: `Insufficient balance. ${plan.name} requires $${plan.amount.toFixed(2)}.`
      });
    }

    const pendingReward = Number(Number(user.pending_spin_reward || 0).toFixed(2));
    const newBalance = Number(
      (Number(user.balance || 0) - plan.amount + pendingReward).toFixed(2)
    );
    const newVipLevel = Math.max(Number(user.vip_level || 0), plan.level);
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000).toISOString();

    execSql('UPDATE users SET balance = ?, pending_spin_reward = 0, vip_level = ? WHERE id = ?', [
      newBalance,
      newVipLevel,
      user.id
    ]);

    execSql(
      `INSERT INTO vip_subscriptions (
        user_id, user_uid, vip_level, amount, days, daily_return, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [user.id, user.user_uid, plan.level, plan.amount, plan.days, plan.daily_return, createdAt, expiresAt]
    );

    const updatedUser = queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
    return res.json({
      message: `${plan.name} activated successfully.`,
      unlocked_spin_reward: pendingReward,
      user: sanitizeUser(updatedUser)
    });
  } catch (err) {
    console.error('VIP activate error:', err);
    return res.status(500).json({ error: 'Failed to activate VIP plan.' });
  }
});

// Deposits & Withdrawals
app.post('/api/orders/deposit', requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const network = String(req.body.network || '').toUpperCase().trim();
    const proofData = String(req.body.proof_data ?? req.body.proofData ?? '').trim();

    if (!Number.isFinite(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum deposit amount is $10.00.' });
    }

    if (network !== 'TRC20' && network !== 'BEP20') {
      return res.status(400).json({ error: 'Please select a valid network (TRC20 or BEP20).' });
    }

    if (!proofData || !proofData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Payment screenshot image is required.' });
    }

    const walletAddress =
      network === 'TRC20' ? getSetting('trc20_wallet', '') : getSetting('bep20_wallet', '');
    const orderCode = generateOrderCode();
    const nowIso = new Date().toISOString();

    execSql(
      `INSERT INTO orders (
        order_code, user_id, user_uid, type, amount, network, wallet_address, proof_data, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'deposit', ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        orderCode,
        req.user.id,
        req.user.user_uid,
        Number(amount.toFixed(2)),
        network,
        walletAddress,
        proofData,
        nowIso,
        nowIso
      ]
    );

    const order = queryOne('SELECT * FROM orders WHERE order_code = ?', [orderCode]);
    return res.status(201).json({ order });
  } catch (err) {
    console.error('Deposit order error:', err);
    return res.status(500).json({ error: 'Failed to create deposit order.' });
  }
});

app.post('/api/orders/withdraw', requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const network = String(req.body.network || 'TRC20').toUpperCase().trim();
    const walletAddress = String(req.body.wallet_address ?? req.body.address ?? '').trim();

    if (!Number.isFinite(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is $10.00.' });
    }

    if (!walletAddress) {
      return res.status(400).json({ error: 'Destination wallet address is required.' });
    }

    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (Number(user.balance || 0) < amount) {
      return res.status(400).json({ error: 'Insufficient balance for this withdrawal.' });
    }

    const roundedAmount = Number(amount.toFixed(2));
    const newBalance = Number((Number(user.balance || 0) - roundedAmount).toFixed(2));
    const orderCode = generateOrderCode();
    const nowIso = new Date().toISOString();

    execSql('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

    execSql(
      `INSERT INTO orders (
        order_code, user_id, user_uid, type, amount, network, wallet_address, proof_data, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'withdraw', ?, ?, ?, NULL, 'pending', ?, ?)`,
      [orderCode, user.id, user.user_uid, roundedAmount, network, walletAddress, nowIso, nowIso]
    );

    const order = queryOne('SELECT * FROM orders WHERE order_code = ?', [orderCode]);
    const updatedUser = queryOne('SELECT * FROM users WHERE id = ?', [user.id]);

    return res.status(201).json({
      order,
      user: sanitizeUser(updatedUser)
    });
  } catch (err) {
    console.error('Withdraw order error:', err);
    return res.status(500).json({ error: 'Failed to create withdrawal order.' });
  }
});

// Lucky Golden Spin: Depositors only, strictly <= $1.00, credited only with active VIP plan
app.post('/api/spin/play', requireAuth, (req, res) => {
  try {
    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

    if (Number(user.first_deposit_done || 0) !== 1) {
      return res.status(403).json({
        error: 'Lucky Spin sirf depositors ke liye hai. Pehle apna deposit complete karein.'
      });
    }

    if (Number(user.spins_left || 0) <= 0) {
      return res.status(400).json({ error: 'No Lucky Spins remaining.' });
    }

    const idx = crypto.randomInt(0, SPIN_PRIZES.length);
    const reward = Math.min(1.0, Number(SPIN_PRIZES[idx].toFixed(2)));
    const newSpinsLeft = Math.max(0, Number(user.spins_left || 0) - 1);
    const nowIso = new Date().toISOString();
    const activePlan = hasActiveVipPlan(user.id, nowIso);

    if (activePlan) {
      const newBalance = Number((Number(user.balance || 0) + reward).toFixed(2));
      execSql('UPDATE users SET spins_left = ?, balance = ? WHERE id = ?', [
        newSpinsLeft,
        newBalance,
        user.id
      ]);
    } else {
      const nextPending = Number((Number(user.pending_spin_reward || 0) + reward).toFixed(2));
      execSql('UPDATE users SET spins_left = ?, pending_spin_reward = ? WHERE id = ?', [
        newSpinsLeft,
        nextPending,
        user.id
      ]);
    }

    execSql(
      'INSERT INTO spin_logs (user_id, user_uid, reward, created_at) VALUES (?, ?, ?, ?)',
      [user.id, user.user_uid, reward, nowIso]
    );

    const updatedUser = queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
    return res.json({
      reward,
      plan_active: activePlan,
      message: activePlan
        ? `Won $${reward.toFixed(2)} credited to balance!`
        : `Won $${reward.toFixed(2)}. Pehle apna VIP plan active karein — reward active plan ke sath unlock hoga.`,
      user: sanitizeUser(updatedUser)
    });
  } catch (err) {
    console.error('Spin error:', err);
    return res.status(500).json({ error: 'Failed to process Lucky Spin.' });
  }
});

// Customer Live Support Chat
app.get('/api/support/messages', requireAuth, (req, res) => {
  const messages = queryAll(
    'SELECT * FROM support_messages WHERE user_id = ? ORDER BY id ASC',
    [req.user.id]
  );
  return res.json({ messages });
});

app.post('/api/support/messages', requireAuth, (req, res) => {
  try {
    const messageText = String(req.body.message_text ?? req.body.message ?? '').trim();
    const rawMediaType = req.body.media_type ?? req.body.mediaType ?? null;
    const rawMediaData = req.body.media_data ?? req.body.mediaData ?? null;
    const mediaType = rawMediaType && rawMediaType !== 'none' ? String(rawMediaType).trim() : null;
    const mediaData = rawMediaData ? String(rawMediaData).trim() : null;

    if (!messageText && !mediaData) {
      return res.status(400).json({ error: 'Message text or media attachment is required.' });
    }

    if (mediaData && mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'media_type must be image or video.' });
    }

    const nowIso = new Date().toISOString();
    execSql(
      `INSERT INTO support_messages (
        user_id, user_uid, sender, message_text, media_type, media_data, created_at
      ) VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      [
        req.user.id,
        req.user.user_uid,
        messageText || null,
        mediaData ? mediaType : null,
        mediaData || null,
        nowIso
      ]
    );

    const created = queryOne(
      'SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      [req.user.id]
    );
    return res.status(201).json({ message: created });
  } catch (err) {
    console.error('Support message error:', err);
    return res.status(500).json({ error: 'Failed to send support message.' });
  }
});

// Admin Endpoints
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const users = queryAll('SELECT * FROM users ORDER BY id DESC').map(sanitizeUser);
  const orders = queryAll('SELECT * FROM orders ORDER BY id DESC');
  const wallets = {
    TRC20: getSetting('trc20_wallet', ''),
    BEP20: getSetting('bep20_wallet', '')
  };
  const telegram = {
    channel: getSetting('telegram_channel', 'https://t.me/AurexVaultOfficial'),
    support: getSetting('telegram_support', 'https://t.me/AurexVaultSupport')
  };
  return res.json({ users, orders, wallets, telegram });
});

app.post('/api/admin/settings/wallets', requireAdmin, (req, res) => {
  const trc20 = String(req.body.trc20_wallet || '').trim();
  const bep20 = String(req.body.bep20_wallet || '').trim();
  const tgChannel = String(req.body.telegram_channel || '').trim();
  const tgSupport = String(req.body.telegram_support || '').trim();
  if (trc20) setSetting('trc20_wallet', trc20);
  if (bep20) setSetting('bep20_wallet', bep20);
  if (tgChannel) setSetting('telegram_channel', tgChannel);
  if (tgSupport) setSetting('telegram_support', tgSupport);
  return res.json({
    wallets: {
      TRC20: getSetting('trc20_wallet', ''),
      BEP20: getSetting('bep20_wallet', '')
    },
    telegram: {
      channel: getSetting('telegram_channel', 'https://t.me/AurexVaultOfficial'),
      support: getSetting('telegram_support', 'https://t.me/AurexVaultSupport')
    }
  });
});

app.post('/api/admin/orders/:orderId/action', requireAdmin, (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const action = String(req.body.action || '').toLowerCase().trim();

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve or reject.' });
    }

    const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order is already ${order.status}.` });
    }

    const user = queryOne('SELECT * FROM users WHERE id = ?', [order.user_id]);
    if (!user) {
      return res.status(404).json({ error: 'Order user not found.' });
    }

    const nowIso = new Date().toISOString();
    const orderAmount = Number(order.amount || 0);

    if (order.type === 'deposit') {
      if (action === 'approve') {
        const nextBalance = Number((Number(user.balance || 0) + orderAmount).toFixed(2));
        const isFirstDeposit = Number(user.first_deposit_done || 0) === 0;

        execSql('UPDATE users SET balance = ?, first_deposit_done = 1 WHERE id = ?', [
          nextBalance,
          user.id
        ]);

        if (isFirstDeposit && user.referred_by_uid) {
          const sponsor = queryOne('SELECT * FROM users WHERE user_uid = ?', [user.referred_by_uid]);
          if (sponsor) {
            const rebate = Number((orderAmount * 0.12).toFixed(2));
            const sponsorBalance = Number((Number(sponsor.balance || 0) + rebate).toFixed(2));
            const sponsorRebate = Number((Number(sponsor.team_rebate || 0) + rebate).toFixed(2));
            const sponsorInvites = Number(sponsor.active_invites || 0) + 1;
            const sponsorSpins = Number(sponsor.spins_left || 0) + 1;

            execSql(
              `UPDATE users
               SET balance = ?, team_rebate = ?, active_invites = ?, spins_left = ?
               WHERE id = ?`,
              [sponsorBalance, sponsorRebate, sponsorInvites, sponsorSpins, sponsor.id]
            );
          }
        }

        execSql('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
          'approved',
          nowIso,
          order.id
        ]);
      } else {
        execSql('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
          'rejected',
          nowIso,
          order.id
        ]);
      }
    } else if (order.type === 'withdraw') {
      if (action === 'approve') {
        execSql('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
          'approved',
          nowIso,
          order.id
        ]);
      } else {
        const refundedBalance = Number((Number(user.balance || 0) + orderAmount).toFixed(2));
        execSql('UPDATE users SET balance = ? WHERE id = ?', [refundedBalance, user.id]);
        execSql('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
          'rejected',
          nowIso,
          order.id
        ]);
      }
    }

    const updatedOrder = queryOne('SELECT * FROM orders WHERE id = ?', [order.id]);
    return res.json({ order: updatedOrder });
  } catch (err) {
    console.error('Admin order action error:', err);
    return res.status(500).json({ error: 'Failed to process order action.' });
  }
});

app.get('/api/admin/support/threads', requireAdmin, (req, res) => {
  const threads = queryAll(
    `SELECT
       sm.user_id,
       sm.user_uid,
       COALESCE(u.full_name, sm.user_uid) AS full_name,
       COALESCE(u.phone, '') AS phone,
       MAX(sm.id) AS last_msg_id,
       MAX(sm.created_at) AS last_created_at
     FROM support_messages sm
     LEFT JOIN users u ON u.id = sm.user_id
     GROUP BY sm.user_id, sm.user_uid
     ORDER BY last_msg_id DESC`
  );

  const enriched = threads.map((t) => {
    const lastMsg = queryOne('SELECT * FROM support_messages WHERE id = ?', [t.last_msg_id]);
    return {
      ...t,
      last_message: lastMsg ? lastMsg.message_text || `[${lastMsg.media_type}]` : ''
    };
  });

  return res.json({ threads: enriched });
});

app.get('/api/admin/support/messages/:userId', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const messages = queryAll(
    'SELECT * FROM support_messages WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
  return res.json({ messages });
});

app.post('/api/admin/support/messages', requireAdmin, (req, res) => {
  try {
    const userId = Number(req.body.user_id);
    const messageText = String(req.body.message_text ?? req.body.message ?? '').trim();
    const rawMediaType = req.body.media_type ?? req.body.mediaType ?? null;
    const rawMediaData = req.body.media_data ?? req.body.mediaData ?? null;
    const mediaType = rawMediaType && rawMediaType !== 'none' ? String(rawMediaType).trim() : null;
    const mediaData = rawMediaData ? String(rawMediaData).trim() : null;

    const user = queryOne('SELECT id, user_uid FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (!messageText && !mediaData) {
      return res.status(400).json({ error: 'Message text or media attachment is required.' });
    }

    if (mediaData && mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'media_type must be image or video.' });
    }

    const nowIso = new Date().toISOString();
    execSql(
      `INSERT INTO support_messages (
        user_id, user_uid, sender, message_text, media_type, media_data, created_at
      ) VALUES (?, ?, 'admin', ?, ?, ?, ?)`,
      [
        user.id,
        user.user_uid,
        messageText || null,
        mediaData ? mediaType : null,
        mediaData || null,
        nowIso
      ]
    );

    const created = queryOne(
      'SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      [user.id]
    );
    return res.status(201).json({ message: created });
  } catch (err) {
    console.error('Admin support reply error:', err);
    return res.status(500).json({ error: 'Failed to send admin reply.' });
  }
});

// Static Frontend Files
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AUREX VAULT PRO running on port ${PORT} (SQLite: ${DB_PATH})`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });