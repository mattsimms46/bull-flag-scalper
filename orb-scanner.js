// ─── ORB Scanner (Opening Range Breakout) ────────────────────────────────────
// 10-min opening range (9:30–9:40 ET)
// 5-min breakout confirmation window (9:40–10:15 ET)
// ORB must be < 50% of 14-day ATR
// All three universes combined

const https     = require("https");
const WebSocket = require("ws");

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_KEY    = process.env.POLYGON_KEY    || "GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU";
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT  || "8446284130";
const MAX_ORB_ATR    = parseFloat(process.env.MAX_ORB_ATR  || "0.50"); // 50% of ATR max
const MIN_VOL_MULT   = parseFloat(process.env.MIN_VOL_MULT || "2.0");  // 2x avg vol on breakout bar
const RSI_PERIOD     = parseInt(process.env.RSI_PERIOD     || "7");

// ── ORB timing (ET) ───────────────────────────────────────────────────────────
const ORB_BUILD_START = { h:9,  m:30 }; // start building range
const ORB_BUILD_END   = { h:9,  m:40 }; // range locked
const ORB_SCAN_END    = { h:10, m:15 }; // stop alerting

// ── Universe — all three combined ─────────────────────────────────────────────
const ORB_TICKERS = [...new Set([
  // Low-float scalp names
  "SOFI","HOOD","MARA","RIOT","CIFR","CLSK","IREN","BITF","HUT","BTBT",
  "ACHR","JOBY","SPCE","RKLB","ASTS","LUNR","HIMS","DOCS","RDDT","SNAP",
  "PINS","NKLA","NIO","AMC","GME","BB","CLOV","EVGO","QUBT","KULR",
  "MVIS","OCGN","APLD","BTCS","GFAI","VERB","ATOS","RAIL","SDIG","UAVS",
  // Liquid NASDAQ
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN","GOOGL","AVGO","ARM",
  "QCOM","MU","AMAT","LRCX","MRVL","NFLX","PLTR","CRWD","DDOG","NET",
  "PANW","ZS","SNOW","APP","SHOP","COIN","SQ","PYPL","UBER","RBLX",
  "DUOL","FTNT","OKTA","TEAM","ADBE","CRM","NOW","INTU","WDAY","INTC",
  "AMGN","GILD","MRNA","REGN","VRTX","BKNG","ABNB","DASH","DKNG","LYFT",
  // ETFs
  "SPY","QQQ","IWM","SOXL","TQQQ","LABU","ARKK","SQQQ","UVXY","GLD","SLV",
  // Curated list additions
  "SMCI","TXN","KLAC","LRCX","MRVL","F","GM","RIVN","LCID",
  "V","MA","JPM","BAC","GS","MS","SCHW","BLK",
  "UNH","LLY","ABBV","MRK","PFE","JNJ",
  "XOM","CVX","COP","OXY","SLB",
  "WMT","COST","HD","NKE","SBUX","MCD","CMG",
  "BA","CAT","GE","HON","LMT","RTX",
  "ADSK","ANSS","CDNS","MSTR","TWLO","HUBS","GTLB",
])];

// ── State ─────────────────────────────────────────────────────────────────────
let ws5m          = null;
let orbData       = {};  // ticker -> { high, low, locked, barCount }
let bars5m        = {};  // ticker -> [5min bars for RSI + vol]
let atrData       = {};  // ticker -> 14-day ATR
let avgBarVol     = {};  // ticker -> avg 5min bar vol
let prevDayData   = {};  // ticker -> { high, low, close }
let alertedToday  = new Set();
let scanActive    = false;
let orbLocked     = false; // true after 9:40
let reconnectTimer= null;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[ORB ${new Date().toISOString()}] ${msg}`); }

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "HTML" });
  const opts = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };
  const req = https.request(opts, res => {
    if (res.statusCode !== 200) log(`Telegram ${res.statusCode}`);
  });
  req.on("error", e => log(`Telegram: ${e.message}`));
  req.write(body); req.end();
}

// ── Polygon REST ──────────────────────────────────────────────────────────────
function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const sep = path.includes("?") ? "&" : "?";
    https.get(`https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

// ── ATR Calculation (14-day) ──────────────────────────────────────────────────
function calcATR(dailyBars, period=14) {
  if (dailyBars.length < period+1) return null;
  const trs = [];
  for (let i=1; i<dailyBars.length; i++) {
    const prev = dailyBars[i-1];
    const curr = dailyBars[i];
    trs.push(Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    ));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0) / period;
}

