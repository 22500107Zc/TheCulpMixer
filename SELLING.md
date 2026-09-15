# Turning The Culp Mixer on for money

**How it works, end to end:**

1. You send somebody the link.
2. They land on the home page. Username, email, password. No confirmation
   email, nothing to click — they are in.
3. **33 hours**, counting down in the corner where they can see it.
4. It runs out. The Culp Mixer locks and shows them your payment link.
5. They pay and tell you which address they paid from.
6. You open `/founder.html`, find them, press **Mark paid**. They are back in.

No Stripe API key, no webhooks, no integration. One person runs The Culp Mixer and one
person presses the button.

---

## Setting it up, once

### 1. Two environment variables in Vercel

Project → **Settings** → **Environment Variables**, for **Production**:

| Name | Value |
|---|---|
| `KLINE_SIGNING_KEY` | The entire contents of `kline-private-key.pem`, including the `-----BEGIN` and `-----END` lines. |
| `KLINE_FOUNDER_HASH` | Run `node tools/kline-founder.mjs "your password"` and paste the line it prints. |

The founder login is **culpindustriesllc@gmail.com** plus that password. The
address is built in, so there is nothing to set for it. To move it later, add
`KLINE_FOUNDER_EMAIL` — the old address stops working the moment you do.

`KLINE_SIGNING_KEY` is the only thing that can mint a licence. It is not in
this repository and must never be.

`KLINE_FOUNDER_HASH` is your founder password, hashed. **The password itself
never goes in the repository** — this repository is readable, and the founder
console can let people in and see every customer you have. The hash is safe to
paste into Vercel and cannot be turned back into the password.

### 2. Supabase — where accounts live

**This one is not optional.** Without it there is nowhere to put accounts, so
nobody can sign up and nobody is gated — everyone who opens your link gets in
free. Do this before you send the link to anybody.

Free tier, and it is a real database you can open and look at.

**a.** Make a project at https://supabase.com — free, takes a minute.

**b.** In your project: **SQL Editor** → **New query** → paste this and Run:

```sql
create table if not exists kline_kv (
  key   text primary key,
  value text not null
);

-- Nothing but the server touches this. The service role key bypasses RLS;
-- turning RLS on with no policies means a leaked anon key reads nothing.
alter table kline_kv enable row level security;
```

**c.** **Project Settings** → **API**, and copy two things into Vercel
(Settings → Environment Variables, Production):

| Name | Where it comes from |
|---|---|
| `SUPABASE_URL` | Project URL — `https://xxxxxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **service_role** key, under Project API keys |

Use the **service_role** key, not the `anon` one. It only ever lives in Vercel
— it is never sent to a browser and is not in this repository.

**d.** Redeploy.

The console shows `Supabase is connected` once it is working.

### 3. Redeploy

### 4. A payment link

Anywhere that takes money: a Stripe payment link, PayPal, Buy Me a Coffee. Make
it $199/month.

Then go to **`https://kline-flax.vercel.app/founder.html`**, sign in, and paste
it into **Where people pay**. That is the button your customers see when their
33 hours are up.

---

## The founder console

**https://kline-flax.vercel.app/founder.html** — a different page from the app.
Signing in on the app's own home page will not get you in there; that form is
for customers and your founder login is not a customer account.

**culpindustriesllc@gmail.com** and your founder password.
Both are checked, and a wrong one of either gets the same message, so nobody
guessing learns they had the address right.

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

You are never charged for The Culp Mixer. Three ways, any one is enough:

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

- `no-storage` — Supabase is not connected. Nobody can sign up and nobody is
  gated. Fix this first: step 2.
- `no-signing-key` — `KLINE_SIGNING_KEY` is missing. Nobody can be let in
  until it is set.
- `no-founder-password` — `KLINE_FOUNDER_HASH` is missing, so the console
  cannot be opened by anybody, including you.

## Is it working? Open this in a browser

**https://kline-flax.vercel.app/api/account**

That is the whole check. It answers with what is set up and what is not:

```json
{ "ready": true, "storage": true, "store": "Supabase",
  "signingKey": true, "paymentLink": true, "trialHours": 33, "missing": [] }
```

- **A 404 page instead of JSON** — the API is not deployed. Redeploy.
- **`"ready": false`** — `missing` names exactly what to go and set.
- **`"ready": true`** — you are selling.

Nothing secret is in that answer, only yes/no.

**Until `ready` is true, everyone who opens your link uses The Culp Mixer for
free.**
