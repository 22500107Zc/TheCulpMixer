# Turning Kline on for money

The goal this is built around: **you send somebody a link and that is the end
of your involvement.** They get 33 hours. Then Kline locks and shows them a
Subscribe button. They pay $199/month. Kline unlocks — on the web, on the
desktop app, on their second machine. You do nothing, ever, per customer.

There is no admin panel because there is nothing to administer. Stripe holds
who is paying; `api/licence.ts` asks it; the app believes the signed answer.

---

## The four things to do, once

Everything below is done in a browser. It takes about fifteen minutes.

### 1. A Stripe account

https://dashboard.stripe.com/register

This is the one step nobody can do for you. Taking recurring card payments
means a payment processor, and every processor in the world verifies who is
receiving the money before it releases it — name, address, and a bank account
to pay out to. There is no version of accepting $199/month from strangers that
skips this. Budget a day or two for Stripe's review; you can build and test
everything else immediately in **test mode**, which needs no verification at
all.

### 2. A $199/month price

Stripe dashboard → **Product catalogue** → **Add product**.

- Name: `Kline`
- Price: `199.00` USD, **Recurring**, **Monthly**
- Save, then copy the **price ID**. It looks like `price_1Qx...`.

### 3. Three environment variables in Vercel

Your Vercel project → **Settings** → **Environment Variables**. Add these three
for **Production**:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | From Stripe → Developers → API keys. `sk_live_...` when you are live, `sk_test_...` while testing. |
| `KLINE_PRICE_ID` | The `price_...` from step 2. |
| `KLINE_SIGNING_KEY` | The entire contents of `kline-private-key.pem`, including the `-----BEGIN` and `-----END` lines. |

Then **Redeploy**.

`KLINE_SIGNING_KEY` is the same key that signs licences by hand. Paste it into
Vercel and nowhere else. It is not in this repository and must never be — it is
the only thing that can mint a licence, and if it leaks, anybody can.

### 4. Optional, but do it: a trial clock that cannot be reset

Without this, the 33-hour clock lives in the visitor's browser, and clearing
site data gives them another 33 hours, for ever.

Vercel project → **Storage** → **Create** → any Upstash-compatible Redis (the
free tier is plenty). Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`
automatically. The server picks them up on the next deploy and starts keeping
the clock itself. Nothing else changes.

---

## Then you are selling

Send anybody `https://kline-flax.vercel.app`, or a link to the installers on
the releases page. From there:

1. They use Kline for 33 hours. A chip in the status bar counts it down and
   says `$199/month` the whole time.
2. It locks. Full screen, no way past, **Subscribe — $199/month**.
3. They pay on Stripe's own page. Card details never touch your code.
4. They land back in Kline, unlocked, within a second or two.
5. Next month Stripe charges them again. If it fails, or they cancel, Kline
   locks again within a week.

On another machine, or after reinstalling, they open **Help ▸ Licence** and
type the email they paid with. That is the only support question this design
can generate, and the answer is on the screen already.

## Your own copy

You are never charged for Kline and never have to be.

- Running it from source (`npm run dev`) is never gated at all.
- For the shipped apps, mint yourself a key once:

  ```bash
  node tools/kline-licence.mjs owner --name "Your Name"
  ```

  Then **Help ▸ Licence → Have a licence key? → Apply key**. It never expires.

## Checking it works before a real customer does

Use Stripe **test mode** (`sk_test_...` and a test-mode price ID). Card
`4242 4242 4242 4242`, any future expiry, any CVC. Pay, and watch Kline unlock.
Then switch both values to the live ones and redeploy.

To see where a build thinks it stands without waiting 33 hours, open
**Help ▸ Licence**.

## What it costs you to run

- Vercel: the free tier covers this comfortably. The licence call is one small
  request per launch.
- Upstash: free tier, one key per install.
- Stripe: 2.9% + 30¢ per payment. On $199 that is about **$6.07**, so you keep
  roughly **$192.93** per subscriber per month.

## If something is wrong

The app never locks somebody out because of an outage. No network, server down,
Stripe down — all of them leave the last good answer standing, and a paid
licence keeps working offline for a week.

If the server is misconfigured it says so rather than guessing:

- `not-selling-yet` — `STRIPE_SECRET_KEY` or `KLINE_PRICE_ID` is missing.
- `no-signing-key` — `KLINE_SIGNING_KEY` is missing. Until it is set, nobody
  can be unlocked by paying, so fix this one first.

Check with:

```bash
curl -s -X POST https://kline-flax.vercel.app/api/licence \
  -H 'Content-Type: application/json' \
  -d '{"action":"state","install":"test-install-1"}'
```

A healthy server answers `{"status":"trial","endsAt":...}`.