// ── RSI ───────────────────────────────────────────────────────────────────────
function calcRSI(bars, period=RSI_PERIOD) {
  if (bars.length < period+1) return null;
  const closes = bars.map(b=>b.close);
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  const avgG=gains/period, avgL=losses/period;
  if (avgL===0) return 100;
  return Math.round((100-100/(1+avgG/avgL))*10)/10;
}

// ── ORB quality label ─────────────────────────────────────────────────────────
function orbQuality(orbPct) {
  if (orbPct <= 0.25) return { label:"ELITE",  emoji:"🟢", stars:"⭐⭐⭐" };
  if (orbPct <= 0.40) return { label:"GOOD",   emoji:"🟡", stars:"⭐⭐" };
  if (orbPct <= 0.50) return { label:"OK",     emoji:"🟠", stars:"⭐" };
  return                     { label:"SKIP",   emoji:"❌", stars:"" };
}

// ── Fetch pre-market data + ATR + prev day ────────────────────────────────────
async function fetchTickerData(ticker) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now()-30*24*60*60*1000).toISOString().split("T")[0];

    const daily = await polygonGet(
      `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=20`
    );

    if (daily?.results?.length >= 2) {
      const atr = calcATR([...daily.results].reverse());
      if (atr) atrData[ticker] = atr;

      const prev = daily.results[1];
      prevDayData[ticker] = { high: prev.h, low: prev.l, close: prev.c };

      // Avg bar vol from daily vol / 78 bars per day
      avgBarVol[ticker] = prev.v / 78;
    }
  } catch(e) {
    log(`Data fetch error ${ticker}: ${e.message}`);
  }
}

// ── ET time helpers ───────────────────────────────────────────────────────────
function getETMins() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  return et.getHours()*60 + et.getMinutes();
}
function toMins(t) { return t.h*60 + t.m; }

