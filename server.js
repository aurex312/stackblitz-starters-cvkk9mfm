const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';

app.use(cors());
app.use(express.json({ limit: '35mb' }));
app.use(express.static(path.join(__dirname)));

const dbPath = path.join(__dirname, 'aurex_vault.sqlite');
let db = null;

function persistDb() {
  try {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (err) {
    console.error('DB save error:', err.message);
  }
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
  return rows[0] || null;
}

function executeSql(sql, params = []) {
  db.run(sql, params);
  persistDb();
}

function getFormattedDateTime() {
  const now = new Date();
  const datePart = now.toISOString().split('T')[0];
  const timePart = now.toTimeString().split(' ')[0];
  return `${datePart} ${timePart} UTC`;
}

function generateOrderId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${ymd}-${rand}`;
}

function generateUnique7DigitId() {
  for (let i = 0; i < 20; i++) {
    const uid = String(Math.floor(1000000 + Math.random() * 9000000));
    const exists = queryOne(`SELECT id FROM users WHERE user_uid = ?`, [uid]);
    if (!exists) return uid;
  }
  return String(Math.floor(1000000 + Math.random() * 9000000));
}

async function initDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uid TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL DEFAULT 'Global Trader',
      country_code TEXT NOT NULL,
      country_flag TEXT NOT NULL DEFAULT '🇺🇸',
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '123456',
      ref_code TEXT NOT NULL DEFAULT '8829104',
      invited_by TEXT DEFAULT '',
      active_invites INTEGER NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0.00,
      today_yield REAL NOT NULL DEFAULT 0.00,
      team_rebate REAL NOT NULL DEFAULT 0.00,
      vip_level INTEGER NOT NULL DEFAULT 0,
      plan_days_left INTEGER NOT NULL DEFAULT 0,
      spins_left INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      UNIQUE(dial_code, phone)
    )
  `);

  const userCols = queryAll(`PRAGMA table_info(users)`).map((c) => c.name);
  if (!userCols.includes('user_uid')) db.run(`ALTER TABLE users ADD COLUMN user_uid TEXT DEFAULT ''`);
  if (!userCols.includes('full_name')) db.run(`ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT 'Global Trader'`);
  if (!userCols.includes('password')) db.run(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT '123456'`);
  if (!userCols.includes('ref_code')) db.run(`ALTER TABLE users ADD COLUMN ref_code TEXT NOT NULL DEFAULT '8829104'`);
  if (!userCols.includes('invited_by')) db.run(`ALTER TABLE users ADD COLUMN invited_by TEXT DEFAULT ''`);
  if (!userCols.includes('active_invites')) db.run(`ALTER TABLE users ADD COLUMN active_invites INTEGER NOT NULL DEFAULT 0`);
  if (!userCols.includes('plan_days_left')) db.run(`ALTER TABLE users ADD COLUMN plan_days_left INTEGER NOT NULL DEFAULT 0`);
  if (!userCols.includes('spins_left')) db.run(`ALTER TABLE users ADD COLUMN spins_left INTEGER NOT NULL DEFAULT 2`);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_key TEXT NOT NULL,
      user_uid TEXT NOT NULL DEFAULT '0000000',
      country_flag TEXT NOT NULL,
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      order_type TEXT NOT NULL,
      network TEXT NOT NULL,
      amount REAL NOT NULL,
      txid TEXT NOT NULL,
      proof_data TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  const orderCols = queryAll(`PRAGMA table_info(orders)`).map((c) => c.name);
  if (!orderCols.includes('user_uid')) db.run(`ALTER TABLE orders ADD COLUMN user_uid TEXT NOT NULL DEFAULT '0000000'`);
  if (!orderCols.includes('proof_data')) db.run(`ALTER TABLE orders ADD COLUMN proof_data TEXT DEFAULT ''`);

  db.run(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      user_uid TEXT NOT NULL DEFAULT '0000000',
      country_flag TEXT NOT NULL,
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT DEFAULT '',
      media_type TEXT DEFAULT 'none',
      media_data TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  const msgCols = queryAll(`PRAGMA table_info(support_messages)`).map((c) => c.name);
  if (!msgCols.includes('user_uid')) db.run(`ALTER TABLE support_messages ADD COLUMN user_uid TEXT NOT NULL DEFAULT '0000000'`);
  if (!msgCols.includes('media_type')) db.run(`ALTER TABLE support_messages ADD COLUMN media_type TEXT DEFAULT 'none'`);
  if (!msgCols.includes('media_data')) db.run(`ALTER TABLE support_messages ADD COLUMN media_data TEXT DEFAULT ''`);

  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [
    'TRC20',
    'TER4vxuCgwKT4cymyC2NRZgVYnvWn6dFC9'
  ]);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [
    'BEP20',
    '0xe37ab67b88eadcb56c05fe80ebde4ea5786962aa'
  ]);

  persistDb();
}

function getUserSnapshot(dialCode, phone) {
  const userKey = `${dialCode}-${phone}`;
  const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
  if (!user) return null;

  if (!user.user_uid) {
    const uid = generateUnique7DigitId();
    executeSql(`UPDATE users SET user_uid = ?, ref_code = ? WHERE id = ?`, [uid, uid, user.id]);
    user.user_uid = uid;
    user.ref_code = uid;
  }

  const sRows = queryAll(`SELECT key, value FROM settings`);
  const networks = {};
  sRows.forEach((r) => {
    networks[r.key] = r.value;
  });

  const orders = queryAll(
    `SELECT * FROM orders WHERE user_key = ? ORDER BY created_at DESC LIMIT 30`,
    [userKey]
  );

  const safeUser = { ...user };
  delete safeUser.password;

  return { user: safeUser, networks, orders };
}

function verifyAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'];
  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
  }
  next();
}

app.post('/api/auth/register', (req, res) => {
  try {
    const {
      fullName = 'Trader',
      countryCode = 'PK',
      countryFlag = '🇵🇰',
      dialCode = '+92',
      phone,
      password,
      inviteCode = ''
    } = req.body || {};

    const cleanPhone = String(phone || '').trim();
    const cleanPass = String(password || '').trim();
    if (!cleanPhone || cleanPass.length < 4) {
      return res.status(400).json({ error: 'Phone number and password (min 4 chars) required.' });
    }

    const existing = queryOne(`SELECT id FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, cleanPhone]);
    if (existing) {
      return res.status(400).json({ error: 'This number is already registered. Please Sign In.' });
    }

    const userUid = generateUnique7DigitId();
    const createdAt = getFormattedDateTime();

    executeSql(
      `INSERT INTO users (user_uid, full_name, country_code, country_flag, dial_code, phone, password, ref_code, invited_by, active_invites, balance, vip_level, plan_days_left, spins_left, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0.00, 0, 0, 2, ?)`,
      [
        userUid,
        String(fullName).trim() || 'Trader',
        countryCode,
        countryFlag,
        dialCode,
        cleanPhone,
        cleanPass,
        userUid,
        String(inviteCode).trim(),
        createdAt
      ]
    );

    const snapshot = getUserSnapshot(dialCode, cleanPhone);
    res.status(201).json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { dialCode = '+92', phone, password } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    const cleanPass = String(password || '').trim();

    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, cleanPhone]);
    if (!user) {
      return res.status(404).json({ error: 'Account not found. Please Create ID first.' });
    }
    if (user.password !== cleanPass) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const snapshot = getUserSnapshot(dialCode, cleanPhone);
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/session', (req, res) => {
  try {
    const { dialCode, phone } = req.body || {};
    if (!dialCode || !phone) return res.status(400).json({ error: 'Missing credentials' });
    const snapshot = getUserSnapshot(String(dialCode).trim(), String(phone).trim());
    if (!snapshot) return res.status(404).json({ error: 'User not found' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Session sync error' });
  }
});

