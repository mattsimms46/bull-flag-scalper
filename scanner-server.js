// ─── WickED Scanner Server — All-in-one ──────────────────────────────────────
const https     = require("https");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const WebSocket = require("ws");

// ── Config ────────────────────────────────────────────────────────────────────
const POLYGON_KEY    = process.env.POLYGON_KEY    || "GMoNIAEFKGYBlnWGTMxlQxaiOD5q3f5H";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8600785204:AAFRzkIW4nMMz6Ao5OxrkWrwCP3JvcqTfCU";
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT  || "8446284130";
const API_SECRET     = process.env.API_SECRET     || "wicked-secret-change-me";
const PORT           = parseInt(process.env.PORT  || "8080");
const MIN_PRICE      = parseFloat(process.env.MIN_PRICE   || "1");
const MAX_PRICE      = parseFloat(process.env.MAX_PRICE   || "20");
const MIN_RVOL       = parseFloat(process.env.MIN_RVOL    || "5");
const MAX_FLOAT_M    = parseFloat(process.env.MAX_FLOAT_M || "20");
const SCAN_START_ET  = parseInt(process.env.SCAN_START_ET || "5");
const SCAN_END_ET    = parseInt(process.env.SCAN_END_ET   || "10");

// ── Data file ─────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "wicked-data.json");
const DEFAULT_DATA = { alerts:[], journal:[], wheel:[], bnh:[], portfolio:{ size:0 }, updatedAt:null };

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
  } catch(e) { log(`Data read error: ${e.message}`); }
  return { ...DEFAULT_DATA };
}
function writeData(data) {
  try { data.updatedAt=new Date().toISOString(); fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2)); return true; }
  catch(e) { log(`Data write error: ${e.message}`); return false; }
}
function pushAlert(alert) {
  try {
    const data = readData();
    alert.id = Date.now()+Math.random().toString(36).slice(2,6);
    alert.time = new Date().toISOString();
    alert.outcome = null; alert.notes = "";
    data.alerts.unshift(alert);
    if (data.alerts.length > 200) data.alerts = data.alerts.slice(0,200);
    writeData(data);
  } catch(e) { log(`Alert store error: ${e.message}`); }
}

// ── API Server ────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,X-API-Secret",
    "Content-Type":"application/json",
  };
}
function parseBody(req) {
  return new Promise((resolve,reject) => {
    let body="";
    req.on("data",c=>body+=c);
    req.on("end",()=>{ try{resolve(JSON.parse(body||"{}"))}catch(e){reject(e)} });
    req.on("error",reject);
  });
}
http.createServer(async(req,res)=>{
  const h = corsHeaders();
  if (req.method==="OPTIONS") { res.writeHead(204,h); res.end(); return; }
  const url = req.url.split("?")[0];
  const authed = req.headers["x-api-secret"]===API_SECRET;

  if (req.method==="GET" && url==="/health") {
    res.writeHead(200,h);
    res.end(JSON.stringify({status:"ok",time:new Date().toISOString()}));
    return;
  }
  if (req.method==="GET" && url==="/data") {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:"Unauthorized"})); return; }
    res.writeHead(200,h); res.end(JSON.stringify(readData())); return;
  }
  if (req.method==="POST" && url==="/data") {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:"Unauthorized"})); return; }
    try {
      const body = await parseBody(req);
      const merged = { ...readData(), ...body };
      writeData(merged);
      res.writeHead(200,h); res.end(JSON.stringify({success:true}));
    } catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (req.method==="POST" && url==="/alert") {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:"Unauthorized"})); return; }
    try {
      const alert = await parseBody(req);
      pushAlert(alert);
      res.writeHead(200,h); res.end(JSON.stringify({success:true}));
    } catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if (req.method==="POST" && url==="/outcome") {
    if (!authed) { res.writeHead(401,h); res.end(JSON.stringify({error:"Unauthorized"})); return; }
    try {
      const {id,outcome,notes} = await parseBody(req);
      const data = readData();
      const alert = data.alerts.find(a=>a.id===id);
      if (!alert) throw new Error("Alert not found");
      alert.outcome=outcome; alert.notes=notes||"";
      const ei = data.journal.findIndex(j=>j.alertId===id);
      const entry = {alertId:id,type:alert.type,ticker:alert.ticker,time:alert.time,outcome,notes:notes||"",conviction:alert.conviction,rsi:alert.rsi,rvol:alert.rvol};
      if (ei>=0) data.journal[ei]=entry; else data.journal.unshift(entry);
      writeData(data);
      res.writeHead(200,h); res.end(JSON.stringify({success:true}));
    } catch(e) { res.writeHead(400,h); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  res.writeHead(404,h); res.end(JSON.stringify({error:"Not found"}));
}).listen(PORT,"0.0.0.0",()=>log(`API server on port ${PORT}`));

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Process guards ────────────────────────────────────────────────────────────
process.on("SIGTERM",()=>log("SIGTERM — ignoring"));
process.on("uncaughtException",e=>log(`Uncaught: ${e.message}`));
process.on("unhandledRejection",r=>log(`Unhandled: ${r}`));

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({chat_id:TELEGRAM_CHAT,text,parse_mode:"HTML"});
  const opts = {hostname:"api.telegram.org",path:`/bot${TELEGRAM_TOKEN}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
  const req = https.request(opts,res=>{if(res.statusCode!==200)log(`Telegram ${res.statusCode}`)});
  req.on("error",e=>log(`Telegram: ${e.message}`));
  req.write(body); req.end();
}

// ── Polygon REST ──────────────────────────────────────────────────────────────
function polygonGet(p) {
  return new Promise((resolve,reject)=>{
    const sep=p.includes("?")?"&":"?";
    https.get(`https://api.polygon.io${p}${sep}apiKey=${POLYGON_KEY}`,res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}});
    }).on("error",reject);
  });
}