// ── Process incoming bar ──────────────────────────────────────────────────────
function processBar(ticker, bar) {
  const etMins = getETMins();
  const buildStart = toMins(ORB_BUILD_START); // 9:30 = 570
  const buildEnd   = toMins(ORB_BUILD_END);   // 9:40 = 580
  const scanEnd    = toMins(ORB_SCAN_END);     // 10:15 = 615

  // ── Phase 1: Build ORB (9:30–9:40) ──
  if (etMins >= buildStart && etMins < buildEnd) {
    if (!orbData[ticker]) {
      orbData[ticker] = { high: bar.high, low: bar.low, locked: false, barCount: 1 };
    } else if (!orbData[ticker].locked) {
      orbData[ticker].high = Math.max(orbData[ticker].high, bar.high);
      orbData[ticker].low  = Math.min(orbData[ticker].low,  bar.low);
      orbData[ticker].barCount++;
    }
    return;
  }

  // ── Lock ORB at 9:40 ──
  if (etMins >= buildEnd && orbData[ticker] && !orbData[ticker].locked) {
    orbData[ticker].locked = true;
    const orb = orbData[ticker];
    const orbRange = orb.high - orb.low;
    const atr      = atrData[ticker];
    const orbPct   = atr ? orbRange / atr : null;

    if (orbPct && orbPct > MAX_ORB_ATR) {
      // ORB too wide — discard
      delete orbData[ticker];
      return;
    }
    if (orbPct) {
      orb.orbPct   = orbPct;
      orb.quality  = orbQuality(orbPct);
      orb.orbRange = orbRange;
    }
    log(`ORB locked ${ticker}: H${orb.high.toFixed(2)} L${orb.low.toFixed(2)} Range:${(orbRange/orb.high*100).toFixed(2)}% ATR%:${orbPct?(orbPct*100).toFixed(0)+"% of ATR":"N/A"}`);
  }

  // ── Phase 2: Watch for breakout (9:40–10:15) ──
  if (etMins >= buildEnd && etMins < scanEnd) {
    const orb = orbData[ticker];
    if (!orb?.locked) return;
    if (alertedToday.has(ticker)) return;

    // Track 5-min bars for RSI
    if (!bars5m[ticker]) bars5m[ticker] = [];
    bars5m[ticker].push(bar);
    if (bars5m[ticker].length > 30) bars5m[ticker].shift();

    const avgVol = avgBarVol[ticker] || 0;
    const volOk  = avgVol === 0 || bar.vol >= avgVol * MIN_VOL_MULT;
    const rsi    = calcRSI(bars5m[ticker]);
    const prev   = prevDayData[ticker] || {};

    // Bullish breakout: close above ORB high
    if (bar.close > orb.high && volOk) {
      const breakPct = ((bar.close - orb.high) / orb.high * 100).toFixed(2);
      const quality  = orb.quality || orbQuality(orb.orbPct || 0.5);
      const tgt1     = (orb.high + orb.orbRange).toFixed(2);
      const tgt2     = (orb.high + orb.orbRange*2).toFixed(2);
      const stop     = (orb.high * 0.995).toFixed(2); // just inside range

      // Only alert Elite and Good setups
      if (!quality || quality.label === "SKIP" || quality.label === "OK") return;

      alertedToday.add(ticker);
      setTimeout(() => alertedToday.delete(ticker), 15*60*1000);

      const biasOk = prev.close && bar.close > prev.close;
      sendTelegram(formatORBAlert({
        ticker, direction:"BULLISH BREAKOUT", emoji:"🚀",
        price: bar.close.toFixed(2),
        orbHigh: orb.high.toFixed(2), orbLow: orb.low.toFixed(2),
        orbRange: orb.orbRange, orbPct: orb.orbPct,
        quality, breakPct,
        volSpike: avgVol>0 ? (bar.vol/avgVol).toFixed(1) : "N/A",
        rsi, tgt1, tgt2, stop,
        prevHigh: prev.high?.toFixed(2),
        prevLow:  prev.low?.toFixed(2),
        prevClose:prev.close?.toFixed(2),
        biasOk,
        biasLabel: biasOk ? "✅ Above prev close (bullish bias)" : "⚠️ Below prev close",
        atr: atrData[ticker]?.toFixed(2),
      }));
      log(`🚀 ORB BULL BREAK: ${ticker} @ $${bar.close.toFixed(2)} +${breakPct}% above ORB`);
    }

    // Bearish breakdown: close below ORB low
    else if (bar.close < orb.low && volOk) {
      const breakPct = ((orb.low - bar.close) / orb.low * 100).toFixed(2);
      const quality  = orb.quality || orbQuality(orb.orbPct || 0.5);
      const tgt1     = (orb.low - orb.orbRange).toFixed(2);
      const tgt2     = (orb.low - orb.orbRange*2).toFixed(2);
      const stop     = (orb.low * 1.005).toFixed(2);

      // Only alert Elite and Good setups
      if (!quality || quality.label === "SKIP" || quality.label === "OK") return;

      alertedToday.add(ticker);
      setTimeout(() => alertedToday.delete(ticker), 15*60*1000);

      const biasOk = prev.close && bar.close < prev.close;
      sendTelegram(formatORBAlert({
        ticker, direction:"BEARISH BREAKDOWN", emoji:"🔻",
        price: bar.close.toFixed(2),
        orbHigh: orb.high.toFixed(2), orbLow: orb.low.toFixed(2),
        orbRange: orb.orbRange, orbPct: orb.orbPct,
        quality, breakPct,
        volSpike: avgVol>0 ? (bar.vol/avgVol).toFixed(1) : "N/A",
        rsi, tgt1, tgt2, stop,
        prevHigh: prev.high?.toFixed(2),
        prevLow:  prev.low?.toFixed(2),
        prevClose:prev.close?.toFixed(2),
        biasOk,
        biasLabel: biasOk ? "✅ Below prev close (bearish bias)" : "⚠️ Above prev close",
        atr: atrData[ticker]?.toFixed(2),
      }));
      log(`🔻 ORB BEAR BREAK: ${ticker} @ $${bar.close.toFixed(2)} -${breakPct}% below ORB`);
    }
  }
}

