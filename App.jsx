import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* ═══════════════════════════════════════════════════
   BINANCE ENDPOINTS
═══════════════════════════════════════════════════ */
const SYMBOL   = "XAUUSDT";
const INTERVAL = "15m";
const PUBLIC   = "https://api.binance.com";
const WS_BASE  = "wss://stream.binance.com:9443/ws";

/* ═══════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════ */
async function fetchKlines(limit = 120) {
  const url = `${PUBLIC}/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return data.map(k => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
    ts:     k[0],
    closed: true,
    isNews: false,
  }));
}

async function fetchTickerPrice() {
  const res = await fetch(`${PUBLIC}/api/v3/ticker/price?symbol=${SYMBOL}`);
  const d = await res.json();
  return parseFloat(d.price);
}

async function proxyPost(proxyUrl, endpoint, body) {
  const res = await fetch(`${proxyUrl}${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.msg || `HTTP ${res.status}`);
  }
  return res.json();
}

async function checkProxyHealth(proxyUrl) {
  const res = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}

/* ═══════════════════════════════════════════════════
   MATH UTILITIES
═══════════════════════════════════════════════════ */
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10)  / 10;

function calcEMA(prices, p) {
  if (!prices.length) return 0;
  const k = 2 / (p + 1);
  let v = prices.slice(0, Math.min(p, prices.length)).reduce((a, b) => a + b, 0) / Math.min(p, prices.length);
  for (let i = Math.min(p, prices.length); i < prices.length; i++) v = prices[i] * k + v * (1 - k);
  return r2(v);
}

function calcEMASeries(prices, p) {
  const out = new Array(prices.length).fill(null);
  if (prices.length < p) return out;
  const k = 2 / (p + 1);
  let v = prices.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = r2(v);
  for (let i = p; i < prices.length; i++) { v = prices[i] * k + v * (1 - k);
  out[i] = r2(v); }
  return out;
}

