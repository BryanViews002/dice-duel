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

## Option C — AWS EC2 + Elastic IP

The right AWS shape for this. An Elastic IP attached to an instance is a fixed
address that survives stop/start, reboots and redeploys.

**Do not use Fargate or Lambda for this.** Their egress is only static via a NAT
Gateway, which is ~$32/month before traffic — for a worker making a few HTTP
requests a minute. EC2 with an Elastic IP attached directly needs no NAT.

Cost: `t4g.nano` ~$3/mo + the IPv4 address charge (~$3.60/mo since AWS began
billing public IPv4). Call it ~$7/month.

### 1. Launch

- **AMI:** Amazon Linux 2023 (or Ubuntu 24.04)
- **Type:** `t4g.nano` (ARM) — the worker is almost entirely idle
- **Key pair:** create one so you can SSH
- **Security group — inbound:** SSH (22) **from your IP only**.
  Nothing else. The worker accepts no inbound traffic whatsoever; it only makes
  outbound calls to Supabase and Flutterwave. Leave outbound as the default
  allow-all.

### 2. Pin the address

EC2 → **Elastic IPs** → *Allocate* → select it → *Actions → Associate* → your
instance. **Do this before whitelisting anything.** The auto-assigned public IP
changes on stop/start; only the Elastic IP is stable.

> Keep it attached. AWS bills for an Elastic IP that is allocated but not
> associated with a running instance.

### 3. Install

```bash
ssh -i your-key.pem ec2-user@YOUR_ELASTIC_IP

sudo dnf install -y nodejs22 git    # Amazon Linux 2023
# Node 24 is preferable (native TypeScript stripping). If the distro package is
# older than 22.6, install from nodesource:
#   curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash - && sudo dnf install -y nodejs

sudo git clone https://github.com/BryanViews002/dice-duel.git /opt/dice-duel
cd /opt/dice-duel/worker
sudo cp .env.example .env
sudo nano .env                      # fill in the four variables

# one pass, to confirm it works and print the egress IP
set -a && . ./.env && set +a && WORKER_ONCE=1 node index.mjs
```

The printed egress IP should equal your Elastic IP. If it does not, the instance
is routing through a NAT — check it is in a public subnet with the EIP attached.

### 4. Keep it running

Use the systemd unit from Option A (adjust `User=` to `ec2-user` if `nobody`
cannot read the checkout), then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dice-duel-worker
journalctl -u dice-duel-worker -f
```

### 5. Whitelist

Flutterwave → **Settings → IP Whitelisting** → your Elastic IP.

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
