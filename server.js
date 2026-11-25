const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'AUREX-ADMIN-2026';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'AUREX-VAULT-TOKEN-SECRET-2026';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'aurex_data.json');

const DEFAULT_VIP_PLANS = [
  { level: 1, name: 'VIP 1 • Micro Scalper', amount: 10, days: 20, daily_return: 0.85, min_invites: 0 },
  { level: 2, name: 'VIP 2 • Bronze Node', amount: 25, days: 20, daily_return: 2.25, min_invites: 0 },
  { level: 3, name: 'VIP 3 • Silver Pulse', amount: 50, days: 20, daily_return: 4.75, min_invites: 0 },
  { level: 4, name: 'VIP 4 • Gold Matrix', amount: 100, days: 20, daily_return: 10.0, min_invites: 0 },
  { level: 5, name: 'VIP 5 • Platinum Pro', amount: 250, days: 25, daily_return: 26.5, min_invites: 0 },
  { level: 6, name: 'VIP 6 • Diamond Syndicate', amount: 500, days: 30, daily_return: 58.0, min_invites: 3 },
  { level: 7, name: 'VIP 7 • Emerald Whale', amount: 1000, days: 30, daily_return: 122.0, min_invites: 3 },
  { level: 8, name: 'VIP 8 • Sovereign Vault', amount: 2500, days: 30, daily_return: 320.0, min_invites: 3 },
  { level: 9, name: 'VIP 9 • Imperial Apex', amount: 5000, days: 30, daily_return: 680.0, min_invites: 3 }
];

const DEFAULT_WALLETS = {
  TRC20: process.env.WALLET_TRC20 || 'TER4vxuCgwKT4cymyC2NRZgVYnvWn6dFC9',
  BEP20: process.env.WALLET_BEP20 || '0xe37ab67b88eadcb56c05fe80ebde4ea5786962aa'
};

const TELEGRAM_CONFIG = {
  channel: process.env.TG_CHANNEL || 'https://t.me/AurexVaultOfficial',
  support: process.env.TG_SUPPORT || 'https://t.me/AurexVaultSupport'
};

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

function format24HourTimestamp(dateInput = new Date()) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return String(dateInput || '');
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function createInitialStore() {
  return {
    nextUserId: 1,
    nextOrderId: 1,
    nextSubId: 1,
    nextMsgId: 1,
    vip_plans: DEFAULT_VIP_PLANS.map((p) => ({ ...p })),
    wallets: { ...DEFAULT_WALLETS },
    users: [],
    orders: [],
    vip_subscriptions: [],
    support_messages: []
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      const initial = createInitialStore();
      saveStore(initial);
      return initial;
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const initial = createInitialStore();
    return {
      ...initial,
      ...parsed,
      vip_plans:
        Array.isArray(parsed.vip_plans) && parsed.vip_plans.length
          ? parsed.vip_plans
          : DEFAULT_VIP_PLANS.map((p) => ({ ...p })),
      wallets: {
        ...DEFAULT_WALLETS,
        ...(parsed.wallets || {})
      },
      users: Array.isArray(parsed.users) ? parsed.users : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      vip_subscriptions: Array.isArray(parsed.vip_subscriptions) ? parsed.vip_subscriptions : [],
      support_messages: Array.isArray(parsed.support_messages) ? parsed.support_messages : []
    };
  } catch (err) {
    console.error('Error reading aurex_data.json:', err);
    return createInitialStore();
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving aurex_data.json:', err);
  }
}

function normalizePhone(rawPhone, dialCode = '') {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  const dialDigits = String(dialCode || '').replace(/\D/g, '');
  if (!digits) return '';
  if (dialDigits && !digits.startsWith(dialDigits)) {
    return `+${dialDigits}${digits}`;
  }
  return `+${digits}`;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(authHeader = '') {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed?.uid ? Number(parsed.uid) : null;
  } catch (_) {
    return null;
  }
}

function generateUniqueUid(store) {
  let uid = '';
  do {
    uid = String(Math.floor(1000000 + Math.random() * 9000000));
  } while (store.users.some((u) => String(u.user_uid) === uid));
  return uid;
}

