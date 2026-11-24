const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const dbPath = path.join(__dirname, 'aurex_vault.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('SQLite connection error:', err.message);
  } else {
    console.log('Connected to AUREX VAULT SQLite database.');
  }
});

// Helper to format readable Date & Time
function getFormattedDateTime() {
  const now = new Date();
  const datePart = now.toISOString().split('T')[0];
  const timePart = now.toTimeString().split(' ')[0];
  return `${datePart} ${timePart} UTC`;
}

// Helper to generate unique Deposit / Order ID
function generateOrderId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${ymd}-${rand}`;
}

db.serialize(() => {
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

  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [
    'TRC20',
    'TER4vxuCgwKT4cymyC2NRZgVYnvWn6dFC9',
  ]);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [
    'BEP20',
    '0xe37ab67b88eadcb56c05fe80ebde4ea5786962aa',
  ]);

  db.run(
    `INSERT OR IGNORE INTO users (country_code, country_flag, dial_code, phone, balance, today_yield, team_rebate, vip_level, spins_left, created_at)
     VALUES ('US', '🇺🇸', '+1', '202-555-0148', 1240.50, 18.40, 312.00, 2, 2, ?)`,
    [getFormattedDateTime()]
  );

  db.run(
    `INSERT OR IGNORE INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
     VALUES ('ORD-20261124-1001', '+1-202-555-0148', '🇺🇸', '+1', '202-555-0148', 'Deposit', 'TRC20', 100.00, '0x98f1a7b3c9021e44d56a7890c421', 'Approved', ?, ?)`,
    [getFormattedDateTime(), getFormattedDateTime()]
  );
});

function getUserSnapshot(dialCode, phone, callback) {
  const userKey = `${dialCode}-${phone}`;
  db.get(
    `SELECT * FROM users WHERE dial_code = ? AND phone = ?`,
    [dialCode, phone],
    (err, user) => {
      if (err) return callback(err);
      if (!user) return callback(new Error('User not found'));

      db.all(`SELECT key, value FROM settings`, [], (sErr, sRows) => {
        if (sErr) return callback(sErr);
        const networks = {};
        (sRows || []).forEach((r) => {
          networks[r.key] = r.value;
        });

        db.all(
          `SELECT * FROM orders WHERE user_key = ? ORDER BY rowid DESC LIMIT 25`,
          [userKey],
          (oErr, orders) => {
            if (oErr) return callback(oErr);
            callback(null, { user, networks, orders: orders || [] });
          }
        );
      });
    }
  );
}

// Middleware to verify Admin Secret header
function verifyAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'];
  if (!token || token !== ADMIN_SECRET) {
    return res
      .status(401)
      .json({ error: 'Unauthorized: Invalid Admin Password' });
  }
  next();
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'AUREX VAULT API v2' });
});

// Customer Register / Sign-In Session
app.post('/api/auth/session', (req, res) => {
  try {
    const {
      countryCode = 'US',
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
    } = req.body || {};

    const cleanPhone = String(phone).trim() || '202-555-0148';
    const cleanDial = String(dialCode).trim() || '+1';
    const cleanCode = String(countryCode).trim() || 'US';
    const cleanFlag = String(countryFlag).trim() || '🇺🇸';

    db.run(
      `INSERT OR IGNORE INTO users (country_code, country_flag, dial_code, phone, balance, vip_level, spins_left, created_at)
       VALUES (?, ?, ?, ?, 0.00, 1, 2, ?)`,
      [cleanCode, cleanFlag, cleanDial, cleanPhone, getFormattedDateTime()],
      (err) => {
        if (err) return res.status(500).json({ error: 'Session error' });
        getUserSnapshot(cleanDial, cleanPhone, (snapErr, snapshot) => {
          if (snapErr) return res.status(500).json({ error: snapErr.message });
          res.json(snapshot);
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Unexpected auth error' });
  }
});

// Customer Submit Deposit Order (generates Order ID + Date & Time)
app.post('/api/orders/deposit', (req, res) => {
  try {
    const {
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
      network = 'TRC20',
      amount,
      txid,
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !txid || !String(txid).trim()) {
      return res
        .status(400)
        .json({ error: 'Minimum $10 deposit and valid TxID required.' });
    }

    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();
    const userKey = `${dialCode}-${phone}`;

    db.run(
      `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Deposit', ?, ?, ?, 'Pending', ?, ?)`,
      [
        orderId,
        userKey,
        countryFlag,
        dialCode,
        phone,
        network,
        numAmount,
        String(txid).trim(),
        createdAt,
        createdAt,
      ],
      (err) => {
        if (err)
          return res
            .status(500)
            .json({ error: 'Failed creating deposit order' });
        getUserSnapshot(dialCode, phone, (snapErr, snapshot) => {
          if (snapErr) return res.status(500).json({ error: snapErr.message });
          res.status(201).json({ orderId, createdAt, ...snapshot });
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Server error creating order' });
  }
});

