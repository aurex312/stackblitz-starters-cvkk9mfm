app.post('/api/admin/orders/:orderId/action', requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  const action = String(req.body.action || '').toLowerCase(); // 'approve' | 'reject'

  // Deposit approval ke waqt customer ke plan overrides
  const assignedVipLevel = req.body.vip_level !== undefined ? Number(req.body.vip_level) : null;
  const assignedDays = req.body.days !== undefined ? Number(req.body.days) : null;
  const assignedDailyReturn = req.body.daily_return !== undefined ? Number(req.body.daily_return) : null;

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

        // Agar admin ne approval ke waqt customer ka VIP plan / days / daily return set ya edit kiya ho
        const hasPlanOverride =
          (Number.isFinite(assignedVipLevel) && assignedVipLevel > 0) ||
          (Number.isFinite(assignedDailyReturn) && assignedDailyReturn > 0) ||
          (Number.isFinite(assignedDays) && assignedDays > 0);

        if (hasPlanOverride) {
          const basePlan =
            store.vip_plans.find((p) => Number(p.level) === Number(assignedVipLevel || user.vip_level || 1)) ||
            store.vip_plans[0] ||
            { level: 1, name: 'VIP 1', amount, days: 20, daily_return: 0 };

          const finalLevel =
            Number.isFinite(assignedVipLevel) && assignedVipLevel > 0
              ? assignedVipLevel
              : Math.max(1, Number(user.vip_level || basePlan.level || 1));

          const finalDays =
            Number.isFinite(assignedDays) && assignedDays > 0
              ? assignedDays
              : Number(basePlan.days || 20);

          const finalDailyReturn =
            Number.isFinite(assignedDailyReturn) && assignedDailyReturn >= 0
              ? Number(assignedDailyReturn.toFixed(2))
              : Number(basePlan.daily_return || 0);

          // Purani active subscription agar ho to usay replace/update karein taake duplicate daily profit na chale
          store.vip_subscriptions.forEach((s) => {
            if (Number(s.user_id) === Number(user.id) && s.status === 'active') {
              s.status = 'replaced';
            }
          });

          const nowMs = Date.now();
          const nowIso = new Date(nowMs).toISOString();
          const expiresIso = new Date(nowMs + finalDays * 24 * 60 * 60 * 1000).toISOString();

          user.vip_level = finalLevel;
          user.plan_days_left = finalDays;

          store.vip_subscriptions.push({
            id: store.nextSubId++,
            user_id: user.id,
            user_uid: user.user_uid,
            vip_level: finalLevel,
            plan_name: `VIP ${finalLevel} (Custom Approval)`,
            amount,
            days: finalDays,
            daily_return: finalDailyReturn,
            earned_total: 0,
            status: 'active',
            last_profit_at: nowIso,
            created_at_iso: nowIso,
            created_at: format24HourTimestamp(nowIso),
            expires_at: expiresIso
          });

          order.assigned_vip_level = finalLevel;
          order.assigned_days = finalDays;
          order.assigned_daily_return = finalDailyReturn;
        }
      }
    }
  } else if (action === 'reject') {
    order.status = 'Rejected';
    if (user && !isDeposit) {
      user.balance = Number((Number(user.balance || 0) + amount).toFixed(2));
    }
  } else {
    return res.status(400).json({ error: 'Action must be approve or reject.' });
  }

  saveStore(store);
  return res.json({ order });
});