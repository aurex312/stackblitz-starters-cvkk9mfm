const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';

const DATA_DIR = process.env.SQLITE_DATA_DIR
  ? path.resolve(process.env.SQLITE_DATA_DIR)
  : (fs.existsSync('/data') ? '/data' : __dirname);

fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_PATH = path.join(DATA_DIR, 'aurex_data.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

const SPIN_PRIZES = [0.20, 0.30, 0.50, 0.70];
const CHANNEL_JOIN_REWARD = 0.50;

function defaultStore() {
  return {
    nextUserId: 1,
    nextOrderId: 1,
    nextSpinId: 1,
    nextMsgId: 1,
    nextSubId: 1,
    users: [],
    sessions: {},
    orders: [],
    spin_logs: [],
    support_messages: [],
    vip_subscriptions: [],
    settings: {
      trc20_wallet: 'T9yD14Nj9j7xAB41GeiX9h2kQ8pL5mN2vR',
      bep20_wallet: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      telegram_channel: 'https://t.me/AurexVaultOfficial',
      telegram_support: 'https://t.me/AurexVaultSupport'
    }
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    const fresh = defaultStore();
    saveStore(fresh);
    return fresh;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...defaultStore(), ...parsed, settings: { ...defaultStore().settings, ...(parsed.settings || {}) } };
  } catch {
    const fresh = defaultStore();
    saveStore(fresh);
    return fresh;
  }
}

function saveStore(store) {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

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

function generateUnique7DigitUid(store) {
  for (let i = 0; i < 1000; i++) {
    const uid = String(crypto.randomInt(1000000, 9999999));
    if (!store.users.some((u) => u.user_uid === uid || u.ref_code === uid)) {
      return uid;
    }
  }
  return String(Date.now()).slice(-7);
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

function hasActiveVipPlan(store, userId, nowIso = new Date().toISOString()) {
  return store.vip_subscriptions.some(
    (s) => Number(s.user_id) === Number(userId) && s.status === 'active' && s.expires_at > nowIso
  );
}

function sanitizeUser(store, u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
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
    has_active_plan: hasActiveVipPlan(store, safe.id)
  };
}

function getAuthContext(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  const store = loadStore();
  const session = store.sessions[token];
  if (!session) return null;
  const user = store.users.find((u) => Number(u.id) === Number(session.user_id));
  if (!user) return null;
  return { store, user, token };
}

function requireAuth(req, res, next) {
  const ctx = getAuthContext(req);
  if (!ctx) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.store = ctx.store;
  req.user = ctx.user;
  next();
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Invalid admin secret' });
  }
  next();
}