// Har 24 ghante ke cycle par active VIP plans ka automatic daily profit credit
function settleDueVipProfits(store) {
  const nowMs = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  let changed = false;

  for (const sub of store.vip_subscriptions) {
    if (sub.status !== 'active') continue;
    const expiresMs = new Date(sub.expires_at).getTime();
    const lastSettledMs = new Date(sub.last_profit_at || sub.created_at_iso || sub.created_at).getTime();
    const effectiveEndMs = Math.min(nowMs, expiresMs);

    if (!Number.isNaN(lastSettledMs) && effectiveEndMs > lastSettledMs) {
      const cycles = Math.floor((effectiveEndMs - lastSettledMs) / oneDayMs);
      if (cycles > 0) {
        const user = store.users.find((u) => Number(u.id) === Number(sub.user_id));
        const earned = Number((cycles * Number(sub.daily_return || 0)).toFixed(2));
        if (user && earned > 0) {
          user.balance = Number((Number(user.balance || 0) + earned).toFixed(2));
          user.today_yield = Number((Number(user.today_yield || 0) + earned).toFixed(2));
          sub.earned_total = Number((Number(sub.earned_total || 0) + earned).toFixed(2));
          changed = true;
        }
        sub.last_profit_at = new Date(lastSettledMs + cycles * oneDayMs).toISOString();
        changed = true;
      }
    }

    if (!Number.isNaN(expiresMs) && nowMs >= expiresMs && sub.status === 'active') {
      sub.status = 'completed';
      changed = true;
    }
  }

  return changed;
}

function getUserSubscriptionsWithDaysLeft(store, userId) {
  const nowMs = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  return store.vip_subscriptions
    .filter((s) => Number(s.user_id) === Number(userId))
    .map((s) => {
      const expiresMs = new Date(s.expires_at).getTime();
      const daysLeft = Number.isNaN(expiresMs)
        ? Number(s.days || 0)
        : Math.max(0, Math.ceil((expiresMs - nowMs) / oneDayMs));
      return {
        ...s,
        days_left: daysLeft
      };
    });
}

function sanitizeUser(store, user) {
  const subs = getUserSubscriptionsWithDaysLeft(store, user.id);
  const activeSub = subs.find((s) => s.status === 'active');
  const hasDeposited =
    Boolean(user.has_deposited || user.first_deposit_done) ||
    store.orders.some(
      (o) =>
        Number(o.user_id) === Number(user.id) &&
        (o.type === 'deposit' || o.order_type === 'Deposit') &&
        String(o.status).toLowerCase() === 'approved'
    );

  return {
    id: user.id,
    user_uid: user.user_uid,
    full_name: user.full_name,
    country_code: user.country_code || 'PK',
    country_flag: user.country_flag || '🇵🇰',
    dial_code: user.dial_code || '+92',
    phone: user.phone,
    ref_code: user.ref_code || user.user_uid,
    referred_by_uid: user.referred_by_uid || null,
    active_invites: Number(user.active_invites || 0),
    spins_left: Number(user.spins_left ?? 2),
    has_deposited: hasDeposited,
    pending_spin_reward: Number(user.pending_spin_reward || 0),
    channel_reward_claimed: Boolean(user.channel_reward_claimed),
    telegram_username: user.telegram_username || '',
    balance: Number(user.balance || 0),
    today_yield: Number(user.today_yield || 0),
    team_rebate: Number(user.team_rebate || 0),
    vip_level: Number(user.vip_level || 0),
    plan_days_left: activeSub ? activeSub.days_left : Number(user.plan_days_left || 0),
    created_at: format24HourTimestamp(user.created_at_iso || user.created_at)
  };
}

function getPlansForUser(store, user) {
  const invites = Number(user?.active_invites || 0);
  return store.vip_plans.map((p) => ({
    ...p,
    price: Number(p.amount),
    daily: Number(p.daily_return),
    requiresInvites: Number(p.min_invites || 0),
    unlocked: invites >= Number(p.min_invites || 0)
  }));
}

function buildUserPayload(store, user) {
  const userOrders = store.orders
    .filter((o) => Number(o.user_id) === Number(user.id))
    .slice()
    .reverse()
    .map((o) => ({
      ...o,
      order_id: o.order_code || o.order_id,
      order_type: o.order_type || (o.type === 'withdraw' ? 'Withdraw' : 'Deposit'),
      created_at: format24HourTimestamp(o.created_at_iso || o.created_at)
    }));

  return {
    token: signToken(user.id),
    user: sanitizeUser(store, user),
    vip_plans: getPlansForUser(store, user),
    subscriptions: getUserSubscriptionsWithDaysLeft(store, user.id),
    orders: userOrders,
    wallets: store.wallets,
    telegram: TELEGRAM_CONFIG
  };
}

