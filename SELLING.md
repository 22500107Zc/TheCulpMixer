# Turning Kline on for money

The goal this is built around: **you send somebody a link and that is the end
of your involvement.** They get 33 hours. Then Kline locks and shows them a
Subscribe button. They pay $199/month. Kline unlocks — on the web, on the
desktop app, on their second machine. You do nothing, ever, per customer.

Stripe holds who is paying; `api/licence.ts` asks it; the app believes the
signed answer. And there is a **founder console** at `/founder.html` — one
login, yours — for setting up Stripe and for handing somebody an account
directly, without them paying at all.

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

### 3. Two environment variables in Vercel

Your Vercel project → **Settings** → **Environment Variables**. Add these for
**Production**:

| Name | Value |
|---|---|
| `KLINE_SIGNING_KEY` | The entire contents of `kline-private-key.pem`, including the `-----BEGIN` and `-----END` lines. |
| `KLINE_FOUNDER_HASH` | Run `node tools/kline-founder.mjs "your password"` and paste the line it prints. |

Then **Redeploy**.

`KLINE_SIGNING_KEY` is the only thing that can mint a licence. Paste it into
Vercel and nowhere else. It is not in this repository and must never be.

`KLINE_FOUNDER_HASH` is your founder password, hashed. **Your password itself
never goes in the repository**, because this repository is readable and the
founder console can issue licences and see every customer you have — a password
in the source is a password every reader of the source has. The hash is safe to
paste into Vercel and cannot be turned back into the password.

The Stripe key and price ID can go here too, as `STRIPE_SECRET_KEY` and
`KLINE_PRICE_ID` — or you can just type them into the founder console in the
next step, which is easier. If you set them here, here wins.

### 4. Optional, but do it: a trial clock that cannot be reset

Without this, the 33-hour clock lives in the visitor's browser, and clearing
site data gives them another 33 hours, for ever.

Vercel project → **Storage** → **Create** → any Upstash-compatible Redis (the
free tier is plenty). Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`
automatically. The server picks them up on the next deploy and starts keeping
the clock itself. Nothing else changes.

---

## The founder console

Once step 3 is deployed, go to **`https://kline-flax.vercel.app/founder.html`**
and sign in with your password.

From there you can:

**Set up Stripe** — paste your secret key and the `price_...` from step 2, press
Save, and the Subscribe button starts working. The key is stored in your KV and
never shown again, not even back to you.

**Make somebody an account** — type their email, pick a length (1 month, 12
months, never expires), and press Create. Leave the password box empty and one
is made for them.

The console then shows you a block of text with their email and password in it
and a **Copy** button. Send them that. They open Kline, go to **Help ▸
Licence**, type the email and password, press Sign in, and they are working.

That unlocks Kline **without them paying Stripe** — a partner, a reviewer,
somebody who paid you by bank transfer, a friend, yourself. It is shown once:
the server stores only a hash of the password and genuinely cannot tell anybody
what it was afterwards. If it gets lost, press **New password** on their row
and send them the new block.

**Take an account away** — press Remove. They lose access within a week (the
offline lease has to run out first).

**See everyone who has an account**, when it runs out, and your own note about
who they are.

The 33-hour trial is **not** adjustable from the console, on purpose. It is
fixed in the application and in the server so it cannot be widened by accident
or by anyone who ever gets into the console.

### Keeping the console yours

- The password is checked against a hash. Getting it wrong tells you nothing
  useful and takes the same time every attempt.
- A session lasts 12 hours and is signed. A forged or expired one is refused.
- Changing the password signs every open console out immediately.
- The page is never indexed by search engines and cannot be put in a frame.
- If `KLINE_FOUNDER_HASH` is missing, the console refuses **every** login
  rather than falling open.

If you ever think the password has got out: run `tools/kline-founder.mjs` with
a new one, replace the variable in Vercel, redeploy. That is the whole rotation.

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

You are never charged for Kline and never have to be. Three separate ways, any
one of which is enough:

- Running it from source (`npm run dev`) is never gated at all.
- Make yourself an account in the founder console with your own email, set to
  **never expires**. Then in Kline: **Help ▸ Licence**, type your email.
- Or mint a perpetual key once and apply it under **Have a licence key?**:

  ```bash
  node tools/kline-licence.mjs owner --name "Your Name"
  ```

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

- `not-selling-yet` — no Stripe key or price ID, in Vercel or in the console.
- `no-signing-key` — `KLINE_SIGNING_KEY` is missing. Until it is set, nobody
  can be unlocked by paying, so fix this one first.
- `no-founder-password` — `KLINE_FOUNDER_HASH` is missing, so the console
  cannot be signed into by anybody, including you.
- `no-storage` — no KV store, so accounts cannot be saved. Add one in Vercel
  under Storage.

Check with:

```bash
curl -s -X POST https://kline-flax.vercel.app/api/licence \
  -H 'Content-Type: application/json' \
  -d '{"action":"state","install":"test-install-1"}'
```

A healthy server answers `{"status":"trial","endsAt":...}`.