// ── VWAP ──────────────────────────────────────────────────────────────────────
function calcVWAP(bars) {
  let tpv=0,vol=0;
  for (const b of bars) { const tp=(b.open+b.high+b.low+b.close)/4; tpv+=tp*b.vol; vol+=b.vol; }
  return vol>0?tpv/vol:null;
}
function vwapLabel(price,vwap) {
  if (!vwap) return {label:"N/A",emoji:"⬜"};
  const pct=((price-vwap)/vwap*100);
  if (pct>3)  return {label:`${pct.toFixed(1)}% above VWAP ⚠️`,emoji:"🔴"};
  if (pct>0)  return {label:`${pct.toFixed(1)}% above VWAP ✅`,emoji:"🟢"};
  if (pct>-3) return {label:`${pct.toFixed(1)}% below VWAP`,emoji:"🟡"};
  return           {label:`${pct.toFixed(1)}% below VWAP ⚠️`,emoji:"🔴"};
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SCALP SCANNER (5am–10am, 1-min bars) ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const SEED_TICKERS = [
  "SOFI","HOOD","MARA","RIOT","CIFR","CLSK","IREN","BITF","HUT","BTBT",
  "ACHR","JOBY","SPCE","RKLB","ASTS","LUNR","HIMS","DOCS","RDDT","SNAP",
  "PINS","NKLA","NIO","AMC","GME","BB","CLOV","EVGO","QUBT","KULR",
  "MVIS","OCGN","APLD","BTCS","GFAI","VERB","ATOS","RAIL","SDIG","UAVS",
];

let scalpWS=null, scalpBars={}, scalpAvgVol={}, scalpFloat={};
let scalpAlerted=new Set(), scalpActive=false, scalpReconnect=null;

async function fetchAvgVol(ticker) {
  try {
    const to=new Date().toISOString().split("T")[0];
    const from=new Date(Date.now()-20*864e5).toISOString().split("T")[0];
    const d=await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=15`);
    if (d?.results?.length>=3) scalpAvgVol[ticker]=d.results.slice(0,10).reduce((s,r)=>s+r.v,0)/Math.min(10,d.results.length);
  } catch(e){}
}
async function fetchFloat(ticker) {
  try {
    const d=await polygonGet(`/v3/reference/tickers/${ticker}`);
    const s=d?.results?.share_class_shares_outstanding;
    if (s) scalpFloat[ticker]=s;
  } catch(e){}
}
async function buildScalpUniverse() {
  log("Building scalp universe...");
  const tickers=new Set(SEED_TICKERS);
  try {
    const snap=await polygonGet(`/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false`);
    if (snap?.tickers) snap.tickers.forEach(t=>{const p=t.day?.c||t.lastTrade?.p;if(p>=MIN_PRICE&&p<=MAX_PRICE)tickers.add(t.ticker)});
  } catch(e){log(`Universe error: ${e.message}`)}
  const list=[...tickers].slice(0,150);
  for (let i=0;i<list.length;i+=10) await Promise.allSettled([...list.slice(i,i+10).map(t=>fetchAvgVol(t)),...list.slice(i,i+10).map(t=>fetchFloat(t))]);
  return list.filter(t=>!scalpFloat[t]||scalpFloat[t]<=MAX_FLOAT_M*1e6);
}
function detectScalpFlag(ticker) {
  const b=scalpBars[ticker]; if (!b||b.length<8) return null;
  const n=b.length;
  for (let poleLen=3;poleLen<=8;poleLen++) {
    for (let i=n-1;i>=poleLen+2;i--) {
      const ps=i-poleLen; if(ps<0) break;
      const pole=b.slice(ps,i);
      const poleGainRaw=(b[i-1].close-b[ps].open)/b[ps].open;
      if (poleGainRaw<0.02) continue;
      const greenCount=pole.filter(c=>c.close>c.open).length;
      if (greenCount<Math.ceil(poleLen*0.65)) continue;
      const avgPoleVol=pole.reduce((s,c)=>s+c.vol,0)/poleLen;
      const dailyAvg=scalpAvgVol[ticker]||0;
      const avgBarVol=dailyAvg/390;
      if (avgBarVol>0&&avgPoleVol<avgBarVol*MIN_RVOL) continue;
      const flagCandles=b.slice(i,Math.min(i+6,n));
      if (flagCandles.length<2) continue;
      const flagHigh=Math.max(...flagCandles.map(c=>c.high));
      const flagLow=Math.min(...flagCandles.map(c=>c.low));
      const poleTop=b[i-1].close; const poleBtm=b[ps].open; const poleH=poleTop-poleBtm;
      if ((flagHigh-flagLow)/poleTop>0.04) continue;
      const avgFlagVol=flagCandles.reduce((s,c)=>s+c.vol,0)/flagCandles.length;
      if (avgFlagVol>=avgPoleVol*0.80) continue;
      const flagAvg=flagCandles.reduce((s,c)=>s+c.close,0)/flagCandles.length;
      if (flagAvg<poleBtm+poleH*0.5) continue;
      const currentPrice=b[n-1].close;
      const vwap=calcVWAP(b);
      const vwapInfo=vwapLabel(currentPrice,vwap);
      const spreadPct=((b[n-1].high-b[n-1].low)/currentPrice*100).toFixed(2);
      return {ticker,currentPrice:currentPrice.toFixed(2),poleGain:(poleGainRaw*100).toFixed(1),poleBars:poleLen,flagBars:flagCandles.length,avgPoleVol:Math.round(avgPoleVol),rVol:avgBarVol>0?(avgPoleVol/avgBarVol).toFixed(1):"N/A",flagRange:((flagHigh-flagLow)/poleTop*100).toFixed(2),spreadPct,breakoutTarget:(poleTop*(1+poleGainRaw)).toFixed(2),stopLoss:(flagLow*0.99).toFixed(2),float:scalpFloat[ticker]?`${(scalpFloat[ticker]/1e6).toFixed(1)}M`:"Unknown",vwap:vwap?vwap.toFixed(2):null,vwapInfo};
    }
  }
  return null;
}
function formatScalpAlert(f) {
  const time=new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});
  const vwapLine=f.vwap?`${f.vwapInfo.emoji} VWAP:   $${f.vwap} (${f.vwapInfo.label})`:"";
  return `🚨 <b>BULL FLAG — ${f.ticker}</b>\n⏰ ${time} ET\n\n💰 Price:   $${f.currentPrice}\n📈 Pole:    +${f.poleGain}% (${f.poleBars} bars)\n🏁 Flag:    ${f.flagBars} bars · ${f.flagRange}% range\n⚡ Rel Vol: ${f.rVol}x average\n📊 Float:   ${f.float}\n📐 Spread:  ~${f.spreadPct}%\n${vwapLine}\n\n🎯 Target: $${f.breakoutTarget}\n🛑 Stop:   $${f.stopLoss}\n\n<i>1-min scalp · NASDAQ · 5am–10am ET</i>`;
}
function connectScalpWS(tickers) {
  log(`Connecting scalp WS for ${tickers.length} tickers...`);
  scalpWS=new WebSocket("wss://socket.polygon.io/stocks");
  scalpWS.on("open",()=>scalpWS.send(JSON.stringify({action:"auth",params:POLYGON_KEY})));
  scalpWS.on("message",raw=>{
    let msgs; try{msgs=JSON.parse(raw)}catch(e){return}
    msgs.forEach(msg=>{
      if (msg.ev==="status") {
        if (msg.status==="auth_success") {
          log("Scalp WS auth — subscribing...");
          for(let i=0;i<tickers.length;i+=50) scalpWS.send(JSON.stringify({action:"subscribe",params:tickers.slice(i,i+50).map(t=>`AM.${t}`).join(",")}));
          sendTelegram(`✅ <b>Bull Flag Scalper ACTIVE</b>\nScanning ${tickers.length} NASDAQ stocks\n$${MIN_PRICE}–$${MAX_PRICE} · Float ≤${MAX_FLOAT_M}M · ${MIN_RVOL}x min rvol`);
        }
        return;
      }
      if (msg.ev==="AM") {
        const ticker=msg.sym; if(!ticker) return;
        const bar={open:msg.o,high:msg.h,low:msg.l,close:msg.c,vol:msg.av||msg.v,ts:msg.s};
        if (bar.close<MIN_PRICE||bar.close>MAX_PRICE) return;
        if (!scalpBars[ticker]) scalpBars[ticker]=[];
        scalpBars[ticker].push(bar);
        if (scalpBars[ticker].length>60) scalpBars[ticker].shift();
        if (!scalpAlerted.has(ticker)) {
          const flag=detectScalpFlag(ticker);
          if (flag) {
            scalpAlerted.add(ticker);
            log(`🚨 SCALP FLAG: ${ticker} @ $${flag.currentPrice} +${flag.poleGain}% ${flag.rVol}x`);
            sendTelegram(formatScalpAlert(flag));
            pushAlert({type:"scalp",ticker,direction:"bull",price:flag.currentPrice,pole:flag.poleGain,rvol:flag.rVol,rsi:null,float:flag.float,target:flag.breakoutTarget,stop:flag.stopLoss,vwap:flag.vwapInfo?.label||null,conviction:Math.min(5,Math.round(parseFloat(flag.rVol||0)/2)+2)});
            setTimeout(()=>scalpAlerted.delete(ticker),30*60*1000);
          }
        }
      }
    });
  });
  scalpWS.on("close",()=>{log("Scalp WS closed");if(scalpActive){scalpReconnect=setTimeout(()=>connectScalpWS(tickers),5000)}});
  scalpWS.on("error",e=>log(`Scalp WS error: ${e.message}`));
}
function disconnectScalp() {
  scalpActive=false; clearTimeout(scalpReconnect);
  if(scalpWS){scalpWS.close();scalpWS=null}
  scalpBars={}; scalpAlerted.clear(); log("Scalp scanner stopped");
  sendTelegram("🔴 <b>Bull Flag Scalper OFFLINE</b>\nBack tomorrow 5am ET");
}
async function checkScalpSchedule() {
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=et.getHours(),isWeekday=et.getDay()>=1&&et.getDay()<=5;
  if (isWeekday&&h>=SCAN_START_ET&&h<SCAN_END_ET) {
    if (!scalpActive) {
      log(`Scalp scanner starting`); scalpActive=true; scalpAlerted.clear(); scalpBars={};
      const tickers=await buildScalpUniverse();
      connectScalpWS(tickers);
    }
  } else { if(scalpActive) disconnectScalp(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── REVERSAL SCANNER (9:30–10:30am, 5-min bars) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const REVERSAL_TICKERS=[
  "SOFI","HOOD","MARA","RIOT","HIMS","RDDT","SNAP","AMC","GME","NIO",
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN","GOOGL","AVGO","PLTR",
  "CRWD","DDOG","NET","PANW","COIN","SQ","UBER","RBLX","SHOP","NFLX",
  "SPY","QQQ","IWM","SOXL","TQQQ","GLD","SLV","ARKK","LABU","UVXY",
];
let revWS=null,revBars5m={},revLevels={},revAvgBarVol={},revAlerted=new Set(),revActive=false,revReconnect=null;

function calcRSI(bars,period=7) {
  if (bars.length<period+1) return null;
  const closes=bars.map(b=>b.close);
  let gains=0,losses=0;
  for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d}
  const ag=gains/period,al=losses/period;
  if(al===0) return 100;
  return Math.round((100-100/(1+ag/al))*10)/10;
}
function classifyCandle(bar) {
  const totalRange=bar.high-bar.low; if(totalRange===0) return "doji";
  const body=Math.abs(bar.close-bar.open),bodyPct=body/totalRange;
  const upper=bar.high-Math.max(bar.open,bar.close),lower=Math.min(bar.open,bar.close)-bar.low;
  const isGreen=bar.close>=bar.open;
  if(bodyPct>0.75) return isGreen?"marubozu_green":"marubozu_red";
  if(bodyPct<0.10) return "doji";
  if(bodyPct<0.30&&upper>body*0.5&&lower>body*0.5) return "spinning_top";
  if(upper>body*2&&lower<body*0.5&&!isGreen) return "shooting_star";
  if(lower>body*2&&upper<body*0.5&&isGreen) return "hammer";
  if(upper>totalRange*0.4||lower>totalRange*0.4) return "wick_reversal";
  return "normal";
}
function isExhaustionCandle(bar){const t=classifyCandle(bar);return["doji","spinning_top","shooting_star","hammer","wick_reversal"].includes(t)}
async function fetchRevLevels(ticker) {
  try {
    const to=new Date().toISOString().split("T")[0];
    const from=new Date(Date.now()-7*864e5).toISOString().split("T")[0];
    const daily=await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=5`);
    let prevHigh=null,prevLow=null,prevClose=null;
    if(daily?.results?.length>=2){const p=daily.results[1];prevHigh=p.h;prevLow=p.l;prevClose=p.c}
    const hourly=await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=120`);
    const srLevels=[];
    if(hourly?.results?.length){
      const hrs=hourly.results;
      for(let i=1;i<hrs.length-1;i++){
        if(hrs[i].h>hrs[i-1].h&&hrs[i].h>hrs[i+1].h) srLevels.push({price:hrs[i].h,type:"resistance"});
        if(hrs[i].l<hrs[i-1].l&&hrs[i].l<hrs[i+1].l) srLevels.push({price:hrs[i].l,type:"support"});
      }
      const deduped=[];
      srLevels.sort((a,b)=>a.price-b.price).forEach(l=>{if(!deduped.find(d=>Math.abs(d.price-l.price)/l.price<0.005))deduped.push(l)});
      srLevels.length=0; deduped.forEach(l=>srLevels.push(l));
    }
    revAvgBarVol[ticker]=(daily?.results?.[1]?.v||0)/78;
    revLevels[ticker]={prevHigh,prevLow,prevClose,srLevels};
  } catch(e){log(`Rev levels error ${ticker}: ${e.message}`)}
}
function nearestRevLevel(ticker,price) {
  const levels=revLevels[ticker]; if(!levels) return null;
  const candidates=[];
  const check=(p,type)=>{if(p){const pct=Math.abs(price-p)/price;if(pct<=0.01)candidates.push({price:p,type,pct})}};
  check(levels.prevHigh,"Prev Day High"); check(levels.prevLow,"Prev Day Low"); check(levels.prevClose,"Prev Day Close");
  levels.srLevels.forEach(l=>{const pct=Math.abs(price-l.price)/price;if(pct<=0.01)candidates.push({price:l.price,type:l.type==="resistance"?"1hr Resistance":"1hr Support",pct})});
  return candidates.length?candidates.sort((a,b)=>a.pct-b.pct)[0]:null;
}
function detectReversal(ticker) {
  const b=revBars5m[ticker]; if(!b||b.length<7) return null;
  const n=b.length;
  for(let ei=n-1;ei>=n-3;ei--) {
    const exhaustBar=b[ei];
    if(!isExhaustionCandle(exhaustBar)) continue;
    const avgVol=revAvgBarVol[ticker]||0;
    if(avgVol>0&&exhaustBar.vol<avgVol*3) continue;
    for(let poleLen=4;poleLen<=5;poleLen++){
      const ps=ei-poleLen; if(ps<0) continue;
      const pole=b.slice(ps,ei);
      const allGreen=pole.every(c=>c.close>c.open),allRed=pole.every(c=>c.close<c.open);
      if(!allGreen&&!allRed) continue;
      const marubozuCount=pole.filter(c=>{const r=c.high-c.low,body=Math.abs(c.close-c.open);return r>0&&body/r>0.60}).length;
      if(marubozuCount<3) continue;
      const avgPoleVol=pole.reduce((s,c)=>s+c.vol,0)/poleLen;
      if(avgVol>0&&avgPoleVol<avgVol*1.5) continue;
      const direction=allGreen?"BEARISH REVERSAL":"BULLISH REVERSAL",emoji=allGreen?"🔴":"🟢";
      const exhaustPrice=(exhaustBar.high+exhaustBar.low)/2;
      const srLevel=nearestRevLevel(ticker,exhaustPrice);
      const rsi=calcRSI(b.slice(0,ei+1));
      const rsiInfo=rsi===null?{label:"N/A",stars:""}:rsi<=5||rsi>=95?{label:"EXTREME",stars:"⭐⭐⭐"}:rsi<=10||rsi>=90?{label:"VERY HIGH",stars:"⭐⭐"}:rsi<=20||rsi>=80?{label:"HIGH",stars:"⭐"}:{label:"MODERATE",stars:""};
      const candleType=classifyCandle(exhaustBar).replace(/_/g," ").toUpperCase();
      const poleMove=Math.abs((b[ei-1].close-b[ps].open)/b[ps].open*100).toFixed(1);
      const lev=revLevels[ticker]||{};
      return {ticker,direction,emoji,currentPrice:exhaustBar.close.toFixed(2),poleLen,poleMove,marubozuCount,candleType,exhaustVol:Math.round(exhaustBar.vol),volSpike:avgVol>0?(exhaustBar.vol/avgVol).toFixed(1):"N/A",rsi,rsiRank:rsiInfo,srLevel,prevHigh:lev.prevHigh?.toFixed(2),prevLow:lev.prevLow?.toFixed(2),prevClose:lev.prevClose?.toFixed(2),srLevels:lev.srLevels||[]};
    }
  }
  return null;
}
function formatRevAlert(r) {
  const time=new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});
  const srText=r.srLevels.filter(l=>Math.abs(l.price-parseFloat(r.currentPrice))/parseFloat(r.currentPrice)<0.03).sort((a,b)=>Math.abs(a.price-parseFloat(r.currentPrice))-Math.abs(b.price-parseFloat(r.currentPrice))).slice(0,3).map(l=>`  ${l.type==="resistance"?"🔴 R":"🟢 S"} $${l.price.toFixed(2)}`).join("\n")||"  None within 3%";
  const srHit=r.srLevel?`✅ AT ${r.srLevel.type.toUpperCase()} $${r.srLevel.price.toFixed(2)}`:"⚠️ Not at key level";
  return `${r.emoji} <b>${r.direction} — ${r.ticker}</b>\n⏰ ${time} ET\n\n💰 Price: $${r.currentPrice}\n📊 RSI(7): ${r.rsi??'N/A'} ${r.rsiRank.stars} ${r.rsiRank.label}\n📈 Pole: ${r.poleLen} candles · +${r.poleMove}% · ${r.marubozuCount}/${r.poleLen} Marubozu\n🕯 Exhaustion: ${r.candleType}\n⚡ Vol Spike: ${r.volSpike}x\n\n📍 S/R: ${srHit}\n\n🗓 Prior Day: H $${r.prevHigh??'N/A'} · L $${r.prevLow??'N/A'} · C $${r.prevClose??'N/A'}\n\n📐 Nearby Levels:\n${srText}\n\n<i>5-min · First hour · Confirm before entry</i>`;
}
function connectRevWS(tickers) {
  log(`Connecting reversal WS for ${tickers.length} tickers...`);
  revWS=new WebSocket("wss://socket.polygon.io/stocks");
  revWS.on("open",()=>revWS.send(JSON.stringify({action:"auth",params:POLYGON_KEY})));
  revWS.on("message",raw=>{
    let msgs;try{msgs=JSON.parse(raw)}catch(e){return}
    msgs.forEach(msg=>{
      if(msg.ev==="status"){
        if(msg.status==="auth_success"){
          log("Rev WS auth — subscribing...");
          for(let i=0;i<tickers.length;i+=50) revWS.send(JSON.stringify({action:"subscribe",params:tickers.slice(i,i+50).map(t=>`AM.${t}`).join(",")}));
          sendTelegram(`🔄 <b>Reversal Scanner ACTIVE</b>\n${tickers.length} tickers · 5-min · 9:30–10:30am ET`);
        }
        return;
      }
      if(msg.ev==="AM"){
        const ticker=msg.sym; if(!ticker||!REVERSAL_TICKERS.includes(ticker)) return;
        const bar={open:msg.o,high:msg.h,low:msg.l,close:msg.c,vol:msg.av||msg.v,ts:msg.s};
        if(!revBars5m[ticker]) revBars5m[ticker]=[];
        const last=revBars5m[ticker][revBars5m[ticker].length-1];
        const bucket=Math.floor(bar.ts/(5*60*1000));
        const lastBkt=last?Math.floor(last.ts/(5*60*1000)):-1;
        if(last&&bucket===lastBkt){last.high=Math.max(last.high,bar.high);last.low=Math.min(last.low,bar.low);last.close=bar.close;last.vol=bar.vol}
        else{revBars5m[ticker].push({...bar});if(revBars5m[ticker].length>50)revBars5m[ticker].shift()}
        if(revBars5m[ticker].length>=7&&!revAlerted.has(ticker)){
          const rev=detectReversal(ticker);
          if(rev){
            revAlerted.add(ticker);
            log(`${rev.emoji} REVERSAL: ${ticker} ${rev.direction} RSI:${rev.rsi}`);
            sendTelegram(formatRevAlert(rev));
            pushAlert({type:"reversal",ticker,direction:rev.direction.includes("BULL")?"bull":"bear",price:rev.currentPrice,candleType:rev.candleType,rvol:rev.volSpike,rsi:rev.rsi,srLevel:rev.srLevel?.type||null,target:null,stop:null,conviction:rev.rsiRank.stars.length+2});
            setTimeout(()=>revAlerted.delete(ticker),20*60*1000);
          }
        }
      }
    });
  });
  revWS.on("close",()=>{log("Rev WS closed");if(revActive){revReconnect=setTimeout(()=>connectRevWS(tickers),5000)}});
  revWS.on("error",e=>log(`Rev WS error: ${e.message}`));
}
function disconnectRev() {
  revActive=false; clearTimeout(revReconnect);
  if(revWS){revWS.close();revWS=null}
  revBars5m={}; revAlerted.clear(); log("Rev scanner stopped");
  sendTelegram("🔄 <b>Reversal Scanner OFFLINE</b>");
}
async function checkRevSchedule() {
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const mins=et.getHours()*60+et.getMinutes(),isWeekday=et.getDay()>=1&&et.getDay()<=5;
  if(isWeekday&&mins>=570&&mins<630){
    if(!revActive){
      log("Reversal scanner starting"); revActive=true; revAlerted.clear(); revBars5m={};
      const BATCH=10;
      for(let i=0;i<REVERSAL_TICKERS.length;i+=BATCH) await Promise.allSettled(REVERSAL_TICKERS.slice(i,i+BATCH).map(t=>fetchRevLevels(t)));
      connectRevWS(REVERSAL_TICKERS);
    }
  } else {if(revActive)disconnectRev()}
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ORB SCANNER (9:30–10:15am) ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const ORB_TICKERS=[...new Set([
  "SOFI","HOOD","MARA","RIOT","HIMS","RDDT","SNAP","AMC","GME","NIO","ACHR","RKLB","ASTS",
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN","GOOGL","AVGO","ARM","QCOM","MU",
  "AMAT","LRCX","MRVL","NFLX","PLTR","CRWD","DDOG","NET","PANW","ZS","SNOW","APP",
  "SHOP","COIN","SQ","PYPL","UBER","RBLX","DUOL","FTNT","ADBE","CRM","NOW","INTU",
  "AMGN","GILD","MRNA","REGN","VRTX","BKNG","ABNB","DASH","DKNG","LYFT",
  "SPY","QQQ","IWM","SOXL","TQQQ","LABU","ARKK","GLD","SLV","SQQQ",
  "V","MA","JPM","BAC","GS","WMT","COST","HD","NKE","SBUX",
])];
let orbWS=null,orbData={},orbBars5m={},orbAtr={},orbPrevDay={},orbAvgBarVol={};
let orbAlerted=new Set(),orbActive=false,orbReconnect=null,orbBriefSent=false;

function calcATR(bars,period=14) {
  if(bars.length<period+1) return null;
  const trs=[];
  for(let i=1;i<bars.length;i++){const p=bars[i-1],c=bars[i];trs.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)))}
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function orbQuality(pct){
  if(pct<=0.25) return{label:"ELITE",emoji:"🟢",stars:"⭐⭐⭐"};
  if(pct<=0.40) return{label:"GOOD",emoji:"🟡",stars:"⭐⭐"};
  if(pct<=0.50) return{label:"OK",emoji:"🟠",stars:"⭐"};
  return{label:"SKIP",emoji:"❌",stars:""};
}
function getETMins(){const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));return et.getHours()*60+et.getMinutes()}
async function fetchOrbData(ticker) {
  try {
    const to=new Date().toISOString().split("T")[0];
    const from=new Date(Date.now()-30*864e5).toISOString().split("T")[0];
    const daily=await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=20`);
    if(daily?.results?.length>=2){
      const atr=calcATR([...daily.results].reverse());
      if(atr) orbAtr[ticker]=atr;
      const prev=daily.results[1];
      orbPrevDay[ticker]={high:prev.h,low:prev.l,close:prev.c};
      orbAvgBarVol[ticker]=prev.v/78;
    }
  } catch(e){}
}
function processOrbBar(ticker,bar) {
  const etMins=getETMins();
  if(etMins>=570&&etMins<580){
    if(!orbData[ticker]) orbData[ticker]={high:bar.high,low:bar.low,locked:false};
    else if(!orbData[ticker].locked){orbData[ticker].high=Math.max(orbData[ticker].high,bar.high);orbData[ticker].low=Math.min(orbData[ticker].low,bar.low)}
    return;
  }
  if(etMins>=580&&orbData[ticker]&&!orbData[ticker].locked){
    orbData[ticker].locked=true;
    const orb=orbData[ticker];
    const orbRange=orb.high-orb.low;
    const atr=orbAtr[ticker];
    const orbPct=atr?orbRange/atr:null;
    if(orbPct&&orbPct>0.50){delete orbData[ticker];return}
    if(orbPct){orb.orbPct=orbPct;orb.quality=orbQuality(orbPct);orb.orbRange=orbRange}
    log(`ORB locked ${ticker}: H${orb.high.toFixed(2)} L${orb.low.toFixed(2)} ATR%:${orbPct?(orbPct*100).toFixed(0)+"%":"N/A"}`);
  }
  if(etMins>=580&&etMins<615){
    const orb=orbData[ticker];
    if(!orb?.locked) return;
    if(orbAlerted.has(ticker)) return;
    const avgVol=orbAvgBarVol[ticker]||0;
    const volOk=avgVol===0||bar.vol>=avgVol*2;
    if(!volOk) return;
    const quality=orb.quality||orbQuality(orb.orbPct||0.5);
    if(quality.label==="SKIP"||quality.label==="OK") return;
    const rsi=calcRSI((orbBars5m[ticker]||[]).slice(-15));
    const prev=orbPrevDay[ticker]||{};
    if(bar.close>orb.high){
      orbAlerted.add(ticker);
      const breakPct=((bar.close-orb.high)/orb.high*100).toFixed(2);
      const tgt1=(orb.high+orb.orbRange).toFixed(2),tgt2=(orb.high+orb.orbRange*2).toFixed(2),stop=(orb.high*0.995).toFixed(2);
      const atrPct=orb.orbPct?(orb.orbPct*100).toFixed(0):"N/A";
      const msg=`🚀 <b>ORB BULLISH BREAKOUT — ${ticker}</b>\n⏰ ${new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"})} ET\n\n💰 Price: $${bar.close.toFixed(2)}\n📊 RSI(7): ${rsi??'N/A'}\n⚡ Vol: ${avgVol>0?(bar.vol/avgVol).toFixed(1):"N/A"}x\n\n📐 ORB: H$${orb.high.toFixed(2)} L$${orb.low.toFixed(2)}\n   ATR%: ${atrPct}% ${quality.emoji} ${quality.label} ${quality.stars}\n   Break: +${breakPct}%\n\n🎯 T1: $${tgt1} · T2: $${tgt2}\n🛑 Stop: $${stop}\n\n🗓 PDH: $${prev.high?.toFixed(2)||'N/A'} · PDL: $${prev.low?.toFixed(2)||'N/A'}\n\n<i>ORB 10-min · 5-min breakout · Elite/Good only</i>`;
      sendTelegram(msg);
      pushAlert({type:"orb",ticker,direction:"bull",price:bar.close.toFixed(2),orbQuality:quality.label,orbAtrPct:atrPct,rvol:avgVol>0?(bar.vol/avgVol).toFixed(1):"N/A",rsi,target:tgt1,stop,conviction:quality.label==="ELITE"?5:4});
      log(`🚀 ORB BULL: ${ticker} +${breakPct}%`);
      setTimeout(()=>orbAlerted.delete(ticker),15*60*1000);
    } else if(bar.close<orb.low){
      orbAlerted.add(ticker);
      const breakPct=((orb.low-bar.close)/orb.low*100).toFixed(2);
      const tgt1=(orb.low-orb.orbRange).toFixed(2),tgt2=(orb.low-orb.orbRange*2).toFixed(2),stop=(orb.low*1.005).toFixed(2);
      const atrPct=orb.orbPct?(orb.orbPct*100).toFixed(0):"N/A";
      const msg=`🔻 <b>ORB BEARISH BREAKDOWN — ${ticker}</b>\n⏰ ${new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"})} ET\n\n💰 Price: $${bar.close.toFixed(2)}\n📊 RSI(7): ${rsi??'N/A'}\n⚡ Vol: ${avgVol>0?(bar.vol/avgVol).toFixed(1):"N/A"}x\n\n📐 ORB: H$${orb.high.toFixed(2)} L$${orb.low.toFixed(2)}\n   ATR%: ${atrPct}% ${quality.emoji} ${quality.label} ${quality.stars}\n   Break: -${breakPct}%\n\n🎯 T1: $${tgt1} · T2: $${tgt2}\n🛑 Stop: $${stop}\n\n🗓 PDH: $${prev.high?.toFixed(2)||'N/A'} · PDL: $${prev.low?.toFixed(2)||'N/A'}\n\n<i>ORB 10-min · 5-min breakout · Elite/Good only</i>`;
      sendTelegram(msg);
      pushAlert({type:"orb",ticker,direction:"bear",price:bar.close.toFixed(2),orbQuality:quality.label,orbAtrPct:atrPct,rvol:avgVol>0?(bar.vol/avgVol).toFixed(1):"N/A",rsi,target:tgt1,stop,conviction:quality.label==="ELITE"?5:4});
      log(`🔻 ORB BEAR: ${ticker} -${breakPct}%`);
      setTimeout(()=>orbAlerted.delete(ticker),15*60*1000);
    }
  }
}
async function sendOrbBrief() {
  if(orbBriefSent) return;
  orbBriefSent=true;
  log("Sending ORB pre-market brief...");
  try {
    const candidates=[];
    for(const t of ORB_TICKERS){
      const atr=orbAtr[t],prev=orbPrevDay[t];
      if(!atr||!prev) continue;
      let score=0;
      const pmChg=prev.close?((prev.close-prev.close)/prev.close*100):0;
      const atrPct=atr/prev.close;
      if(atrPct>0.015&&atrPct<0.06) score+=2;
      if(prev.high) score+=1;
      if(score>0) candidates.push({ticker:t,score,prevHigh:prev.high?.toFixed(2),prevLow:prev.low?.toFixed(2),prevClose:prev.close?.toFixed(2),atr:atr.toFixed(2)});
    }
    const top5=candidates.sort((a,b)=>b.score-a.score).slice(0,5);
    if(!top5.length){sendTelegram("📐 <b>ORB Brief</b>\nNo strong candidates today.");return}
    const lines=top5.map((c,i)=>`${i+1}. <b>${c.ticker}</b>\n   PDH: $${c.prevHigh} · PDL: $${c.prevLow} · PDC: $${c.prevClose}\n   ATR: $${c.atr}`).join("\n\n");
    sendTelegram(`📐 <b>ORB Pre-Market Brief — Top 5</b>\n⏰ 9:15am ET · Mark these levels\n\n${lines}\n\n<i>Range: 9:30–9:40 · Breakout: 9:40–10:15\nElite 🟢 and Good 🟡 only</i>`);
  } catch(e){log(`Brief error: ${e.message}`)}
}
function connectOrbWS(tickers) {
  log(`Connecting ORB WS for ${tickers.length} tickers...`);
  orbWS=new WebSocket("wss://socket.polygon.io/stocks");
  orbWS.on("open",()=>orbWS.send(JSON.stringify({action:"auth",params:POLYGON_KEY})));
  orbWS.on("message",raw=>{
    let msgs;try{msgs=JSON.parse(raw)}catch(e){return}
    msgs.forEach(msg=>{
      if(msg.ev==="status"){
        if(msg.status==="auth_success"){
          log("ORB WS auth — subscribing...");
          for(let i=0;i<tickers.length;i+=50) orbWS.send(JSON.stringify({action:"subscribe",params:tickers.slice(i,i+50).map(t=>`AM.${t}`).join(",")}));
          sendTelegram(`📐 <b>ORB Scanner ACTIVE</b>\nBuilding 10-min range for ${tickers.length} tickers\nRange locks 9:40 · Breakout window 9:40–10:15`);
        }
        return;
      }
      if(msg.ev==="AM"){
        const ticker=msg.sym; if(!ticker||!ORB_TICKERS.includes(ticker)) return;
        const bar={open:msg.o,high:msg.h,low:msg.l,close:msg.c,vol:msg.av||msg.v,ts:msg.s};
        if(!orbBars5m[ticker]) orbBars5m[ticker]=[];
        const last=orbBars5m[ticker][orbBars5m[ticker].length-1];
        const bucket=Math.floor(bar.ts/(5*60*1000));
        const lastBkt=last?Math.floor(last.ts/(5*60*1000)):-1;
        if(last&&bucket===lastBkt){last.high=Math.max(last.high,bar.high);last.low=Math.min(last.low,bar.low);last.close=bar.close;last.vol=bar.vol}
        else{if(last)processOrbBar(ticker,last);orbBars5m[ticker].push({...bar});if(orbBars5m[ticker].length>30)orbBars5m[ticker].shift()}
        const etm=getETMins();
        if(etm>=570&&etm<580){
          if(!orbData[ticker]) orbData[ticker]={high:bar.high,low:bar.low,locked:false};
          else if(!orbData[ticker].locked){orbData[ticker].high=Math.max(orbData[ticker].high,bar.high);orbData[ticker].low=Math.min(orbData[ticker].low,bar.low)}
        }
      }
    });
  });
  orbWS.on("close",()=>{log("ORB WS closed");if(orbActive){orbReconnect=setTimeout(()=>connectOrbWS(tickers),5000)}});
  orbWS.on("error",e=>log(`ORB WS error: ${e.message}`));
}
function disconnectOrb() {
  orbActive=false; orbBriefSent=false; clearTimeout(orbReconnect);
  if(orbWS){orbWS.close();orbWS=null}
  orbData={}; orbBars5m={}; orbAlerted.clear(); log("ORB scanner stopped");
  sendTelegram("📐 <b>ORB Scanner OFFLINE</b>");
}
async function checkOrbSchedule() {
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const etMins=et.getHours()*60+et.getMinutes(),isWeekday=et.getDay()>=1&&et.getDay()<=5;
  if(isWeekday&&etMins>=555&&etMins<557&&!orbBriefSent) sendOrbBrief();
  if(isWeekday&&etMins>=570&&etMins<615){
    if(!orbActive){
      log("ORB scanner starting"); orbActive=true; orbData={}; orbBars5m={}; orbAlerted.clear();
      const BATCH=10;
      for(let i=0;i<ORB_TICKERS.length;i+=BATCH) await Promise.allSettled(ORB_TICKERS.slice(i,i+BATCH).map(t=>fetchOrbData(t)));
      connectOrbWS(ORB_TICKERS);
    }
  } else {if(orbActive)disconnectOrb()}
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DAILY RECAP (4:30pm ET) ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
let recapSentToday=false;
function checkRecap() {
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const etMins=et.getHours()*60+et.getMinutes(),isWeekday=et.getDay()>=1&&et.getDay()<=5;
  if(isWeekday&&etMins>=990&&etMins<992&&!recapSentToday){
    recapSentToday=true;
    const data=readData();
    const today=new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",weekday:"long",month:"short",day:"numeric"});
    const todayAlerts=data.alerts.filter(a=>new Date(a.time).toDateString()===new Date().toDateString());
    const wins=todayAlerts.filter(a=>a.outcome==="win").length;
    const losses=todayAlerts.filter(a=>a.outcome==="loss").length;
    const traded=wins+losses;
    const wr=traded?Math.round(wins/traded*100)+"%":"—";
    sendTelegram(`📋 <b>Daily Recap — ${today}</b>\n\n⚡ Scalp alerts: ${todayAlerts.filter(a=>a.type==="scalp").length}\n📐 ORB alerts: ${todayAlerts.filter(a=>a.type==="orb").length}\n🔄 Reversal alerts: ${todayAlerts.filter(a=>a.type==="reversal").length}\n\n📊 Traded: ${traded} · Wins: ${wins} · Losses: ${losses}\n🎯 Win Rate: ${wr}\n\n<i>Tomorrow: ORB brief at 9:15am ET</i>`);
    log("Daily recap sent");
  }
  if(etMins===0){recapSentToday=false}
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MAIN SCHEDULER ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
log("WickED Scanner starting — Scalp + Reversal + ORB + API + Recap");
checkScalpSchedule();
checkRevSchedule();
checkOrbSchedule();
checkRecap();
setInterval(()=>{
  checkScalpSchedule();
  checkRevSchedule();
  checkOrbSchedule();
  checkRecap();
},60*1000);
