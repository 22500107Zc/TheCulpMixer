# Turning Kline on for money

**How it works, end to end:**

1. You send somebody the link.
2. They land on the home page. Username, email, password. No confirmation
   email, nothing to click — they are in.
3. **33 hours**, counting down in the corner where they can see it.
4. It runs out. Kline locks and shows them your payment link.
5. They pay and tell you which address they paid from.
6. You open `/founder.html`, find them, press **Mark paid**. They are back in.

No Stripe API key, no webhooks, no integration. One person runs Kline and one
person presses the button.

---

## Setting it up, once

### 1. Two environment variables in Vercel

Project → **Settings** → **Environment Variables**, for **Production**:

| Name | Value |
|---|---|
| `KLINE_SIGNING_KEY` | The entire contents of `kline-private-key.pem`, including the `-----BEGIN` and `-----END` lines. |
| `KLINE_FOUNDER_HASH` | Run `node tools/kline-founder.mjs "your password"` and paste the line it prints. |

`KLINE_SIGNING_KEY` is the only thing that can mint a licence. It is not in
this repository and must never be.

`KLINE_FOUNDER_HASH` is your founder password, hashed. **The password itself
never goes in the repository** — this repository is readable, and the founder
console can let people in and see every customer you have. The hash is safe to
paste into Vercel and cannot be turned back into the password.

### 2. A place to keep accounts

Vercel project → **Storage** → **Create** → any Upstash-compatible Redis. The
free tier is plenty. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for
you.

**This one is not optional.** Without it there is nowhere to put accounts and
Kline will say so rather than pretending to save them.

### 3. Redeploy

### 4. A payment link

Anywhere that takes money: a Stripe payment link, PayPal, Buy Me a Coffee. Make
it $199/month.

Then go to **`https://kline-flax.vercel.app/founder.html`**, sign in, and paste
it into **Where people pay**. That is the button your customers see when their
33 hours are up.

---

## The founder console

`/founder.html`, your password.

**Everyone** — every account, whether they signed themselves up or you made it.
For each: their username and email, whether they are in trial / waiting to pay /
paid, and **the same countdown they are looking at**. When somebody messages you
saying "I have two hours left", you can check.

**Mark paid** — the whole payment system. One month by default. They are back in
immediately, on the login they already have.

**Revoke** — turns them off without deleting anything. Their login still works;
they are simply back to needing to pay.

**Make an account for somebody** — for when you want to create one yourself
rather than have them sign up. It is switched on immediately: no trial, no
payment. The console hands you their email and password to send, once.

**New password** — if they lose theirs. Shown once; only a hash is stored, so
nothing can tell you the old one.

**Paid from a different address than they signed up with?** Make them an account
on the address that paid. One account covers their whole team, so that is fine
rather than a problem.

The 33 hours cannot be changed from the console, on purpose — it is fixed in
both the application and the server so it cannot be widened by accident or by
anyone who ever gets into the console.

### Keeping the console yours

- The password is checked against a hash. A wrong one tells you nothing useful
  and takes the same time every attempt.
- Sessions last 12 hours and are signed; a forged or expired one is refused.
- Changing the password signs every open console out immediately.
- Never indexed by search engines, never loadable in a frame.
- No `KLINE_FOUNDER_HASH` means **every** login is refused, rather than the
  console falling open.

To change the password: run `tools/kline-founder.mjs` with a new one, replace
the variable in Vercel, redeploy.

---

## Your own copy

You are never charged for Kline. Three ways, any one is enough:

- Running from source (`npm run dev`) is never gated at all.
- Make yourself an account in the console — it is paid from the moment it
  exists. Set it to **never expires**.
- Or mint a perpetual key: `node tools/kline-licence.mjs owner --name "You"`,
  then **Help ▸ Licence ▸ Have a licence key?**

## What it costs to run

- Vercel: free tier is fine. One small request per launch.
- Upstash: free tier, a few keys per customer.
- Payment link: whatever your processor charges. Stripe is 2.9% + 30¢, so on
  $199 you keep about **$192.93**.

## If something is wrong

Nobody is locked out by an outage. No network, server down, store unreachable —
the last good answer stands, and a paid account keeps working offline for a
week.

Misconfiguration says so rather than guessing:

- `no-storage` — no KV store. Accounts cannot be saved. Fix this first.
- `no-signing-key` — `KLINE_SIGNING_KEY` is missing. Nobody can be let in
  until it is set.
- `no-founder-password` — `KLINE_FOUNDER_HASH` is missing, so the console
  cannot be opened by anybody, including you.

Check the server is alive:

```bash
curl -s -X POST https://kline-flax.vercel.app/api/account \
  -H 'Content-Type: application/json' -d '{"action":"refresh","session":""}'
```

A healthy server answers `{"error":"sign-in-again"}` — it is up and it has
storage. `no-storage` means step 2 is not done.
