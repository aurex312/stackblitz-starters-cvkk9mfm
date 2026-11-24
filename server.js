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
      country_code TEXT NOT NULL,
      country_flag TEXT NOT NULL DEFAULT '🇺🇸',
      dial_code TEXT NOT NULL,
      phone TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0.00,
      today_yield REAL NOT NULL DEFAULT 0.00,
      team_rebate REAL NOT NULL DEFAULT 0.00,
      vip_level INTEGER NOT NULL DEFAULT 1,
      spins_left INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      UNIQUE(dial_code, phone)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
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

  const nowStr = getFormattedDateTime();
  db.run(
    `INSERT OR IGNORE INTO users (country_code, country_flag, dial_code, phone, balance, today_yield, team_rebate, vip_level, spins_left, created_at)
     VALUES ('US', '🇺🇸', '+1', '202-555-0148', 1240.50, 18.40, 312.00, 2, 2, ?)`,
    [nowStr]
  );

  db.run(
    `INSERT OR IGNORE INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
     VALUES ('ORD-20261124-1001', '+1-202-555-0148', '🇺🇸', '+1', '202-555-0148', 'Deposit', 'TRC20', 100.00, '0x98f1a7b3c9021e44d56a7890c421', 'Approved', ?, ?)`,
    [nowStr, nowStr]
  );

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
    `SELECT * FROM orders WHERE user_key = ? ORDER BY rowid DESC LIMIT 25`,
    [userKey]
  );

  return { user, networks, orders };
}

function verifyAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'];
  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'AUREX VAULT API v2' });
});

app.post('/api/auth/session', (req, res) => {
  try {
    const {
      countryCode = 'US',
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148'
    } = req.body || {};

    const cleanPhone = String(phone).trim() || '202-555-0148';
    const cleanDial = String(dialCode).trim() || '+1';
    const cleanCode = String(countryCode).trim() || 'US';
    const cleanFlag = String(countryFlag).trim() || '🇺🇸';

    executeSql(
      `INSERT OR IGNORE INTO users (country_code, country_flag, dial_code, phone, balance, vip_level, spins_left, created_at)
       VALUES (?, ?, ?, ?, 0.00, 1, 2, ?)`,
      [cleanCode, cleanFlag, cleanDial, cleanPhone, getFormattedDateTime()]
    );

    const snapshot = getUserSnapshot(cleanDial, cleanPhone);
    if (!snapshot) return res.status(404).json({ error: 'User not found' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Session error' });
  }
});

app.post('/api/orders/deposit', (req, res) => {
  try {
    const {
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
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
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
      address,
      amount
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !address) {
      return res.status(400).json({ error: 'Valid amount ($10+) and destination wallet required.' });
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
    const { dialCode = '+1', phone = '202-555-0148', rewardAmount = 5.5, label = 'Daily Yield Claim' } = req.body || {};
    const amt = Number(rewardAmount) || 0;
    const userKey = `${dialCode}-${phone}`;
    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();

    executeSql(
      `UPDATE users SET balance = balance + ?, today_yield = today_yield + ? WHERE dial_code = ? AND phone = ?`,
      [amt, amt, dialCode, phone]
    );
    executeSql(
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, '🌐', ?, ?, ?, 'VAULT', ?, 'REWARD-NODE', 'Approved', ?, ?)`,
      [orderId, userKey, dialCode, phone, label, amt, createdAt, createdAt]
    );

    const snapshot = getUserSnapshot(dialCode, phone);
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Reward claim error' });
  }
});

app.get('/api/admin/dashboard', verifyAdmin, (req, res) => {
  try {
    const orders = queryAll(`SELECT * FROM orders ORDER BY rowid DESC LIMIT 100`);
    const users = queryAll(`SELECT * FROM users ORDER BY id DESC LIMIT 100`);
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
      executeSql(
        `UPDATE users SET balance = balance + ? WHERE dial_code = ? AND phone = ?`,
        [order.amount, order.dial_code, order.phone]
      );
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
    const dialCode = String(req.query.dialCode || '+1').trim();
    const phone = String(req.query.phone || '202-555-0148').trim();
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
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
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
    const dialCode = parts[0] || '+1';
    const phone = parts.slice(1).join('-') || '202-555-0148';
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