// ── Format Alert ──────────────────────────────────────────────────────────────
function formatORBAlert(r) {
  const time = new Date().toLocaleTimeString("en-US", {
    timeZone:"America/New_York", hour:"2-digit", minute:"2-digit"
  });
  const orbRangePct = r.orbRange && r.price
    ? (r.orbRange / parseFloat(r.price) * 100).toFixed(2) : "N/A";
  const atrPct = r.orbPct ? (r.orbPct*100).toFixed(0) : "N/A";

  return `${r.emoji} <b>ORB ${r.direction} — ${r.ticker}</b>
⏰ ${time} ET

💰 Price:       $${r.price}
📊 RSI(${RSI_PERIOD}):     ${r.rsi ?? "N/A"}
⚡ Vol Spike:   ${r.volSpike}x average

📐 Opening Range:
  High:  $${r.orbHigh}
  Low:   $${r.orbLow}
  Range: ${orbRangePct}% of price
  ATR%:  ${atrPct}% of ATR ${r.quality?.emoji} ${r.quality?.label} ${r.quality?.stars}

📈 Break: ${r.breakPct}% outside range
${r.biasLabel}

🎯 Target 1:  $${r.tgt1} (1x range)
🎯 Target 2:  $${r.tgt2} (2x range)
🛑 Stop:      $${r.stop} (inside range)

🗓 Prior Day:
  High:  $${r.prevHigh ?? "N/A"}
  Low:   $${r.prevLow  ?? "N/A"}
  Close: $${r.prevClose?? "N/A"}
  ATR:   $${r.atr      ?? "N/A"}

<i>ORB 10-min range · 5-min breakout · First 45min only</i>`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectORBWS(tickers) {
  log(`Connecting ORB WS for ${tickers.length} tickers...`);
  ws5m = new WebSocket("wss://socket.polygon.io/stocks");

  ws5m.on("open", () => {
    ws5m.send(JSON.stringify({ action:"auth", params: POLYGON_KEY }));
  });

  ws5m.on("message", raw => {
    let msgs;
    try { msgs = JSON.parse(raw); } catch(e) { return; }

    msgs.forEach(msg => {
      if (msg.ev === "status") {
        if (msg.status === "auth_success") {
          log("ORB WS authenticated — subscribing...");
          for (let i=0; i<tickers.length; i+=50) {
            const params = tickers.slice(i,i+50).map(t=>`AM.${t}`).join(",");
            ws5m.send(JSON.stringify({ action:"subscribe", params }));
          }
          sendTelegram(`📐 <b>ORB Scanner ACTIVE</b>
Building 10-min opening range for ${tickers.length} tickers
Range locks at 9:40am ET
Breakout window: 9:40–10:15am ET
Filter: ORB must be < 50% of ATR`);
        }
        return;
      }

      if (msg.ev === "AM") {
        const ticker = msg.sym;
        if (!ticker || !ORB_TICKERS.includes(ticker)) return;
        const bar = {
          open: msg.o, high: msg.h, low: msg.l,
          close: msg.c, vol: msg.av||msg.v, ts: msg.s,
        };

        // Aggregate into 5-min bars
        if (!bars5m[ticker]) bars5m[ticker] = [];
        const last    = bars5m[ticker][bars5m[ticker].length-1];
        const bucket  = Math.floor(bar.ts/(5*60*1000));
        const lastBkt = last ? Math.floor(last.ts/(5*60*1000)) : -1;

        if (last && bucket === lastBkt) {
          last.high  = Math.max(last.high, bar.high);
          last.low   = Math.min(last.low,  bar.low);
          last.close = bar.close;
          last.vol   = bar.vol;
        } else {
          // New 5-min bar complete — process it
          if (last) processBar(ticker, last);
          bars5m[ticker].push({...bar});
          if (bars5m[ticker].length > 30) bars5m[ticker].shift();
        }

        // Also update ORB high/low in real time during build phase
        const etMins = getETMins();
        if (etMins >= toMins(ORB_BUILD_START) && etMins < toMins(ORB_BUILD_END)) {
          if (!orbData[ticker]) {
            orbData[ticker] = { high: bar.high, low: bar.low, locked: false, barCount: 1 };
          } else if (!orbData[ticker].locked) {
            orbData[ticker].high = Math.max(orbData[ticker].high, bar.high);
            orbData[ticker].low  = Math.min(orbData[ticker].low,  bar.low);
          }
        }
      }
    });
  });

  ws5m.on("close", () => {
    log("ORB WS closed");
    if (scanActive) {
      reconnectTimer = setTimeout(() => connectORBWS(tickers), 5000);
    }
  });

  ws5m.on("error", err => log(`ORB WS error: ${err.message}`));
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnectORB() {
  scanActive = false;
  premarketBriefSent = false; // reset for tomorrow
  clearTimeout(reconnectTimer);
  if (ws5m) { ws5m.close(); ws5m = null; }
  orbData = {}; bars5m = {}; alertedToday.clear();
  log("ORB scanner stopped");
  sendTelegram("📐 <b>ORB Scanner OFFLINE</b>\nBreakout window closed · See you tomorrow 9:30am ET");
}

// ── Pre-market Brief (9:20am ET) ─────────────────────────────────────────────
let premarketBriefSent = false;

async function sendPremarketBrief() {
  if (premarketBriefSent) return;
  premarketBriefSent = true;
  log("Generating pre-market ORB brief...");

  try {
    // Fetch pre-market snapshot for all tickers
    const snap = await polygonGet(
      `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${ORB_TICKERS.slice(0,50).join(",")}`
    );

    const candidates = [];

    for (const t of ORB_TICKERS) {
      const atr  = atrData[t];
      const prev = prevDayData[t];
      if (!atr || !prev) continue;

      // Score each candidate
      let score = 0;
      const reasons = [];

      // Pre-market volume
      const pmSnap = snap?.tickers?.find(x=>x.ticker===t);
      const pmVol  = pmSnap?.day?.v || 0;
      const pmPrice= pmSnap?.lastTrade?.p || prev.close;
      const pmChg  = prev.close ? ((pmPrice-prev.close)/prev.close*100) : 0;

      // Strong pre-market move
      if (Math.abs(pmChg) > 2) { score += 3; reasons.push(`${pmChg>0?"+":""}${pmChg.toFixed(1)}% PM`); }
      else if (Math.abs(pmChg) > 1) { score += 1; reasons.push(`${pmChg>0?"+":""}${pmChg.toFixed(1)}% PM`); }

      // Pre-market volume meaningful
      if (pmVol > avgBarVol[t]*5) { score += 2; reasons.push("High PM vol"); }

      // Price near key level (prev high/low)
      if (prev.high && Math.abs(pmPrice-prev.high)/pmPrice < 0.01) { score += 2; reasons.push("Near prev high"); }
      if (prev.low  && Math.abs(pmPrice-prev.low) /pmPrice < 0.01) { score += 2; reasons.push("Near prev low");  }

      // ATR is healthy (not too wide, not too tight)
      const atrPct = atr / prev.close;
      if (atrPct > 0.015 && atrPct < 0.06) { score += 1; reasons.push(`ATR ${(atrPct*100).toFixed(1)}%`); }

      if (score > 0) {
        candidates.push({
          ticker: t, score, reasons, pmPrice, pmChg,
          prevHigh: prev.high, prevLow: prev.low, prevClose: prev.close,
          atr: atr.toFixed(2),
          keyLevels: [
            prev.high && `$${prev.high.toFixed(2)} (PDH)`,
            prev.low  && `$${prev.low.toFixed(2)} (PDL)`,
            prev.close&& `$${prev.close.toFixed(2)} (PDC)`,
          ].filter(Boolean).join(" · "),
        });
      }
    }

    // Top 5 by score
    const top5 = candidates.sort((a,b)=>b.score-a.score).slice(0,5);

    if (!top5.length) {
      sendTelegram("📐 <b>ORB Pre-Market Brief</b>
No strong candidates identified this morning.");
      return;
    }

    const lines = top5.map((c,i) => {
      const dir = c.pmChg > 0 ? "🟢" : "🔴";
      return `${i+1}. ${dir} <b>${c.ticker}</b> ${c.pmChg>0?"+":""}${c.pmChg.toFixed(1)}%
   Levels: ${c.keyLevels}
   ATR: $${c.atr} · ${c.reasons.join(", ")}`;
    }).join("

");

    sendTelegram(`📐 <b>ORB Pre-Market Brief — Top 5 Candidates</b>
⏰ 9:20am ET — Mark these levels before open

${lines}

<i>Range builds 9:30–9:40 · Breakout window 9:40–10:15
Only Elite 🟢⭐⭐⭐ and Good 🟡⭐⭐ setups will alert</i>`);
    log("Pre-market brief sent");
  } catch(e) {
    log(`Pre-market brief error: ${e.message}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function checkORBSchedule() {
  const et       = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const etMins   = et.getHours()*60 + et.getMinutes();
  const isWeekday= et.getDay()>=1 && et.getDay()<=5;
  const startM   = toMins(ORB_BUILD_START); // 9:30
  const endM     = toMins(ORB_SCAN_END);    // 10:15

  // Send pre-market brief at 9:20am
  const briefM = 9*60+20;
  if (isWeekday && etMins >= briefM && etMins < briefM+2) {
    sendPremarketBrief();
  }

  if (isWeekday && etMins >= startM && etMins < endM) {
    if (!scanActive) {
      log(`ORB scanner starting (${et.getHours()}:${String(et.getMinutes()).padStart(2,"0")} ET)`);
      scanActive = true;
      orbData = {}; bars5m = {}; alertedToday.clear();

      // Pre-fetch ATR + prev day data
      log(`Fetching ATR + prev day data for ${ORB_TICKERS.length} tickers...`);
      const BATCH = 10;
      for (let i=0; i<ORB_TICKERS.length; i+=BATCH) {
        await Promise.allSettled(ORB_TICKERS.slice(i,i+BATCH).map(t=>fetchTickerData(t)));
      }
      log("Data ready — connecting WebSocket");
      connectORBWS(ORB_TICKERS);
    }
  } else {
    if (scanActive) {
      log(`ORB scanner stopping`);
      disconnectORB();
    }
  }
}

module.exports = { checkORBSchedule };