const PLANS = [
  { level: 1, name: 'VIP 1 • Micro Scalper', price: 10, days: 20, daily: 0.85, requiresInvites: 0 },
  { level: 2, name: 'VIP 2 • Bronze Node', price: 25, days: 20, daily: 2.25, requiresInvites: 0 },
  { level: 3, name: 'VIP 3 • Silver Pulse', price: 50, days: 20, daily: 4.75, requiresInvites: 0 },
  { level: 4, name: 'VIP 4 • Gold Matrix', price: 100, days: 20, daily: 10.00, requiresInvites: 0 },
  { level: 5, name: 'VIP 5 • Platinum Pro', price: 250, days: 25, daily: 26.50, requiresInvites: 0 },
  { level: 6, name: 'VIP 6 • Diamond Syndicate', price: 500, days: 30, daily: 58.00, requiresInvites: 3 },
  { level: 7, name: 'VIP 7 • Emerald Whale', price: 1000, days: 30, daily: 122.00, requiresInvites: 3 },
  { level: 8, name: 'VIP 8 • Sovereign Vault', price: 2500, days: 30, daily: 320.00, requiresInvites: 3 },
  { level: 9, name: 'VIP 9 • Imperial Apex', price: 5000, days: 30, daily: 680.00, requiresInvites: 3 }
];