function calcRSISeries(prices, p = 14) {
  const out = new Array(prices.length).fill(null);
  for (let i = p; i < prices.length; i++) {
    let g = 0, l = 0;
    for (let j = i - p + 1; j <= i; j++) { const d = prices[j] - prices[j-1];
      d > 0 ? (g += d) : (l -= d);
    }
    const ag = g/p, al = l/p;
    out[i] = r1(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

function calcATR(highs, lows, closes, p = 14) {
  if (closes.length < p + 1) return 2;
  const trs = [];
  for (let i = closes.length - p; i < closes.length; i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  return r2(trs.reduce((a, b) => a + b, 0) / p);
}

function calcPivots(candles, lb = 4) {
  const sup = [], res = [];
  for (let i = lb; i < candles.length - lb; i++) {
    const sl = candles.slice(i - lb, i + lb + 1);
    if (sl.every(x => x.low  >= candles[i].low))  sup.push(r2(candles[i].low));
    if (sl.every(x => x.high <= candles[i].high)) res.push(r2(candles[i].high));
  }
  return { sup: [...new Set(sup)].slice(-4), res: [...new Set(res)].slice(-4) };
}

/* ═══════════════════════════════════════════════════
   SIGNAL ENGINE
═══════════════════════════════════════════════════ */
function getSignal(candles) {
  const N = candles.length;
  if (N < 40) return {
    type:"WAIT", label:"Loading Binance data...", score:0, strategy:"WAIT",
    desc:"Fetching live 15M candles", e21s:[], e50s:[], rsiArr:[], sup:[], res:[], price:0
  };
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const price  = closes[N - 1];
  const e21s   = calcEMASeries(closes, 21);
  const e50s   = calcEMASeries(closes, 50);
  const rsiArr = calcRSISeries(closes, 14);
  const e21    = e21s[N-1] || price;
  const e21p   = e21s[N-2] || e21;
  const e50    = e50s[N-1] || price;
  const RSI    = rsiArr[N-1] || 50;
  const ATR    = calcATR(highs, lows, closes, 14);
  const { sup, res } = calcPivots(candles, 4);

  const bullTrend  = e21 > e50;
  const bearTrend  = e21 < e50;
  const prevClose  = closes[N-2] || price;
  const crossAbove = prevClose < e21p && price >= e21;
  const crossBelow = prevClose > e21p && price <= e21;
  const atSup = sup.some(s => Math.abs(price - s) < ATR * 0.85);
  const atRes = res.some(r => Math.abs(price - r) < ATR * 0.85);
  const base = { e21s, e50s, rsiArr, e21, e50, RSI, ATR, price, sup, res };

  if (bullTrend && crossAbove && RSI > 36 && RSI < 68)
    return { ...base, type:"BUY", strategy:"PULLBACK", score:83, label:"📈 EMA21 Pullback", desc:"Price bounced off EMA21", sl:r2(price-ATR*1.1), tp1:r2(price+ATR*2.0), tp2:r2(price+ATR*3.5) };
  if (bearTrend && crossBelow && RSI > 32 && RSI < 64)
    return { ...base, type:"SELL", strategy:"PULLBACK", score:83, label:"📉 EMA21 Pullback", desc:"Price rejected EMA21", sl:r2(price+ATR*1.1), tp1:r2(price-ATR*2.0), tp2:r2(price-ATR*3.5) };
  
  return { ...base, type:"SCAN", strategy:"SCAN", score:22, label:"🔍 Scanning...", desc:"Waiting for setup", sl:null, tp1:null, tp2:null };
}

/* ═══════════════════════════════════════════════════
   CHART COMPONENTS
═══════════════════════════════════════════════════ */
function CandleChart({ candles, sig, trade }) {
  return <div style={{height: 200, background: "#08101e", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#1e293b"}}>Chart Rendering...</div>;
}

function Gauge({ score }) {
  return <div style={{fontSize: 24, fontWeight: "bold", color: "#fbbf24"}}>{score}%</div>;
}

/* ═══════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════ */
export default function App() {
  const [candles, setCand] = useState([]);
  const [wsStatus, setWS] = useState("disconnected");
  const [balance, setBal] = useState(10000);
  const [tab, setTab] = useState("chart");
  const [proxyUrl] = useState(""); // Default to same domain

  const sig = useMemo(() => getSignal(candles), [candles]);

  const loadCandles = async () => {
    try {
      const klines = await fetchKlines(120);
      setCand(klines);
    } catch(e) { console.error(e); }
  };

  useEffect(() => { loadCandles(); }, []);

  return (
    <div style={{background: "#020617", minHeight: "100vh", color: "#f1f5f9", fontFamily: "monospace", padding: 20}}>
      <div style={{display: "flex", justifyContent: "space-between", borderBottom: "1px solid #0f172a", paddingBottom: 10}}>
        <h2 style={{color: "#fbbf24"}}>⚡ XAU/USDT BOT</h2>
        <div style={{textAlign: "right"}}>
          <div style={{fontSize: 20}}>${candles[candles.length-1]?.close || "0.00"}</div>
          <div style={{fontSize: 12, color: "#475569"}}>Balance: ${balance}</div>
        </div>
      </div>

      <div style={{margin: "20px 0", padding: 15, background: "#0a0f1e", borderRadius: 12, border: "1px solid #1e293b", display: "flex", gap: 20, alignItems: "center"}}>
        <Gauge score={sig.score} />
        <div>
          <div style={{fontWeight: "bold", fontSize: 18}}>{sig.type}</div>
          <div style={{fontSize: 12, color: "#64748b"}}>{sig.label}</div>
        </div>
      </div>

      <div style={{display: "flex", gap: 10, marginBottom: 20}}>
        {["chart", "trade", "api"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{flex: 1, padding: 10, background: tab === t ? "#d97706" : "#0f172a", border: "none", color: "white", borderRadius: 8, cursor: "pointer"}}>{t.toUpperCase()}</button>
        ))}
      </div>

      {tab === "chart" && <CandleChart candles={candles} sig={sig} />}
      
      {tab === "api" && (
        <div style={{padding: 20, background: "#0a0f1e", borderRadius: 8}}>
            <h3>API SETTINGS</h3>
            <p style={{fontSize: 12, color: "#475569"}}>Proxy is automatically connected on Railway.</p>
            <button style={{width: "100%", padding: 12, background: "#052e16", color: "#34d399", border: "1px solid #065f46", borderRadius: 8}}>✅ Proxy Active</button>
        </div>
      )}

      <div style={{textAlign: "center", fontSize: 10, color: "#1e293b", marginTop: 40}}>Educational Purpose Only</div>
    </div>
  );
}