function findUserFromRequest(store, req) {
  const tokenUid = verifyToken(req.headers.authorization || '');
  if (tokenUid) {
    const byId = store.users.find((u) => Number(u.id) === Number(tokenUid));
    if (byId) return byId;
  }
  const dialCode = String(req.body?.dialCode || req.query?.dialCode || '').trim();
  const rawPhone = String(req.body?.phone || req.query?.phone || '').trim();
  if (rawPhone) {
    const normWithDial = normalizePhone(rawPhone, dialCode);
    const normRaw = normalizePhone(rawPhone);
    return store.users.find((u) => u.phone === normWithDial || u.phone === normRaw) || null;
  }
  return null;
}

function requireAdmin(req, res, next) {
  const secret = String(
    req.headers['x-admin-secret'] || req.body?.adminSecret || req.query?.adminSecret || ''
  ).trim();
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized admin access.' });
  }
  return next();
}

// Background scheduler: har 60 second mein due 24-hour VIP profit settle karta hai
setInterval(() => {
  try {
    const store = loadStore();
    if (settleDueVipProfits(store)) {
      saveStore(store);
    }
  } catch (err) {
    console.error('24h VIP profit background job error:', err);
  }
}, 60 * 1000);

// ================= AUTH & SESSION ROUTES =================

app.post('/api/auth/register', (req, res) => {
  const fullName = String(req.body.fullName || req.body.full_name || '').trim();
  const countryCode = String(req.body.countryCode || 'PK').trim();
  const countryFlag = String(req.body.countryFlag || '🇵🇰').trim();
  const dialCode = String(req.body.dialCode || '+92').trim();
  const phone = normalizePhone(req.body.phone, dialCode);
  const password = String(req.body.password || '');
  const inviteInput = String(req.body.inviteCode || req.body.refCode || '').trim();

  if (!fullName || !phone || password.length < 4) {
    return res.status(400).json({ error: 'Full name, mobile number, and password (min 4 chars) are required.' });
  }

  const store = loadStore();
  settleDueVipProfits(store);

  if (store.users.some((u) => u.phone === phone)) {
    return res.status(400).json({ error: 'This mobile number is already registered. Please sign in.' });
  }

  let sponsor = null;
  if (inviteInput) {
    sponsor =
      store.users.find(
        (u) => String(u.user_uid) === inviteInput || String(u.ref_code || '') === inviteInput
      ) || null;
  }

  const nowIso = new Date().toISOString();
  const uid = generateUniqueUid(store);
  const newUser = {
    id: store.nextUserId++,
    user_uid: uid,
    ref_code: uid,
    referred_by_uid: sponsor ? sponsor.user_uid : null,
    full_name: fullName,
    country_code: countryCode,
    country_flag: countryFlag,
    dial_code: dialCode,
    phone,
    password_hash: hashPassword(password),
    balance: 0,
    today_yield: 0,
    team_rebate: 0,
    active_invites: 0,
    spins_left: 2,
    has_deposited: false,
    first_deposit_done: false,
    pending_spin_reward: 0,
    channel_reward_claimed: false,
    telegram_username: '',
    vip_level: 0,
    plan_days_left: 0,
    created_at_iso: nowIso,
    created_at: format24HourTimestamp(nowIso)
  };

  store.users.push(newUser);
  saveStore(store);

  return res.json(buildUserPayload(store, newUser));
});

app.post('/api/auth/login', (req, res) => {
  const dialCode = String(req.body.dialCode || '+92').trim();
  const phone = normalizePhone(req.body.phone, dialCode);
  const password = String(req.body.password || '');

  const store = loadStore();
  settleDueVipProfits(store);

  const user = store.users.find((u) => u.phone === phone);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid mobile number or password.' });
  }

  saveStore(store);
  return res.json(buildUserPayload(store, user));
});

