# Deploying the payout worker

The worker is the **only** component that calls Flutterwave's Transfers API, so
its egress IP is the only address you ever whitelist.

> **The one thing that matters:** the host must have a *stable* outbound IP.
> Not "an IP" — every host has one — but the same one after a restart, a
> redeploy, and a scale event. If it changes, payouts start failing at random,
> which is far worse than failing consistently.
>
> The worker prints its egress IP on startup. **Restart it twice and confirm the
> address is identical before you rely on it.**

---

## Option A — a plain VPS (most certain, ~$4–6/month)

A basic droplet gets you a dedicated IPv4 that does not change. Hetzner CX22,
DigitalOcean, Vultr, Linode — any of them.

```bash
# on the server, as root
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git

git clone https://github.com/BryanViews002/dice-duel.git /opt/dice-duel
cd /opt/dice-duel/worker
cp .env.example .env        # then fill it in

# confirm it runs and note the egress IP it prints
set -a && . ./.env && set +a && WORKER_ONCE=1 node index.mjs
```

Then keep it alive with systemd:

```ini
# /etc/systemd/system/dice-duel-worker.service
[Unit]
Description=Dice Duel payout worker
After=network-online.target

[Service]
WorkingDirectory=/opt/dice-duel/worker
EnvironmentFile=/opt/dice-duel/worker/.env
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now dice-duel-worker
journalctl -u dice-duel-worker -f      # watch it; the egress IP is in the first lines
```

---

## Option B — Railway (easier, but check the IP)

The `Dockerfile` lives at the **repo root**, not in `worker/`. Railway only
auto-detects a Dockerfile at the service root — a custom `dockerfilePath` in
`railway.json` is not reliably honoured, and the build silently falls through to
language auto-detection, which fails with:

    Railpack could not determine how to build the app

The root location also gives the build the context it needs, since the worker
imports `web/src/lib/money.ts`.

1. Railway → **New Project → Deploy from GitHub repo** → pick `dice-duel`.
2. Leave Root Directory **empty**. The build context must be the repo root.
3. **Variables** → add the four below.
4. Deploy, then open **Logs** and find:
   `[worker] egress IP x.x.x.x — whitelist THIS with Flutterwave`
5. **Redeploy once and check the IP again.** On Railway, stable outbound IPs are
   a paid workspace feature — if the address changes between deploys you need
   static egress on your plan, or Option A instead.

If you would rather keep the Dockerfile inside `worker/`, the supported
alternative is a service variable `RAILWAY_DOCKERFILE_PATH=worker/Dockerfile`.

---

## Environment

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...        # bypasses RLS; server-side only
FLW_SECRET_KEY=FLWSECK_TEST-...      # start in TEST mode
FLW_TRANSFER_CALLBACK_URL=https://your-domain/api/flutterwave/webhook
```

The service role key is required: `claim_withdrawals`, `mark_withdrawal_sent`
and `settle_withdrawal` are revoked from `authenticated` on purpose, because a
player who could call them could mark their own paid payout failed and be
refunded money they already hold.

---

## Then whitelist it

Flutterwave → **Settings → IP Whitelisting** → add the address from the logs.
Transfers stay rejected until you do; the app handles that correctly (the payout
is refused up front and the funds returned), but nothing will actually pay out.

---

## Checking it works

```bash
# queue depth — should sit at 0 when the worker is keeping up
curl -s "$SUPABASE_URL/rest/v1/withdrawals?select=reference,status&status=in.(requested,processing)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Healthy logs look like:

```
[send] dd-wd-xxxx NGN 950 -> Forrest Green (044/0031)
[send] dd-wd-xxxx accepted as NEW (transfer 12345)
[reconcile] dd-wd-xxxx SUCCESSFUL -> paid
```

**Worth alerting on:** rows sitting in `processing` for more than a few minutes,
and any `[reconcile] ... unreachable` line repeating. Neither loses money — the
design refuses to guess — but both mean payouts have quietly stopped moving, and
you want to hear about that from a monitor rather than from a player.

## Scaling

Run as many instances as you like. `claim_withdrawals` uses
`FOR UPDATE SKIP LOCKED`, so two workers cannot claim the same row, and
`reference` is Flutterwave's idempotency key behind that. One instance is
plenty for a long time.
