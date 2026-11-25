<p align="center"><img src="assets/logo.svg" alt="DEV Lottery" width="420"></p>

# DEV Lottery

**Same hustle. Different spawn point.**

DEV Lottery measures how unequal the starting line is for software developers and indie hackers, country by country — built in one zero-dependency HTML file (`EN / AR`).

- **Birth Lottery**: spin to respawn using real UN birth odds, scratch your ticket, or click **Spin until «Easy»** to challenge friends.
- **"Start From Zero" Simulator**: test the classic 4-step indie hacker playbook from your passport vs. the Netherlands — paying an `$80/mo` AI stack, connecting Stripe (or Stripe-only hackathons like TrustMRR), flying to Bali, and attending a San Francisco tech conference — then export a **Split VS Card PNG** for X.
- **Hard Mode Survival Guide & Builders Community**: practical country-specific payout & tool-tax playbooks, easier launchpads beyond the US & Western Europe, Easy Mode reference profiles (`Pieter Levels`, `Marc Lou`, `Danny Postma`, `AJ`), and a built-in database-backed community wall where developers publish their profile, spawn mode, project, and workarounds.
- **Verified Voices on the Ovarian Lottery**: documented quotes from Warren Buffett, Sam Altman, and Bill Gates.
- **Starting Line Index**: compare any 2 of **35 countries** (covering ~63% of world births), filter by difficulty (`Easy`, `Normal`, `Hard`, `Nightmare`), and switch between Cards and Table views.

> Not affiliated with the U.S. Diversity Visa (DV) program. This site offers no visa services.

## The score (0–100)

| Indicator | Weight | What it measures | Source |
| --- | --- | --- | --- |
| EARN | 40% | Can you receive money from abroad? `100` = Direct Stripe, `75` = Restricted/local partner (Paystack, Invite-only Preview), `60` = PayPal receives, `30` = Paddle only, `0` = Sanctioned / none | stripe.com/global, Paddle countries, PayPal docs |
| BUY | 40% | Work hours for a `$20/month` tool (and `$80/month` AI stack in the simulator), at **market** FX where parallel rates exist, log-scaled between fixed goalposts (`0.38h` best, `71h` worst) | World Bank GNI per capita ÷ 12, market FX |
| MOVE | 20% | Visa-free destinations (`23–192` scale) + Bali entry rules & US ESTA eligibility | Henley Passport Index 2026 |

Tiers: **Easy** (`75+`), **Normal** (`50–74`), **Hard** (`25–49`), **Nightmare** (`0–24`).  
Draw weights: annual live births 2024, UN World Population Prospects 2024.

## Features (v2)

- Bilingual **English / Arabic** (`EN / AR`) with auto-detection and `?lang=en|ar` deep links
- **Start From Zero Simulator** with 4 interactive steps & **Split VS Card PNG** export (`1200×675`)
- **35 countries** including China, Russia, and major global indie hacker hubs (Brazil, Indonesia, Philippines, Turkey, Poland, Ukraine, Mexico, Kenya, UAE, Saudi Arabia, Lebanon, plus original 22)
- Shareable comparison URLs (`?a=DZA&b=NLD`) and challenge URLs (`#challenge-ISO-N`)
- Optional zero-dependency global draw counter in `counter/`

## Deploy on Coolify (Recommended — Full Stack)

The root `Dockerfile` (`node:22-alpine`) + `server.js` runs the complete app (static frontend + zero-dependency Node API + built-in **SQLite** database in `/data/devlottery.sqlite` for draws, salutes, builder profiles, and upvotes + live SVG badges at `/badge/:iso.svg`):

1. In Coolify, create a **New Resource → Public/Private Git Repository** pointing to this repo.
2. Choose **Build Pack: Dockerfile** (Base directory: `/`, Port: `3000`).
3. Add a **Persistent Storage Volume** mounted at `/data` so the SQLite database survives redeploys.
4. Deploy! Endpoints ready out of the box: `/api/builders`, `/api/builders/:id/vote`, `/api/count`, `/api/salute`, `/badge/DZA.svg`, `/health`.

## Run locally

```bash
node server.js             # full stack on http://localhost:3000
# or open index.html directly (falls back to localStorage)
```