app.post('/api/auth/session', (req, res) => {
  const store = loadStore();
  const changed = settleDueVipProfits(store);
  const user = findUserFromRequest(store, req);
  if (!user) {
    if (changed) saveStore(store);
    return res.status(404).json({ error: 'Session not found.' });
  }
  if (changed) saveStore(store);
  return res.json(buildUserPayload(store, user));
});

app.get('/api/user/profile', (req, res) => {
  const store = loadStore();
  const changed = settleDueVipProfits(store);
  const user = findUserFromRequest(store, req);
  if (!user) {
    if (changed) saveStore(store);
    return res.status(401).json({ error: 'Unauthorized user.' });
  }
  if (changed) saveStore(store);
  return res.json(buildUserPayload(store, user));
});

app.get('/api/vip/plans', (req, res) => {
  const store = loadStore();
  const user = findUserFromRequest(store, req);
  return res.json({ plans: getPlansForUser(store, user) });
});

// ================= VIP PLANS & HARVEST ROUTES =================

function handlePlanActivation(req, res) {
  const level = Number(req.body.level || req.body.vip_level);
  const store = loadStore();
  settleDueVipProfits(store);

  const user = findUserFromRequest(store, req);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const plan = store.vip_plans.find((p) => Number(p.level) === level);
  if (!plan) {
    return res.status(404).json({ error: 'VIP plan not found.' });
  }

  const invites = Number(user.active_invites || 0);
  if (Number(plan.min_invites || 0) > invites) {
    return res.status(400).json({
      error: `Requires ${plan.min_invites} active inviting friends to unlock ${plan.name}.`
    });
  }

  const cost = Number(plan.amount || 0);
  if (Number(user.balance || 0) < cost) {
    return res.status(400).json({
      error: `Insufficient balance ($${Number(user.balance || 0).toFixed(2)}). Please deposit $${cost.toFixed(2)} first.`
    });
  }

  user.balance = Number((Number(user.balance || 0) - cost).toFixed(2));
  user.vip_level = Math.max(Number(user.vip_level || 0), Number(plan.level));
  user.plan_days_left = Number(plan.days || 20);

  // Held spin reward unlock (agar pehle spin khel kar vip active na tha)
  if (Number(user.pending_spin_reward || 0) > 0) {
    user.balance = Number((Number(user.balance || 0) + Number(user.pending_spin_reward || 0)).toFixed(2));
    user.pending_spin_reward = 0;
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + Number(plan.days || 20) * 24 * 60 * 60 * 1000).toISOString();

  store.vip_subscriptions.push({
    id: store.nextSubId++,
    user_id: user.id,
    user_uid: user.user_uid,
    vip_level: Number(plan.level),
    plan_name: plan.name,
    amount: cost,
    days: Number(plan.days || 20),
    daily_return: Number(plan.daily_return || 0),
    earned_total: 0,
    status: 'active',
    last_profit_at: nowIso,
    created_at_iso: nowIso,
    created_at: format24HourTimestamp(nowIso),
    expires_at: expiresIso
  });

  saveStore(store);
  return res.json({
    ...buildUserPayload(store, user),
    plan: {
      ...plan,
      price: cost,
      daily: Number(plan.daily_return || 0)
    },
    message: `${plan.name} activated! Daily profit $${Number(plan.daily_return || 0).toFixed(2)} every 24h.`
  });
}

app.post('/api/plans/activate', handlePlanActivation);
app.post('/api/vip/activate', handlePlanActivation);

app.post('/api/rewards/claim', (req, res) => {
  const store = loadStore();
  const changed = settleDueVipProfits(store);
  const user = findUserFromRequest(store, req);
  if (!user) {
    if (changed) saveStore(store);
    return res.status(404).json({ error: 'User not found.' });
  }

  const activeSubs = store.vip_subscriptions.filter(
    (s) => Number(s.user_id) === Number(user.id) && s.status === 'active'
  );
  if (!activeSubs.length && Number(user.vip_level || 0) <= 0) {
    if (changed) saveStore(store);
    return res.status(400).json({ error: 'Activate a VIP plan first!' });
  }

  const claimedAmount = Number(Number(user.today_yield || 0).toFixed(2));
  if (changed) saveStore(store);

  return res.json({
    claimedAmount,
    ...buildUserPayload(store, user)
  });
});

// ================= SPIN & CHANNEL REWARD ROUTES =================

