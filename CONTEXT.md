# WickED Trading Platform — Session Context

## What is WickED?
A personal trading intelligence platform built from scratch. Consists of:
- **Railway server** — Node.js, runs all scanners 24/7, REST API for data sync
- **Cloudflare Pages** — hosts the WickED dashboard (static HTML)
- **Cloudflare Worker** — proxies Polygon API, supports daily + intraday candles
- **Telegram bot** — receives all scanner alerts on phone
- **Polygon.io** — market data provider (Stocks Starter plan)

---

## Infrastructure

| Service | URL / Value |
|---|---|
| Railway server | `https://bull-flag-scalper-production.up.railway.app` |
| Railway health | `https://bull-flag-scalper-production.up.railway.app/health` |
| Cloudflare Pages | `https://bull-flag-scalper.pages.dev/index.html` |
| Cloudflare Worker | `https://steep-morning-ce86.mattsimms46.workers.dev` |
| GitHub repo | `mattsimms46/bull-flag-scalper` |
| Polygon API key | `GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H` |
| Telegram bot token | `8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU` |
| Telegram chat ID | `8446284130` |
| API secret | `wicked-secret-change-me` |
| Railway PORT | `8080` |

---

## GitHub Repo File Structure

```
bull-flag-scalper/
├── scanner-server.js    ← ALL-IN-ONE: Scalp + ORB + Reversal + API + Recap
├── index.html           ← WickED dashboard (was wicked-dashboard.html)
├── manifest.json        ← PWA manifest
├── sw.js                ← PWA service worker
├── package.json         ← dependencies (ws only)
├── railway.toml         ← restartPolicyType: always
└── CONTEXT.md           ← this file
```

**Note:** `api-server.js`, `orb-scanner.js`, `reversal-scanner.js` have been deleted — everything is in `scanner-server.js`

---

## Scanner Schedule (ET, weekdays only)

| Time | Event |
|---|---|
| 5:00am | ⚡ Bull Flag Scalper starts |
| 8:30am | 📊 Gap scanner fires — top gaps with direction |
| 8:45am | ⏰ Wind-down reminder — wrap up scalps, bias update |
| 9:15am | 📐 ORB pre-market brief — top 5 candidates with levels |
| 9:30am | 📐 ORB range building starts / 🔄 Reversal scanner starts |
| 9:40am | 📐 ORB range locks |
| 9:40–10:15am | 📐 ORB breakout alerts (Elite + Good only) |
| 9:30–10:30am | 🔄 Reversal alerts (Marubozu + exhaustion at S/R) |
| 10:00am | ⚡ Scalper stops |
| 10:15am | 📐 ORB stops |
| 10:30am | 🔄 Reversal stops |
| 4:30pm | 📋 Daily recap with win rate + conviction breakdown |

---

## WickED Dashboard Tabs

1. **Live Alerts** — real-time alert stream, filter by scanner type, sparkline charts, expandable candlestick chart with resistance/support lines
2. **Journal** — trade log, win rate donut, setup performance, AI analysis
3. **Long Term** — portfolio allocation, wheel tracker, buy & hold positions with live P&L
4. **Today's Recap** — daily summary, alert timeline
5. **Analytics** — win rate by scanner/conviction/time/bias, RSI analysis, WickED Intelligence recommendations

---

## Scanner Details

### ⚡ Scalp Scanner
- 1-min WebSocket bars (Polygon AM events)
- Low-float NASDAQ stocks $1–$20, float ≤20M
- Bull flag: pole 2%+, 65%+ green candles, volume contraction in flag
- Minimum 5x relative volume on pole
- VWAP context — skips setups >5% extended above VWAP
- Market bias included in every alert

