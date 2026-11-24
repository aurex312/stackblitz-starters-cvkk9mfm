const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';

app.use(cors());
app.use(express.json());
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

function generateRefCode(phone) {
  const digits = String(phone).replace(/\D/g, '').slice(-4) || '8829';
  const alpha = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `AVX${alpha}${digits}`;
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
      full_name TEXT NOT NULL DEFAULT 'Global Trader',
      country_code TEXT NOT NULL,
      country_flag TEXT NOT NULL DEFAULT '🇺🇸',
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '123456',
      ref_code TEXT NOT NULL DEFAULT 'AVX8829',
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
  if (!userCols.includes('full_name')) db.run(`ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT 'Global Trader'`);
  if (!userCols.includes('password')) db.run(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT '123456'`);
  if (!userCols.includes('ref_code')) db.run(`ALTER TABLE users ADD COLUMN ref_code TEXT NOT NULL DEFAULT 'AVX8829'`);
  if (!userCols.includes('invited_by')) db.run(`ALTER TABLE users ADD COLUMN invited_by TEXT DEFAULT ''`);
  if (!userCols.includes('active_invites')) db.run(`ALTER TABLE users ADD COLUMN active_invites INTEGER NOT NULL DEFAULT 0`);
  if (!userCols.includes('plan_days_left')) db.run(`ALTER TABLE users ADD COLUMN plan_days_left INTEGER NOT NULL DEFAULT 0`);

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
      country_flag TEXT NOT NULL,
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      order_type TEXT NOT NULL,
      network TEXT NOT NULL,
      amount REAL NOT NULL,
      txid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      country_flag TEXT NOT NULL,
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

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

    const refCode = generateRefCode(cleanPhone);
    const createdAt = getFormattedDateTime();

    executeSql(
      `INSERT INTO users (full_name, country_code, country_flag, dial_code, phone, password, ref_code, invited_by, active_invites, balance, vip_level, plan_days_left, spins_left, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0.00, 0, 0, 2, ?)`,
      [
        String(fullName).trim() || 'Trader',
        countryCode,
        countryFlag,
        dialCode,
        cleanPhone,
        cleanPass,
        refCode,
        String(inviteCode).trim().toUpperCase(),
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
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PLAN', ?, ?, 'Approved', ?, ?)`,
      [orderId, userKey, user.country_flag, dialCode, phone, `${plan.name} (${plan.days}D)`, plan.price, `VIP-${plan.level}`, createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.json({ ok: true, plan, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Failed activating plan' });
  }
});

app.post('/api/orders/deposit', (req, res) => {
  try {
    const {
      countryFlag = '🇵🇰',
      dialCode = '+92',
      phone,
      network = 'TRC20',
      amount,
      txid
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !txid || !String(txid).trim()) {
      return res.status(400).json({ error: 'Minimum $10 deposit and valid TxID required.' });
    }

    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();
    const userKey = `${dialCode}-${phone}`;

    executeSql(
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Deposit', ?, ?, ?, 'Pending', ?, ?)`,
      [orderId, userKey, countryFlag, dialCode, phone, network, numAmount, String(txid).trim(), createdAt, createdAt]
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
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Withdraw', 'TRC20', ?, ?, 'Pending', ?, ?)`,
      [orderId, userKey, countryFlag, dialCode, phone, numAmount, String(address).trim(), createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.status(201).json({ orderId, createdAt, ...snapshot });
  } catch (err) {
    res.status(500).json({ error: 'Withdraw error' });
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
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'YIELD', ?, 'AUTO-BOT', 'Approved', ?, ?)`,
      [orderId, userKey, user.country_flag, dialCode, phone, label, amt, createdAt, createdAt]
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
    const users = queryAll(`SELECT id, full_name, country_flag, dial_code, phone, ref_code, invited_by, active_invites, balance, vip_level, plan_days_left, created_at FROM users ORDER BY id DESC LIMIT 100`);
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
            `UPDATE users SET active_invites = active_invites + 1, team_rebate = team_rebate + ?, balance = balance + ? WHERE ref_code = ?`,
            [rebate, rebate, depositor.invited_by]
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
      message
    } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    const userKey = `${dialCode}-${phone}`;
    const createdAt = getFormattedDateTime();
    executeSql(
      `INSERT INTO support_messages (user_key, country_flag, dial_code, phone, sender, message, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?)`,
      [userKey, countryFlag, dialCode, phone, String(message).trim(), createdAt]
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
    const messages = queryAll(`SELECT * FROM support_messages ORDER BY id DESC LIMIT 200`);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed loading admin support messages' });
  }
});

app.post('/api/admin/support/reply', verifyAdmin, (req, res) => {
  try {
    const { userKey, message } = req.body || {};
    if (!userKey || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'User key and reply message required' });
    }
    const parts = String(userKey).split('-');
    const dialCode = parts[0] || '+92';
    const phone = parts.slice(1).join('-') || '';
    const createdAt = getFormattedDateTime();
    executeSql(
      `INSERT INTO support_messages (user_key, country_flag, dial_code, phone, sender, message, created_at)
       VALUES (?, '🛡️', ?, ?, 'admin', ?, ?)`,
      [userKey, dialCode, phone, String(message).trim(), createdAt]
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