app.post('/api/spin/play', (req, res) => {
  const store = loadStore();
  settleDueVipProfits(store);

  const user = findUserFromRequest(store, req);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const hasDeposited =
    Boolean(user.has_deposited || user.first_deposit_done) ||
    store.orders.some(
      (o) =>
        Number(o.user_id) === Number(user.id) &&
        (o.type === 'deposit' || o.order_type === 'Deposit') &&
        String(o.status).toLowerCase() === 'approved'
    );

  if (!hasDeposited) {
    return res.status(400).json({ error: 'Deposit required before playing Lucky Spin.' });
  }
  if (Number(user.spins_left || 0) <= 0) {
    return res.status(400).json({ error: 'No spins left. Invite depositing friends for +1 spin.' });
  }

  const pool = [0.2, 0.3, 0.5, 0.7];
  const reward = pool[Math.floor(Math.random() * pool.length)];
  user.spins_left = Number(user.spins_left) - 1;

  if (Number(user.vip_level || 0) > 0) {
    user.balance = Number((Number(user.balance || 0) + reward).toFixed(2));
  } else {
    user.pending_spin_reward = Number((Number(user.pending_spin_reward || 0) + reward).toFixed(2));
  }

  saveStore(store);
  return res.json({
    reward,
    message: `Won $${reward.toFixed(2)}!`,
    ...buildUserPayload(store, user)
  });
});

app.post('/api/rewards/channel-join', (req, res) => {
  const store = loadStore();
  settleDueVipProfits(store);

  const user = findUserFromRequest(store, req);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.channel_reward_claimed) {
    return res.status(400).json({ error: 'Channel reward already claimed.' });
  }

  const tgUsername = String(req.body.telegramUsername || req.body.telegram_username || '').trim();
  if (!tgUsername) {
    return res.status(400).json({ error: 'Please enter your Telegram @username.' });
  }

  user.channel_reward_claimed = true;
  user.telegram_username = tgUsername;
  user.balance = Number((Number(user.balance || 0) + 0.5).toFixed(2));

  saveStore(store);
  return res.json({
    reward: 0.5,
    ...buildUserPayload(store, user)
  });
});

// ================= DEPOSIT & WITHDRAW ORDERS (24-HOUR TIME) =================

app.post('/api/orders/deposit', (req, res) => {
  const store = loadStore();
  settleDueVipProfits(store);

  const user = findUserFromRequest(store, req);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const amount = Number(req.body.amount);
  const network = String(req.body.network || 'TRC20').trim().toUpperCase();
  const proofData = String(req.body.proofData || req.body.proof_data || '').trim();

  if (!Number.isFinite(amount) || amount < 10) {
    return res.status(400).json({ error: 'Minimum deposit is $10.00.' });
  }
  if (!proofData) {
    return res.status(400).json({ error: 'Payment screenshot is required.' });
  }

  const nowIso = new Date().toISOString();
  const createdAt24h = format24HourTimestamp(nowIso);
  const orderCode = `DEP-${String(store.nextOrderId).padStart(5, '0')}`;

  const order = {
    id: store.nextOrderId++,
    order_code: orderCode,
    order_id: orderCode,
    user_id: user.id,
    user_uid: user.user_uid,
    type: 'deposit',
    order_type: 'Deposit',
    network,
    amount: Number(amount.toFixed(2)),
    proof_data: proofData,
    status: 'pending',
    created_at_iso: nowIso,
    created_at: createdAt24h
  };

  store.orders.push(order);
  saveStore(store);

  return res.json({
    orderId: orderCode,
    createdAt: createdAt24h,
    order,
    ...buildUserPayload(store, user)
  });
});