app.post('/api/plans/activate', (req, res) => {
  try {
    const { dialCode, phone, level } = req.body || {};
    const plan = PLANS.find((p) => p.level === Number(level));
    if (!plan) return res.status(400).json({ error: 'Invalid VIP plan' });

    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (plan.requiresInvites > 0 && (user.active_invites || 0) < plan.requiresInvites) {
      return res.status(403).json({
        error: `Locked! You need ${plan.requiresInvites} active depositing invites (Current: ${user.active_invites || 0}/3).`
      });
    }

    if (user.balance < plan.price) {
      return res.status(400).json({ error: `Insufficient balance ($${plan.price} required). Please deposit first.` });
    }

    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();
    const userKey = `${dialCode}-${phone}`;

    executeSql(
      `UPDATE users SET balance = balance - ?, vip_level = ?, plan_days_left = ? WHERE dial_code = ? AND phone = ?`,
      [plan.price, plan.level, plan.days, dialCode, phone]
    );
    executeSql(
      `INSERT INTO orders (order_id, user_key, user_uid, country_flag, dial_code, phone, order_type, network, amount, txid, proof_data, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PLAN', ?, ?, '', 'Approved', ?, ?)`,
      [orderId, userKey, user.user_uid || '0000000', user.country_flag, dialCode, phone, `${plan.name} (${plan.days}D)`, plan.price, `VIP-${plan.level}`, createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.json({ ok: true, plan, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Failed activating plan' });
  }
});

// Deposit using ONLY Payment Screenshot Upload (no TxID required)
app.post('/api/orders/deposit', (req, res) => {
  try {
    const {
      countryFlag = '🇵🇰',
      dialCode = '+92',
      phone,
      network = 'TRC20',
      amount,
      proofData
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !proofData || !String(proofData).startsWith('data:image/')) {
      return res.status(400).json({ error: 'Minimum $10 deposit and a valid payment screenshot are required.' });
    }

    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    const userUid = user?.user_uid || '0000000';
    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();
    const userKey = `${dialCode}-${phone}`;

    executeSql(
      `INSERT INTO orders (order_id, user_key, user_uid, country_flag, dial_code, phone, order_type, network, amount, txid, proof_data, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Deposit', ?, ?, 'Screenshot Proof', ?, 'Pending', ?, ?)`,
      [orderId, userKey, userUid, countryFlag, dialCode, phone, network, numAmount, String(proofData), createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.status(201).json({ orderId, createdAt, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Failed creating deposit order' });
  }
});

app.post('/api/orders/withdraw', (req, res) => {
  try {
    const {
      countryFlag = '🇵🇰',
      dialCode = '+92',
      phone,
      address,
      amount
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !address) {
      return res.status(400).json({ error: 'Minimum withdrawal is $10.00 USD.' });
    }

    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < numAmount) {
      return res.status(400).json({ error: 'Insufficient USD balance' });
    }

    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();
    const userKey = `${dialCode}-${phone}`;

    executeSql(`UPDATE users SET balance = balance - ? WHERE dial_code = ? AND phone = ?`, [numAmount, dialCode, phone]);
    executeSql(
      `INSERT INTO orders (order_id, user_key, user_uid, country_flag, dial_code, phone, order_type, network, amount, txid, proof_data, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Withdraw', 'TRC20', ?, ?, '', 'Pending', ?, ?)`,
      [orderId, userKey, user.user_uid || '0000000', countryFlag, dialCode, phone, numAmount, String(address).trim(), createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.status(201).json({ orderId, createdAt, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Withdraw error' });
  }
});

// Lucky Spin capped strictly <= $1.00
const SPIN_POOL = [
  { label: '$0.15 Bonus', amount: 0.15, weight: 28 },
  { label: '$0.25 Bonus', amount: 0.25, weight: 25 },
  { label: '$0.50 Bonus', amount: 0.50, weight: 20 },
  { label: '$0.75 Surprise', amount: 0.75, weight: 15 },
  { label: '$1.00 Max Jackpot', amount: 1.00, weight: 12 }
];

app.post('/api/spin/play', (req, res) => {
  try {
    const { dialCode, phone } = req.body || {};
    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.spins_left || 0) <= 0) {
      return res.status(400).json({ error: 'No spins left! Invite friends to earn extra spin surprises.' });
    }

    const totalWeight = SPIN_POOL.reduce((s, item) => s + item.weight, 0);
    let r = Math.random() * totalWeight;
    let chosen = SPIN_POOL[0];
    for (const item of SPIN_POOL) {
      r -= item.weight;
      if (r <= 0) {
        chosen = item;
        break;
      }
    }

    const reward = Math.min(1.00, Number(chosen.amount.toFixed(2)));
    const userKey = `${dialCode}-${phone}`;
    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();

    executeSql(
      `UPDATE users SET spins_left = spins_left - 1, balance = balance + ?, today_yield = today_yield + ? WHERE dial_code = ? AND phone = ?`,
      [reward, reward, dialCode, phone]
    );
    executeSql(
      `INSERT INTO orders (order_id, user_key, user_uid, country_flag, dial_code, phone, order_type, network, amount, txid, proof_data, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Lucky Spin', 'REWARD', ?, ?, '', 'Approved', ?, ?)`,
      [orderId, userKey, user.user_uid || '0000000', user.country_flag, dialCode, phone, reward, chosen.label, createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.json({ reward, label: chosen.label, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Spin error' });
  }
});

app.post('/api/rewards/claim', (req, res) => {
  try {
    const { dialCode, phone, label = 'Daily Plan Yield' } = req.body || {};
    const user = queryOne(`SELECT * FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const plan = PLANS.find((p) => p.level === user.vip_level);
    if (!plan || (user.plan_days_left || 0) <= 0) {
      return res.status(400).json({ error: 'Activate a VIP Plan first to claim daily trading yield!' });
    }

    const amt = plan.daily;
    const userKey = `${dialCode}-${phone}`;
    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();

    executeSql(
      `UPDATE users SET balance = balance + ?, today_yield = today_yield + ? WHERE dial_code = ? AND phone = ?`,
      [amt, amt, dialCode, phone]
    );
    executeSql(
      `INSERT INTO orders (order_id, user_key, user_uid, country_flag, dial_code, phone, order_type, network, amount, txid, proof_data, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'YIELD', ?, 'AUTO-BOT', '', 'Approved', ?, ?)`,
      [orderId, userKey, user.user_uid || '0000000', user.country_flag, dialCode, phone, label, amt, createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.json({ claimedAmount: amt, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Reward claim error' });
  }
});

app.get('/api/admin/dashboard', verifyAdmin, (req, res) => {
  try {
    const orders = queryAll(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`);
    const users = queryAll(`SELECT id, user_uid, full_name, country_flag, dial_code, phone, ref_code, invited_by, active_invites, balance, vip_level, plan_days_left, created_at FROM users ORDER BY id DESC LIMIT 100`);
    const sRows = queryAll(`SELECT key, value FROM settings`);
    const networks = {};
    sRows.forEach((r) => {
      networks[r.key] = r.value;
    });
    res.json({ orders, users, networks });
  } catch (err) {
    res.status(500).json({ error: 'Failed loading admin data' });
  }
});

app.post('/api/admin/orders/:orderId/action', verifyAdmin, (req, res) => {
  try {
    const { orderId } = req.params;
    const { action } = req.body || {};

    if (!['Approved', 'Rejected'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const order = queryOne(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending') {
      return res.status(400).json({ error: `Order is already ${order.status}` });
    }

    const updatedAt = getFormattedDateTime();
    executeSql(`UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`, [action, updatedAt, orderId]);

    if (order.order_type === 'Deposit' && action === 'Approved') {
      const priorApproved = queryOne(
        `SELECT order_id FROM orders WHERE user_key = ? AND order_type = 'Deposit' AND status = 'Approved' AND order_id != ?`,
        [order.user_key, orderId]
      );

      executeSql(
        `UPDATE users SET balance = balance + ? WHERE dial_code = ? AND phone = ?`,
        [order.amount, order.dial_code, order.phone]
      );

      if (!priorApproved) {
        const depositor = queryOne(`SELECT invited_by FROM users WHERE dial_code = ? AND phone = ?`, [order.dial_code, order.phone]);
        if (depositor && depositor.invited_by) {
          const rebate = Number((order.amount * 0.12).toFixed(2));
          executeSql(
            `UPDATE users SET active_invites = active_invites + 1, spins_left = spins_left + 1, team_rebate = team_rebate + ?, balance = balance + ? WHERE ref_code = ? OR user_uid = ?`,
            [rebate, rebate, depositor.invited_by, depositor.invited_by]
          );
        }
      }
    }

    if (order.order_type === 'Withdraw' && action === 'Rejected') {
      executeSql(
        `UPDATE users SET balance = balance + ? WHERE dial_code = ? AND phone = ?`,
        [order.amount, order.dial_code, order.phone]
      );
    }

    res.json({ ok: true, orderId, status: action, updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Action failed' });
  }
});

app.post('/api/admin/wallets', verifyAdmin, (req, res) => {
  try {
    const { network, address } = req.body || {};
    if (!['TRC20', 'BEP20'].includes(network) || !address || !String(address).trim()) {
      return res.status(400).json({ error: 'Network and valid address required' });
    }

    const existing = queryOne(`SELECT key FROM settings WHERE key = ?`, [network]);
    if (existing) {
      executeSql(`UPDATE settings SET value = ? WHERE key = ?`, [String(address).trim(), network]);
    } else {
      executeSql(`INSERT INTO settings (key, value) VALUES (?, ?)`, [network, String(address).trim()]);
    }

    res.json({ ok: true, network, address: String(address).trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed updating wallet' });
  }
});

app.get('/api/support/messages', (req, res) => {
  try {
    const dialCode = String(req.query.dialCode || '+92').trim();
    const phone = String(req.query.phone || '').trim();
    const userKey = `${dialCode}-${phone}`;
    const messages = queryAll(
      `SELECT * FROM support_messages WHERE user_key = ? ORDER BY id ASC LIMIT 100`,
      [userKey]
    );
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed loading support chat' });
  }
});

app.post('/api/support/send', (req, res) => {
  try {
    const {
      countryFlag = '🇵🇰',
      dialCode = '+92',
      phone,
      message = '',
      mediaType = 'none',
      mediaData = ''
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    const cleanMedia = String(mediaData || '');
    if (!cleanMsg && !cleanMedia) {
      return res.status(400).json({ error: 'Message, photo, or video required' });
    }

    const user = queryOne(`SELECT user_uid FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    const userUid = user?.user_uid || '0000000';
    const userKey = `${dialCode}-${phone}`;
    const createdAt = getFormattedDateTime();

    executeSql(
      `INSERT INTO support_messages (user_key, user_uid, country_flag, dial_code, phone, sender, message, media_type, media_data, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
      [userKey, userUid, countryFlag, dialCode, phone, cleanMsg, mediaType, cleanMedia, createdAt]
    );

    const messages = queryAll(
      `SELECT * FROM support_messages WHERE user_key = ? ORDER BY id ASC LIMIT 100`,
      [userKey]
    );
    res.status(201).json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed sending message' });
  }
});

app.get('/api/admin/support', verifyAdmin, (req, res) => {
  try {
    const messages = queryAll(`SELECT * FROM support_messages ORDER BY id DESC LIMIT 120`);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed loading admin support messages' });
  }
});

app.post('/api/admin/support/reply', verifyAdmin, (req, res) => {
  try {
    const { userKey, message = '', mediaType = 'none', mediaData = '' } = req.body || {};
    const cleanMsg = String(message || '').trim();
    const cleanMedia = String(mediaData || '');
    if (!userKey || (!cleanMsg && !cleanMedia)) {
      return res.status(400).json({ error: 'User key and reply or media required' });
    }

    const parts = String(userKey).split('-');
    const dialCode = parts[0] || '+92';
    const phone = parts.slice(1).join('-') || '';
    const user = queryOne(`SELECT user_uid FROM users WHERE dial_code = ? AND phone = ?`, [dialCode, phone]);
    const createdAt = getFormattedDateTime();

    executeSql(
      `INSERT INTO support_messages (user_key, user_uid, country_flag, dial_code, phone, sender, message, media_type, media_data, created_at)
       VALUES (?, ?, '🛡️', ?, ?, 'admin', ?, ?, ?, ?)`,
      [userKey, user?.user_uid || '0000000', dialCode, phone, cleanMsg, mediaType, cleanMedia, createdAt]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed sending admin reply' });
  }
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`AUREX VAULT server running on http://localhost:${PORT}`);
  });
});