### 📐 ORB Scanner
- 10-min opening range (9:30–9:40am)
- ORB must be <50% of 14-day ATR
- Quality ratings: Elite ≤25% ATR ⭐⭐⭐, Good 25–40% ⭐⭐ (OK and SKIP filtered out)
- 2x average bar volume required on breakout bar
- Market bias confirmation in alert (bullish day = higher conviction on bull breaks)
- Pre-market brief at 9:15am with top 5 candidates

### 🔄 Reversal Scanner
- 5-min bars, first hour only (9:30–10:30am)
- 4–5 candle Marubozu pole (60%+ body-to-range ratio, 3/4+ qualifying)
- Exhaustion candle: doji, spinning top, shooting star, hammer, wick reversal
- 3x average bar volume spike on exhaustion candle
- Within 1% of prev day high/low/close or hourly S/R level
- RSI(7) ranked: ≤10/≥90 = ⭐⭐⭐, ≤20/≥80 = ⭐⭐, ≤30/≥70 = ⭐
- Counter-trend warning if market bias opposes setup direction

---

## Data Sync Architecture

- Railway stores all data in `wicked-data.json` (local file, persistent)
- Dashboard polls Railway `GET /data` every 30 seconds
- Outcomes (Win/Loss/Skip) pushed via `POST /outcome`
- Wheel + BnH positions saved via `POST /data`
- localStorage fallback if Railway unreachable
- Market bias included in every `/data` response

---

## Portfolio Allocation Model

| Strategy | Allocation | Notes |
|---|---|---|
| ⚡ Scalp | 15% | High risk, small size, 5–10am only |
| 📐 ORB + Reversal | 20% | Quality setups, first hour |
| 📊 Swing | 25% | 2–6 week holds, daily bull flags |
| 🎡 Wheel | 25% | Options income engine, funds other trading |
| 🏦 Buy & Hold | 15% | 3yr+, SPY 40% / Sector 30% / Growth 20% / Commodity 10% |

---

## Session 3 TODO (Scanner Quality — use Opus + extended thinking)

### High Priority
- [ ] **Pre-market volume feed** into scalp scanner — know what's in play before 5am
- [ ] **Gap classification** for ORB — gap into resistance vs gap into open air changes conviction
- [ ] **RSI divergence detection** for reversals — price making new high but RSI lower = strongest signal
- [ ] **Multi-timeframe confirmation** — 5-min reversal aligning with daily S/R = 3x stronger
- [ ] **News catalyst tagging** — Polygon news endpoint, tag each alert with catalyst Y/N

### Medium Priority
- [ ] **Float rotation tracking** on scalp — how many times has float traded today?
- [ ] **AI pattern confirmation** — feed candlestick chart image to Claude vision, get setup quality score
- [ ] **Earnings date filter** — flag ORB setups within 3 days of earnings as high risk
- [ ] **Sector correlation** — is the stock leading or just following QQQ?
- [ ] **Weekly candle scanner** for long-term tab

### Lower Priority
- [ ] **Connect swing scanner** HTML into dashboard directly
- [ ] **Daily recap improvement** — track which specific setups hit target vs stop
- [ ] **Intraday chart candles** — manual scan charts use 5-min intraday during market hours (worker updated, dashboard needs tuning)

---

## Known Issues / Notes
- Cloudflare Worker updated to support `?multiplier=5&timespan=minute` for intraday candles
- PWA installed via manifest.json + sw.js — add to phone home screen via Safari "Add to Home Screen"
- Chart expand/close: click sparkline to open, click "✕ Close Chart" button to close
- Demo mode: click "⚡ Demo" button in alert panel for test data with sparklines
- Manual scan buttons in alert panel header: ⚡ Scalp, 📐 ORB, 🔄 Reversal (use daily candles on weekends)

---

## How to Start a New Session
1. Share this file URL: `https://raw.githubusercontent.com/mattsimms46/bull-flag-scalper/main/CONTEXT.md`
2. Say: "Read this context file and let's continue building WickED"
3. Use Opus model with extended thinking for scanner logic work
4. Use Sonnet for UI/dashboard/infrastructure work
