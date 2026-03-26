const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const BINANCE = "https://api.binance.com"; 

function sign(query, secret) {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function binanceRequest(endpoint, method, apiKey, apiSecret, params = {}) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = sign(qs, apiSecret);
  const url = `${BINANCE}${endpoint}?${qs}&signature=${sig}`;
  
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    ...(method === "POST" ? { body: `${qs}&signature=${sig}` } : {}),
  });
  return res.json();
}

app.post("/api/account", async (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "Missing keys" });
  try {
    const data = await binanceRequest("/api/v3/account", "GET", apiKey, apiSecret);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/order", async (req, res) => {
  const { apiKey, apiSecret, symbol, side, type, quantity } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "Missing keys" });
  try {
    const data = await binanceRequest("/api/v3/order", "POST", apiKey, apiSecret,
      { symbol, side, type: type || "MARKET", quantity });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Full-Stack Bot running on port ${PORT}`);
});

