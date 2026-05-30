// ─── WickED Data API ──────────────────────────────────────────────────────────
// Simple REST API for syncing dashboard data across devices
// Runs alongside the scanner server on the same Railway instance

const http = require("http");
const fs   = require("fs");
const path = require("path");

const API_SECRET  = process.env.API_SECRET  || "wicked-secret-change-me";
const PORT        = parseInt(process.env.PORT || "8080");
const DATA_FILE   = path.join(__dirname, "wicked-data.json");

// ── Default data structure ────────────────────────────────────────────────────
const DEFAULT_DATA = {
  alerts:     [],
  journal:    [],
  wheel:      [],
  bnh:        [],
  portfolio:  { size: 0 },
  updatedAt:  null,
};

// ── Read / Write ──────────────────────────────────────────────────────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch(e) {
    console.log(`[API] Data read error: ${e.message}`);
  }
  return { ...DEFAULT_DATA };
}

function writeData(data) {
  try {
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch(e) {
    console.log(`[API] Data write error: ${e.message}`);
    return false;
  }
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Secret",
    "Content-Type": "application/json",
  };
}

// ── Parse body ────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch(e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ── Auth check ────────────────────────────────────────────────────────────────
function isAuthed(req) {
  return req.headers["x-api-secret"] === API_SECRET;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const headers = corsHeaders();

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = req.url.split("?")[0];

  // ── GET /health ──
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      status:  "ok",
      version: "1.0",
      time:    new Date().toISOString(),
    }));
    return;
  }

  // ── GET /data ── returns all dashboard data
  if (req.method === "GET" && url === "/data") {
    if (!isAuthed(req)) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const data = readData();
    res.writeHead(200, headers);
    res.end(JSON.stringify(data));
    return;
  }

  // ── POST /data ── saves all dashboard data
  if (req.method === "POST" && url === "/data") {
    if (!isAuthed(req)) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const body = await parseBody(req);
      const current = readData();
      // Merge — don't overwrite alerts pushed by scanners
      const merged = {
        ...current,
        ...body,
        alerts: body.alerts || current.alerts,
      };
      const ok = writeData(merged);
      res.writeHead(ok ? 200 : 500, headers);
      res.end(JSON.stringify({ success: ok }));
    } catch(e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /alert ── scanners push alerts here
  if (req.method === "POST" && url === "/alert") {
    if (!isAuthed(req)) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const alert = await parseBody(req);
      if (!alert.ticker || !alert.type) throw new Error("Missing ticker or type");
      alert.id        = Date.now() + Math.random().toString(36).slice(2);
      alert.time      = new Date().toISOString();
      alert.outcome   = null;
      alert.notes     = "";
      const data      = readData();
      data.alerts.unshift(alert);
      // Keep last 200 alerts
      if (data.alerts.length > 200) data.alerts = data.alerts.slice(0, 200);
      writeData(data);
      console.log(`[API] Alert saved: ${alert.ticker} ${alert.type}`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ success: true, id: alert.id }));
    } catch(e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /outcome ── log trade outcome from dashboard
  if (req.method === "POST" && url === "/outcome") {
    if (!isAuthed(req)) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const { id, outcome, notes } = await parseBody(req);
      const data = readData();
      const alert = data.alerts.find(a => a.id === id);
      if (!alert) throw new Error("Alert not found");
      alert.outcome = outcome;
      alert.notes   = notes || "";
      // Also add/update journal entry
      const existing = data.journal.findIndex(j => j.alertId === id);
      const entry = {
        alertId: id, type: alert.type, ticker: alert.ticker,
        time: alert.time, outcome, notes: notes || "",
        conviction: alert.conviction, rsi: alert.rsi, rvol: alert.rvol,
      };
      if (existing >= 0) data.journal[existing] = entry;
      else data.journal.unshift(entry);
      writeData(data);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WickED data API running on port ${PORT}`);
});

server.on("error", err => console.log(`[API] Server error: ${err.message}`));

module.exports = { readData, writeData };