app.post('/api/orders/withdraw', (req, res) => {
  const store = loadStore();
  settleDueVipProfits(store);

  const user = findUserFromRequest(store, req);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const amount = Number(req.body.amount);
  const network = String(req.body.network || 'TRC20').trim().toUpperCase();
  const walletAddress = String(req.body.address || req.body.wallet_address || '').trim();

  if (!Number.isFinite(amount) || amount < 10) {
    return res.status(400).json({ error: 'Minimum withdrawal is $10.00.' });
  }
  if (!walletAddress) {
    return res.status(400).json({ error: 'Destination wallet address is required.' });
  }
  if (Number(user.balance || 0) < amount) {
    return res.status(400).json({ error: 'Insufficient balance for withdrawal.' });
  }

  user.balance = Number((Number(user.balance || 0) - amount).toFixed(2));

  const nowIso = new Date().toISOString();
  const createdAt24h = format24HourTimestamp(nowIso);
  const orderCode = `WDR-${String(store.nextOrderId).padStart(5, '0')}`;

  const order = {
    id: store.nextOrderId++,
    order_code: orderCode,
    order_id: orderCode,
    user_id: user.id,
    user_uid: user.user_uid,
    type: 'withdraw',
    order_type: 'Withdraw',
    network,
    wallet_address: walletAddress,
    amount: Number(amount.toFixed(2)),
    status: 'pending',
    created_at_iso: nowIso,
    created_at: createdAt24h
  };

  store.orders.push(order);
  saveStore(store);

  return res.json({
    orderId: orderCode,
    createdAt: createdAt24h,
    order,
    ...buildUserPayload(store, user)
  });
});

// ================= SUPPORT CHAT ROUTES (24-HOUR TIME) =================

app.get('/api/support/messages', (req, res) => {
  const store = loadStore();
  const user = findUserFromRequest(store, req);
  if (!user) return res.json({ messages: [] });

  const msgs = store.support_messages
    .filter((m) => Number(m.user_id) === Number(user.id))
    .map((m) => ({
      ...m,
      created_at: format24HourTimestamp(m.created_at_iso || m.created_at)
    }));

  return res.json({ messages: msgs });
});

app.post('/api/support/send', (req, res) => {
  const store = loadStore();
  const user = findUserFromRequest(store, req);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const messageText = String(req.body.message || req.body.message_text || '').trim();
  const mediaType = String(req.body.mediaType || 'none');
  const mediaData = String(req.body.mediaData || '');

  if (!messageText && !mediaData) {
    return res.status(400).json({ error: 'Message or media is required.' });
  }

  const nowIso = new Date().toISOString();
  store.support_messages.push({
    id: store.nextMsgId++,
    user_id: user.id,
    user_uid: user.user_uid,
    sender: 'user',
    message: messageText,
    message_text: messageText,
    media_type: mediaData ? mediaType : 'none',
    media_data: mediaData || '',
    created_at_iso: nowIso,
    created_at: format24HourTimestamp(nowIso)
  });

  saveStore(store);
  const msgs = store.support_messages
    .filter((m) => Number(m.user_id) === Number(user.id))
    .map((m) => ({
      ...m,
      created_at: format24HourTimestamp(m.created_at_iso || m.created_at)
    }));

  return res.json({ messages: msgs });
});

app.post('/api/support/messages', (req, res) => {
  req.url = '/api/support/send';
  app.handle(req, res);
});

// ================= ADMIN ROUTES (SEARCH, BALANCE EDIT, PLAN EDIT, AUTO INVITE COMMISSION) =================

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const store = loadStore();
  const changed = settleDueVipProfits(store);
  if (changed) saveStore(store);

  const users = store.users.map((u) => sanitizeUser(store, u));
  const orders = store.orders
    .slice()
    .reverse()
    .map((o) => ({
      ...o,
      order_id: o.order_code || o.order_id,
      order_type: o.order_type || (o.type === 'withdraw' ? 'Withdraw' : 'Deposit'),
      created_at: format24HourTimestamp(o.created_at_iso || o.created_at)
    }));

  const messages = store.support_messages
    .slice()
    .reverse()
    .map((m) => ({
      ...m,
      created_at: format24HourTimestamp(m.created_at_iso || m.created_at)
    }));

  return res.json({
    users,
    orders,
    plans: store.vip_plans,
    subscriptions: getUserSubscriptionsWithDaysLeft(store, 0),
    all_subscriptions: store.vip_subscriptions,
    messages
  });
});