// Customer Withdraw Request
app.post('/api/orders/withdraw', (req, res) => {
  try {
    const {
      countryFlag = '🇺🇸',
      dialCode = '+1',
      phone = '202-555-0148',
      address,
      amount,
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || !address) {
      return res
        .status(400)
        .json({
          error: 'Valid amount ($10+) and destination wallet required.',
        });
    }

    db.get(
      `SELECT * FROM users WHERE dial_code = ? AND phone = ?`,
      [dialCode, phone],
      (err, user) => {
        if (err || !user)
          return res.status(404).json({ error: 'User not found' });
        if (user.balance < numAmount) {
          return res.status(400).json({ error: 'Insufficient USD balance' });
        }

        const orderId = generateOrderId();
        const createdAt = getFormattedDateTime();
        const userKey = `${dialCode}-${phone}`;

        db.serialize(() => {
          db.run(
            `UPDATE users SET balance = balance - ? WHERE dial_code = ? AND phone = ?`,
            [numAmount, dialCode, phone]
          );
          db.run(
            `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'Withdraw', 'TRC20', ?, ?, 'Pending', ?, ?)`,
            [
              orderId,
              userKey,
              countryFlag,
              dialCode,
              phone,
              numAmount,
              String(address).trim(),
              createdAt,
              createdAt,
            ],
            (insErr) => {
              if (insErr)
                return res.status(500).json({ error: 'Withdraw order failed' });
              getUserSnapshot(dialCode, phone, (snapErr, snapshot) => {
                if (snapErr)
                  return res.status(500).json({ error: snapErr.message });
                res.status(201).json({ orderId, createdAt, ...snapshot });
              });
            }
          );
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Withdraw error' });
  }
});

// Customer Claim Daily Yield or Spin
app.post('/api/rewards/claim', (req, res) => {
  try {
    const {
      dialCode = '+1',
      phone = '202-555-0148',
      rewardAmount = 5.5,
      label = 'Daily Yield Claim',
    } = req.body || {};
    const amt = Number(rewardAmount) || 0;
    const userKey = `${dialCode}-${phone}`;
    const orderId = generateOrderId();
    const createdAt = getFormattedDateTime();

    db.serialize(() => {
      db.run(
        `UPDATE users SET balance = balance + ?, today_yield = today_yield + ? WHERE dial_code = ? AND phone = ?`,
        [amt, amt, dialCode, phone]
      );
      db.run(
        `INSERT INTO orders (order_id, user_key, country_flag, dial_code, phone, order_type, network, amount, txid, status, created_at, updated_at)
         VALUES (?, ?, '🌐', ?, ?, ?, 'VAULT', ?, 'REWARD-NODE', 'Approved', ?, ?)`,
        [orderId, userKey, dialCode, phone, label, amt, createdAt, createdAt],
        () => {
          getUserSnapshot(dialCode, phone, (snapErr, snapshot) => {
            if (snapErr)
              return res.status(500).json({ error: snapErr.message });
            res.json(snapshot);
          });
        }
      );
    });
  } catch (err) {
    res.status(500).json({ error: 'Reward claim error' });
  }
});

// ==================== SEPARATE ADMIN API ROUTES ====================

// Admin Login & Full Dashboard Fetch
app.get('/api/admin/dashboard', verifyAdmin, (req, res) => {
  db.all(
    `SELECT * FROM orders ORDER BY rowid DESC LIMIT 100`,
    [],
    (oErr, orders) => {
      if (oErr) return res.status(500).json({ error: 'Failed loading orders' });
      db.all(
        `SELECT * FROM users ORDER BY id DESC LIMIT 100`,
        [],
        (uErr, users) => {
          if (uErr)
            return res.status(500).json({ error: 'Failed loading users' });
          db.all(`SELECT key, value FROM settings`, [], (sErr, sRows) => {
            if (sErr)
              return res.status(500).json({ error: 'Failed loading settings' });
            const networks = {};
            (sRows || []).forEach((r) => {
              networks[r.key] = r.value;
            });
            res.json({ orders: orders || [], users: users || [], networks });
          });
        }
      );
    }
  );
});

// Admin Approve or Reject Order
app.post('/api/admin/orders/:orderId/action', verifyAdmin, (req, res) => {
  const { orderId } = req.params;
  const { action } = req.body || {};

  if (!['Approved', 'Rejected'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], (err, order) => {
    if (err || !order)
      return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending') {
      return res
        .status(400)
        .json({ error: `Order is already ${order.status}` });
    }

    const updatedAt = getFormattedDateTime();

    db.serialize(() => {
      db.run(
        `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        [action, updatedAt, orderId]
      );

      if (order.order_type === 'Deposit' && action === 'Approved') {
        db.run(
          `UPDATE users SET balance = balance + ? WHERE dial_code = ? AND phone = ?`,
          [order.amount, order.dial_code, order.phone]
        );
      }

      if (order.order_type === 'Withdraw' && action === 'Rejected') {
        db.run(
          `UPDATE users SET balance = balance + ? WHERE dial_code = ? AND phone = ?`,
          [order.amount, order.dial_code, order.phone]
        );
      }

      res.json({ ok: true, orderId, status: action, updatedAt });
    });
  });
});

// Admin Update USDT Wallet Addresses
app.post('/api/admin/wallets', verifyAdmin, (req, res) => {
  const { network, address } = req.body || {};
  if (
    !['TRC20', 'BEP20'].includes(network) ||
    !address ||
    !String(address).trim()
  ) {
    return res
      .status(400)
      .json({ error: 'Network and valid address required' });
  }

  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [network, String(address).trim()],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed updating wallet' });
      res.json({ ok: true, network, address: String(address).trim() });
    }
  );
});

app.listen(PORT, () => {
  console.log(`AUREX VAULT server running on http://localhost:${PORT}`);
});