// Register (referral code is completely optional)
app.post('/api/auth/register', (req, res) => {
  try {
    const body = req.body || {};
    const fullName = String(body.full_name ?? body.fullName ?? '').trim();
    const dialCode = String(body.dial_code ?? body.dialCode ?? '+92').trim();
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

    const store = loadStore();
    const existingPhone = store.users.find((u) => u.phone === phone);
    if (existingPhone) {
      return res.status(409).json({
        error: 'An account already exists with this phone number. Only one account is allowed per phone number.'
      });
    }

    let referredByUid = null;
    if (refCodeInput) {
      const referrer = store.users.find(
        (u) => u.user_uid === refCodeInput || u.ref_code === refCodeInput
      );
      if (referrer) {
        referredByUid = referrer.user_uid;
      }
    }

    const userUid = generateUnique7DigitUid(store);
    const nowIso = new Date().toISOString();
    const newUser = {
      id: store.nextUserId++,
      user_uid: userUid,
      ref_code: userUid,
      full_name: fullName,
      phone,
      dial_code: dialCode,
      country_code: countryCode,
      country_flag: countryFlag,
      password_hash: hashPassword(password),
      referred_by_uid: referredByUid,
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

    store.users.push(newUser);
    const token = generateToken();
    store.sessions[token] = { user_id: newUser.id, created_at: nowIso };
    saveStore(store);

    return res.status(201).json({
      token,
      user: sanitizeUser(store, newUser),
      orders: [],
      wallets: {
        TRC20: store.settings.trc20_wallet,
        BEP20: store.settings.bep20_wallet
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Failed to register account.', details: err.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const dialCode = String(body.dial_code ?? body.dialCode ?? '+92').trim();
    const rawPhone = body.phone ?? body.mobile ?? '';
    const password = String(body.password ?? '');

    if (!String(rawPhone).trim() || !password) {
      return res.status(400).json({ error: 'Phone number and password are required.' });
    }

    const store = loadStore();
    const normalizedWithDial = normalizePhone(rawPhone, dialCode);
    const normalizedDirect = normalizePhone(rawPhone);

    const user = store.users.find(
      (u) => u.phone === normalizedWithDial || u.phone === normalizedDirect
    );

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    const token = generateToken();
    store.sessions[token] = { user_id: user.id, created_at: new Date().toISOString() };
    saveStore(store);

    const orders = store.orders
      .filter((o) => Number(o.user_id) === Number(user.id))
      .sort((a, b) => b.id - a.id);

    return res.json({
      token,
      user: sanitizeUser(store, user),
      orders,
      wallets: {
        TRC20: store.settings.trc20_wallet,
        BEP20: store.settings.bep20_wallet
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Failed to sign in.' });
  }
});

// Profile
app.get('/api/user/profile', requireAuth, (req, res) => {
  const { store, user } = req;
  const subscriptions = store.vip_subscriptions
    .filter((s) => Number(s.user_id) === Number(user.id))
    .sort((a, b) => b.id - a.id);
  const orders = store.orders
    .filter((o) => Number(o.user_id) === Number(user.id))
    .sort((a, b) => b.id - a.id);
  const spinLogs = store.spin_logs
    .filter((l) => Number(l.user_id) === Number(user.id))
    .sort((a, b) => b.id - a.id);

  return res.json({
    user: sanitizeUser(store, user),
    vip_plans: VIP_PLANS,
    subscriptions,
    orders,
    spin_logs: spinLogs,
    wallets: {
      TRC20: store.settings.trc20_wallet,
      BEP20: store.settings.bep20_wallet
    },
    telegram: {
      channel: store.settings.telegram_channel,
      support: store.settings.telegram_support,
      join_reward: CHANNEL_JOIN_REWARD
    }
  });
});

// Channel Join Reward
app.post('/api/rewards/channel-join', requireAuth, (req, res) => {
  const { store, user } = req;
  const rawHandle = String(req.body.telegram_username ?? req.body.telegramUsername ?? '').trim();
  const cleanHandle = rawHandle.replace(/^@+/, '');

  if (!cleanHandle || cleanHandle.length < 3) {
    return res.status(400).json({ error: 'Please enter a valid Telegram @username.' });
  }

  if (Number(user.channel_reward_claimed || 0) === 1) {
    return res.status(400).json({ error: 'Channel join reward has already been claimed.' });
  }

  user.balance = Number((Number(user.balance || 0) + CHANNEL_JOIN_REWARD).toFixed(2));
  user.channel_reward_claimed = 1;
  user.telegram_username = `@${cleanHandle}`;
  saveStore(store);

  return res.json({
    reward: CHANNEL_JOIN_REWARD,
    user: sanitizeUser(store, user)
  });
});

// VIP Plans & Activate
app.get('/api/vip/plans', requireAuth, (req, res) => {
  const { store, user } = req;
  const plans = VIP_PLANS.map((plan) => ({
    ...plan,
    unlocked: Number(user.active_invites || 0) >= plan.min_invites
  }));
  return res.json({
    plans,
    active_invites: Number(user.active_invites || 0),
    current_vip_level: Number(user.vip_level || 0)
  });
});

app.post('/api/vip/activate', requireAuth, (req, res) => {
  const { store, user } = req;
  const level = Number(req.body.vip_level ?? req.body.level);
  const plan = VIP_PLANS.find((p) => p.level === level);
  if (!plan) {
    return res.status(400).json({ error: 'Invalid VIP plan selected.' });
  }

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
  user.balance = Number((Number(user.balance || 0) - plan.amount + pendingReward).toFixed(2));
  user.pending_spin_reward = 0;
  user.vip_level = Math.max(Number(user.vip_level || 0), plan.level);

  const now = new Date();
  store.vip_subscriptions.push({
    id: store.nextSubId++,
    user_id: user.id,
    user_uid: user.user_uid,
    vip_level: plan.level,
    amount: plan.amount,
    days: plan.days,
    daily_return: plan.daily_return,
    status: 'active',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000).toISOString()
  });
  saveStore(store);

  return res.json({
    message: `${plan.name} activated successfully.`,
    unlocked_spin_reward: pendingReward,
    user: sanitizeUser(store, user)
  });
});

// Deposit & Withdraw Orders
app.post('/api/orders/deposit', requireAuth, (req, res) => {
  const { store, user } = req;
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

  const nowIso = new Date().toISOString();
  const order = {
    id: store.nextOrderId++,
    order_code: generateOrderCode(),
    user_id: user.id,
    user_uid: user.user_uid,
    type: 'deposit',
    amount: Number(amount.toFixed(2)),
    network,
    wallet_address: network === 'TRC20' ? store.settings.trc20_wallet : store.settings.bep20_wallet,
    proof_data: proofData,
    status: 'pending',
    created_at: nowIso,
    updated_at: nowIso
  };
  store.orders.push(order);
  saveStore(store);
  return res.status(201).json({ order });
});

app.post('/api/orders/withdraw', requireAuth, (req, res) => {
  const { store, user } = req;
  const amount = Number(req.body.amount);
  const network = String(req.body.network || 'TRC20').toUpperCase().trim();
  const walletAddress = String(req.body.wallet_address ?? req.body.address ?? '').trim();

  if (!Number.isFinite(amount) || amount < 10) {
    return res.status(400).json({ error: 'Minimum withdrawal amount is $10.00.' });
  }
  if (!walletAddress) {
    return res.status(400).json({ error: 'Destination wallet address is required.' });
  }
  if (Number(user.balance || 0) < amount) {
    return res.status(400).json({ error: 'Insufficient balance for this withdrawal.' });
  }

  const roundedAmount = Number(amount.toFixed(2));
  user.balance = Number((Number(user.balance || 0) - roundedAmount).toFixed(2));
  const nowIso = new Date().toISOString();

  const order = {
    id: store.nextOrderId++,
    order_code: generateOrderCode(),
    user_id: user.id,
    user_uid: user.user_uid,
    type: 'withdraw',
    amount: roundedAmount,
    network,
    wallet_address: walletAddress,
    proof_data: null,
    status: 'pending',
    created_at: nowIso,
    updated_at: nowIso
  };
  store.orders.push(order);
  saveStore(store);

  return res.status(201).json({
    order,
    user: sanitizeUser(store, user)
  });
});

// Lucky Golden Spin (Depositors only, <= $1.00, credited only with active VIP plan)
app.post('/api/spin/play', requireAuth, (req, res) => {
  const { store, user } = req;

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
  user.spins_left = Math.max(0, Number(user.spins_left || 0) - 1);

  const nowIso = new Date().toISOString();
  const activePlan = hasActiveVipPlan(store, user.id, nowIso);

  if (activePlan) {
    user.balance = Number((Number(user.balance || 0) + reward).toFixed(2));
  } else {
    user.pending_spin_reward = Number((Number(user.pending_spin_reward || 0) + reward).toFixed(2));
  }

  store.spin_logs.push({
    id: store.nextSpinId++,
    user_id: user.id,
    user_uid: user.user_uid,
    reward,
    created_at: nowIso
  });
  saveStore(store);

  return res.json({
    reward,
    plan_active: activePlan,
    message: activePlan
      ? `Won $${reward.toFixed(2)} credited to balance!`
      : `Won $${reward.toFixed(2)}. Pehle apna VIP plan active karein — reward active plan ke sath unlock hoga.`,
    user: sanitizeUser(store, user)
  });
});

// Support Chat
app.get('/api/support/messages', requireAuth, (req, res) => {
  const { store, user } = req;
  const messages = store.support_messages.filter((m) => Number(m.user_id) === Number(user.id));
  return res.json({ messages });
});

app.post('/api/support/messages', requireAuth, (req, res) => {
  const { store, user } = req;
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

  const created = {
    id: store.nextMsgId++,
    user_id: user.id,
    user_uid: user.user_uid,
    sender: 'user',
    message_text: messageText || null,
    media_type: mediaData ? mediaType : null,
    media_data: mediaData || null,
    created_at: new Date().toISOString()
  };
  store.support_messages.push(created);
  saveStore(store);
  return res.status(201).json({ message: created });
});

// Admin Routes
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const store = loadStore();
  return res.json({
    users: [...store.users].reverse().map((u) => sanitizeUser(store, u)),
    orders: [...store.orders].reverse(),
    wallets: {
      TRC20: store.settings.trc20_wallet,
      BEP20: store.settings.bep20_wallet
    },
    telegram: {
      channel: store.settings.telegram_channel,
      support: store.settings.telegram_support
    }
  });
});

app.post('/api/admin/settings/wallets', requireAdmin, (req, res) => {
  const store = loadStore();
  if (req.body.trc20_wallet) store.settings.trc20_wallet = String(req.body.trc20_wallet).trim();
  if (req.body.bep20_wallet) store.settings.bep20_wallet = String(req.body.bep20_wallet).trim();
  if (req.body.telegram_channel) store.settings.telegram_channel = String(req.body.telegram_channel).trim();
  if (req.body.telegram_support) store.settings.telegram_support = String(req.body.telegram_support).trim();
  saveStore(store);
  return res.json({
    wallets: {
      TRC20: store.settings.trc20_wallet,
      BEP20: store.settings.bep20_wallet
    },
    telegram: {
      channel: store.settings.telegram_channel,
      support: store.settings.telegram_support
    }
  });
});

app.post('/api/admin/orders/:orderId/action', requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  const action = String(req.body.action || '').toLowerCase().trim();
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be approve or reject.' });
  }

  const store = loadStore();
  const order = store.orders.find((o) => Number(o.id) === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'pending') return res.status(400).json({ error: `Order is already ${order.status}.` });

  const user = store.users.find((u) => Number(u.id) === Number(order.user_id));
  if (!user) return res.status(404).json({ error: 'Order user not found.' });

  const nowIso = new Date().toISOString();
  const amt = Number(order.amount || 0);

  if (order.type === 'deposit') {
    if (action === 'approve') {
      const isFirst = Number(user.first_deposit_done || 0) === 0;
      user.balance = Number((Number(user.balance || 0) + amt).toFixed(2));
      user.first_deposit_done = 1;

      if (isFirst && user.referred_by_uid) {
        const sponsor = store.users.find((u) => u.user_uid === user.referred_by_uid);
        if (sponsor) {
          const rebate = Number((amt * 0.12).toFixed(2));
          sponsor.balance = Number((Number(sponsor.balance || 0) + rebate).toFixed(2));
          sponsor.team_rebate = Number((Number(sponsor.team_rebate || 0) + rebate).toFixed(2));
          sponsor.active_invites = Number(sponsor.active_invites || 0) + 1;
          sponsor.spins_left = Number(sponsor.spins_left || 0) + 1;
        }
      }
      order.status = 'approved';
    } else {
      order.status = 'rejected';
    }
  } else if (order.type === 'withdraw') {
    if (action === 'approve') {
      order.status = 'approved';
    } else {
      user.balance = Number((Number(user.balance || 0) + amt).toFixed(2));
      order.status = 'rejected';
    }
  }

  order.updated_at = nowIso;
  saveStore(store);
  return res.json({ order });
});

app.get('/api/admin/support/threads', requireAdmin, (req, res) => {
  const store = loadStore();
  const byUser = new Map();
  for (const m of store.support_messages) {
    const existing = byUser.get(m.user_id);
    if (!existing || m.id > existing.last_msg_id) {
      const u = store.users.find((usr) => Number(usr.id) === Number(m.user_id));
      byUser.set(m.user_id, {
        user_id: m.user_id,
        user_uid: m.user_uid,
        full_name: u ? u.full_name : m.user_uid,
        phone: u ? u.phone : '',
        last_msg_id: m.id,
        last_created_at: m.created_at,
        last_message: m.message_text || `[${m.media_type}]`
      });
    }
  }
  const threads = Array.from(byUser.values()).sort((a, b) => b.last_msg_id - a.last_msg_id);
  return res.json({ threads });
});

app.get('/api/admin/support/messages/:userId', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const store = loadStore();
  const messages = store.support_messages.filter((m) => Number(m.user_id) === userId);
  return res.json({ messages });
});

app.post('/api/admin/support/messages', requireAdmin, (req, res) => {
  const userId = Number(req.body.user_id);
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

  const store = loadStore();
  const user = store.users.find((u) => Number(u.id) === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const created = {
    id: store.nextMsgId++,
    user_id: user.id,
    user_uid: user.user_uid,
    sender: 'admin',
    message_text: messageText || null,
    media_type: mediaData ? mediaType : null,
    media_data: mediaData || null,
    created_at: new Date().toISOString()
  };
  store.support_messages.push(created);
  saveStore(store);
  return res.status(201).json({ message: created });
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AUREX VAULT PRO running on port ${PORT} (JSON Store: ${STORE_PATH})`);
});