app.post('/api/admin/orders/:orderId/action', requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  const action = String(req.body.action || '').toLowerCase(); // 'approve' | 'reject'

  const store = loadStore();
  settleDueVipProfits(store);

  const order = store.orders.find((o) => Number(o.id) === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (String(order.status).toLowerCase() !== 'pending') {
    return res.status(400).json({ error: 'Order is already processed.' });
  }

  const user = store.users.find((u) => Number(u.id) === Number(order.user_id));
  const amount = Number(order.amount || 0);
  const isDeposit = order.type === 'deposit' || order.order_type === 'Deposit';

  if (action === 'approve') {
    order.status = 'Approved';
    if (user) {
      if (isDeposit) {
        const isFirstDeposit = !user.first_deposit_done && !user.has_deposited;
        user.balance = Number((Number(user.balance || 0) + amount).toFixed(2));
        user.has_deposited = true;
        user.first_deposit_done = true;

        // Automatic invite commission (12% rebate + active invite + spin) on first approved deposit
        if (isFirstDeposit && user.referred_by_uid) {
          const sponsor = store.users.find(
            (u) => String(u.user_uid) === String(user.referred_by_uid)
          );
          if (sponsor) {
            const rebate = Number((amount * 0.12).toFixed(2));
            sponsor.balance = Number((Number(sponsor.balance || 0) + rebate).toFixed(2));
            sponsor.team_rebate = Number((Number(sponsor.team_rebate || 0) + rebate).toFixed(2));
            sponsor.active_invites = Number(sponsor.active_invites || 0) + 1;
            sponsor.spins_left = Number(sponsor.spins_left || 0) + 1;
          }
        }
      }
    }
  } else if (action === 'reject') {
    order.status = 'Rejected';
    if (user && !isDeposit) {
      // Refund withdrawn balance on rejection
      user.balance = Number((Number(user.balance || 0) + amount).toFixed(2));
    }
  } else {
    return res.status(400).json({ error: 'Action must be approve or reject.' });
  }

  saveStore(store);
  return res.json({ order });
});

app.post('/api/admin/users/:userId/balance', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const mode = String(req.body.mode || 'set').toLowerCase();
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount)) {
    return res.status(400).json({ error: 'Valid amount is required.' });
  }

  const store = loadStore();
  const user = store.users.find((u) => Number(u.id) === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (mode === 'add') {
    user.balance = Math.max(0, Number((Number(user.balance || 0) + amount).toFixed(2)));
  } else {
    user.balance = Math.max(0, Number(amount.toFixed(2)));
  }

  saveStore(store);
  return res.json({ user: sanitizeUser(store, user) });
});

app.post('/api/admin/vip/plans/:level', requireAdmin, (req, res) => {
  const level = Number(req.params.level);
  const store = loadStore();
  const idx = store.vip_plans.findIndex((p) => Number(p.level) === level);
  if (idx === -1) return res.status(404).json({ error: 'VIP plan not found.' });

  const target = store.vip_plans[idx];
  if (req.body.name !== undefined && String(req.body.name).trim()) {
    target.name = String(req.body.name).trim();
  }
  if (req.body.amount !== undefined && Number(req.body.amount) > 0) {
    target.amount = Number(Number(req.body.amount).toFixed(2));
  }
  if (req.body.days !== undefined && Number(req.body.days) > 0) {
    target.days = Number(req.body.days);
  }
  if (req.body.daily_return !== undefined && Number(req.body.daily_return) >= 0) {
    target.daily_return = Number(Number(req.body.daily_return).toFixed(2));
  }
  if (req.body.min_invites !== undefined && Number(req.body.min_invites) >= 0) {
    target.min_invites = Number(req.body.min_invites);
  }

  saveStore(store);
  return res.json({ plans: store.vip_plans });
});

app.post('/api/admin/support/reply', requireAdmin, (req, res) => {
  const userId = Number(req.body.userId || req.body.user_id);
  const messageText = String(req.body.message || req.body.message_text || '').trim();
  if (!userId || !messageText) {
    return res.status(400).json({ error: 'userId and message are required.' });
  }

  const store = loadStore();
  const user = store.users.find((u) => Number(u.id) === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const nowIso = new Date().toISOString();
  store.support_messages.push({
    id: store.nextMsgId++,
    user_id: user.id,
    user_uid: user.user_uid,
    sender: 'admin',
    message: messageText,
    message_text: messageText,
    media_type: 'none',
    media_data: '',
    created_at_iso: nowIso,
    created_at: format24HourTimestamp(nowIso)
  });

  saveStore(store);
  return res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AUREX VAULT PRO running on port ${PORT} (JSON Store: ${STORE_FILE})`);
});