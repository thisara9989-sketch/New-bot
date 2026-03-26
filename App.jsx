import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* ═══════════════════════════════════════════════════
   CONFIG & ENDPOINTS
═══════════════════════════════════════════════════ */
const SYMBOL   = "XAUUSDT";
const INTERVAL = "15m";
const PUBLIC   = "https://api.binance.com";
const WS_BASE  = "wss://stream.binance.com:9443/ws";
const INIT_BAL = 10000;

/* ═══════════════════════════════════════════════════
   INDICATOR MATH
═══════════════════════════════════════════════════ */
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10)  / 10;

function calcEMASeries(prices, p) {
  const out = new Array(prices.length).fill(null);
  if (prices.length < p) return out;
  const k = 2 / (p + 1);
  let v = prices.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = r2(v);
  for (let i = p; i < prices.length; i++) { v = prices[i] * k + v * (1 - k); out[i] = r2(v); }
  return out;
}

function calcRSISeries(prices, p = 14) {
  const out = new Array(prices.length).fill(null);
  for (let i = p; i < prices.length; i++) {
    let g = 0, l = 0;
    for (let j = i - p + 1; j <= i; j++) { 
      const d = prices[j] - prices[j-1]; 
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
  if (N < 40) return { type:"WAIT", label:"Loading...", score:0, e21s:[], e50s:[], rsiArr:[], sup:[], res:[] };
  
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const price  = closes[N - 1];
  
  const e21s = calcEMASeries(closes, 21);
  const e50s = calcEMASeries(closes, 50);
  const rsiArr = calcRSISeries(closes, 14);
  const ATR = calcATR(highs, lows, closes, 14);
  const { sup, res } = calcPivots(candles, 4);

  const e21 = e21s[N-1] || price;
  const e50 = e50s[N-1] || price;
  const RSI = rsiArr[N-1] || 50;

  const bull = e21 > e50;
  const bear = e21 < e50;

  const base = { e21s, e50s, rsiArr, price, sup, res, RSI, ATR };

  if (bull && RSI > 40 && RSI < 65) 
    return { ...base, type:"BUY", strategy:"PULLBACK", score:83, label:"📈 EMA Pullback Bull", sl:r2(price-ATR*1.1), tp1:r2(price+ATR*2), tp2:r2(price+ATR*3.5) };
  if (bear && RSI > 35 && RSI < 60)
    return { ...base, type:"SELL", strategy:"PULLBACK", score:83, label:"📉 EMA Pullback Bear", sl:r2(price+ATR*1.1), tp1:r2(price-ATR*2), tp2:r2(price-ATR*3.5) };

  return { ...base, type:"SCAN", strategy:"SCAN", score:45, label:"🔍 Scanning Market..." };
}

/* ═══════════════════════════════════════════════════
   UI COMPONENTS
═══════════════════════════════════════════════════ */
function CandleChart({ candles, sig, trade }) {
  const SHOW=55, W=580, H=205, PL=60, PR=6, PT=6, PB=4;
  const last = candles.slice(-SHOW);
  const e21sl = (sig.e21s||[]).slice(-SHOW);
  const e50sl = (sig.e50s||[]).slice(-SHOW);
  const cw = (W-PL-PR)/SHOW;
  let mn = Math.min(...last.map(c => c.low));
  let mx = Math.max(...last.map(c => c.high));
  const rng = mx-mn||4; mn-=rng*0.1; mx+=rng*0.1;
  const yS = p => PT + ((mx-p)/(mx-mn))*(H-PT-PB);
  const xc = i => PL + i*cw + cw/2;
  const lp = arr => arr.map((v,i)=>v?`${xc(i).toFixed(1)},${yS(v).toFixed(1)}`:null).filter(Boolean).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:H, background:"#020617"}}>
      {lp(e21sl) && <polyline points={lp(e21sl)} fill="none" stroke="#38bdf8" strokeWidth="1.5" />}
      {lp(e50sl) && <polyline points={lp(e50sl)} fill="none" stroke="#fb923c" strokeWidth="1.2" />}
      {last.map((c,i)=>{
        const bull=c.close>=c.open; const col=bull?"#10b981":"#ef4444";
        return (
          <g key={i}>
            <line x1={xc(i)} y1={yS(c.high)} x2={xc(i)} y2={yS(c.low)} stroke={col} />
            <rect x={xc(i)-cw*0.3} y={yS(Math.max(c.open,c.close))} width={cw*0.6} height={Math.max(1, Math.abs(yS(c.open)-yS(c.close)))} fill={col} />
          </g>
        )
      })}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════ */
export default function GoldBot() {
  const [candles, setCand] = useState([]);
  const [wsStatus, setWS] = useState("disconnected");
  const [balance, setBal] = useState(INIT_BAL);
  const [trade, setTrade] = useState(null);
  const [lotSize, setLot] = useState(0.01);
  const [tab, setTab] = useState("chart");

  const sig = useMemo(() => getSignal(candles), [candles]);
  const price = candles[candles.length-1]?.close || 0;

  useEffect(() => {
    fetch(`${PUBLIC}/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=120`)
      .then(res => res.json())
      .then(data => setCand(data.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), ts: k[0] }))));
  }, []);

  const connectWS = () => {
    const ws = new WebSocket(`${WS_BASE}/${SYMBOL.toLowerCase()}@kline_${INTERVAL}`);
    ws.onopen = () => setWS("live");
    ws.onmessage = (e) => {
      const k = JSON.parse(e.data).k;
      const candle = { open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), ts: k.t };
      setCand(prev => {
        const last = prev[prev.length-1];
        if (last && last.ts === candle.ts) return [...prev.slice(0,-1), candle];
        return [...prev.slice(-119), candle];
      });
    };
  };

  const execTrade = (type) => {
    if (trade) return;
    setTrade({ type, entry: price, lots: lotSize, sl: sig.sl, tp2: sig.tp2 });
  };

  const T = (o={}) => ({fontFamily:"ui-monospace,monospace",...o});

  return (
    <div style={T({background:"#020617", minHeight:"100vh", color:"#f1f5f9", maxWidth:640, margin:"0 auto"})}>
      {/* Header */}
      <div style={{padding:15, borderBottom:"1px solid #1e293b", display:"flex", justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:18, fontWeight:800, color:"#fbbf24"}}>⚡ XAU/USDT</div>
          <div style={{fontSize:10, color:wsStatus==="live"?"#10b981":"#64748b"}}>● {wsStatus.toUpperCase()}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:24, fontWeight:800}}>${price.toFixed(2)}</div>
          <div style={{fontSize:10}}>BAL: <span style={{color:"#fbbf24"}}>${balance}</span></div>
        </div>
      </div>

      {/* Signal Card */}
      <div style={{margin:15, padding:15, background:"#0f172a", borderRadius:12, border:"1px solid #1e293b"}}>
        <div style={{fontSize:20, fontWeight:800, color:sig.type==="BUY"?"#10b981":"#ef4444"}}>{sig.type} {sig.score}%</div>
        <div style={{fontSize:12, color:"#94a3b8"}}>{sig.label}</div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex", gap:5, padding:"0 15px"}}>
        {["chart", "trade"].map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{flex:1, padding:8, borderRadius:8, background:tab===t?"#d97706":"#1e293b", color:tab===t?"#000":"#94a3b8", border:"none", fontWeight:700}}>{t.toUpperCase()}</button>
        ))}
      </div>

      {tab==="chart" && (
        <div style={{padding:15}}>
          <div style={{background:"#08101e", padding:5, borderRadius:10, border:"1px solid #1e293b"}}>
            <CandleChart candles={candles} sig={sig} trade={trade} />
          </div>
          <button onClick={connectWS} style={{width:"100%", marginTop:10, padding:12, borderRadius:10, background:"#1e293b", color:"#fff", border:"none", fontWeight:700}}>▶ CONNECT LIVE FEED</button>
        </div>
      )}

      {tab==="trade" && (
        <div style={{padding:15, display:"flex", flexDirection:"column", gap:10}}>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
            <button onClick={()=>execTrade("BUY")} style={{padding:20, borderRadius:12, background:"#064e3b", color:"#6ee7b7", border:"none", fontWeight:800, fontSize:16}}>▲ BUY</button>
            <button onClick={()=>execTrade("SELL")} style={{padding:20, borderRadius:12, background:"#450a0a", color:"#fca5a5", border:"none", fontWeight:800, fontSize:16}}>▼ SELL</button>
          </div>
          {trade && (
            <div style={{padding:15, background:"#1e293b", borderRadius:10, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span>{trade.type} {trade.lots} XAU @ {trade.entry}</span>
              <button onClick={()=>setTrade(null)} style={{padding:"5px 10px", background:"#ef4444", border:"none", borderRadius:5, color:"#fff"}}>CLOSE</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
