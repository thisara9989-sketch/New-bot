import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* ═══════════════════════════════════════════════════
   BINANCE ENDPOINTS
═══════════════════════════════════════════════════ */
const SYMBOL   = "XAUUSDT";
const INTERVAL = "15m";
const PUBLIC   = "https://api.binance.com";
const WS_BASE  = "wss://stream.binance.com:9443/ws";

/* ═══════════════════════════════════════════════════
   PUBLIC API (no auth needed, CORS-safe)
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

/* ═══════════════════════════════════════════════════
   PRIVATE API via proxy (avoids browser CORS block)
═══════════════════════════════════════════════════ */
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

function calcRSI(prices, p = 14) {
  if (prices.length <= p) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - p; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  const ag = g / p, al = l / p;
  return r1(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
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
    type:"WAIT", label:"Loading Binance data…", score:0, strategy:"WAIT",
    desc:"Fetching live 15M candles from Binance", e21s:[], e50s:[], rsiArr:[], sup:[], res:[], price:0
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
  const e200   = calcEMA(closes, Math.min(N-1, 100));
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
  const base = { e21s, e50s, rsiArr, e21, e50, e200, RSI, ATR, price, sup, res };
  if (bullTrend && crossAbove && RSI > 36 && RSI < 68)
    return { ...base, type:"BUY", strategy:"PULLBACK", score:83,
      label:"📈 EMA21 Pullback — Bull continuation",
      desc:`Price bounced off EMA21 (${e21}) in bull trend · RSI ${RSI} · ATR ${ATR}`,
      sl:r2(price-ATR*1.1), tp1:r2(price+ATR*2.0), tp2:r2(price+ATR*3.5) };
  if (bearTrend && crossBelow && RSI > 32 && RSI < 64)
    return { ...base, type:"SELL", strategy:"PULLBACK", score:83,
      label:"📉 EMA21 Pullback — Bear continuation",
      desc:`Price rejected EMA21 (${e21}) in bear trend · RSI ${RSI} · ATR ${ATR}`,
      sl:r2(price+ATR*1.1), tp1:r2(price-ATR*2.0), tp2:r2(price-ATR*3.5) };
  if (atSup && RSI < 36)
    return { ...base, type:"BUY", strategy:"SR_BOUNCE", score:82,
      label:"🟢 Pivot Support Bounce + RSI Oversold",
      desc:`At key support zone, RSI oversold (${RSI}) — high-probability reversal`,
      sl:r2(price-ATR*1.3), tp1:r2(price+ATR*2.2), tp2:r2(price+ATR*3.8) };
  if (atRes && RSI > 64)
    return { ...base, type:"SELL", strategy:"SR_BOUNCE", score:82,
      label:"🔴 Pivot Resistance Rejection + RSI Overbought",
      desc:`At key resistance zone, RSI overbought (${RSI}) — reversal conditions`,
      sl:r2(price+ATR*1.3), tp1:r2(price-ATR*2.2), tp2:r2(price-ATR*3.8) };
  const near = Math.abs(price - e21) < ATR * 1.1;
  return { ...base, type:"SCAN", strategy:"SCAN", score:near?55:22,
    label:near?"🔍 Approaching EMA21 — setup forming…":"🔍 Scanning live 15M structure…",
    desc:`Trend: ${bullTrend?"BULL ▲":bearTrend?"BEAR ▼":"NEUTRAL"} | EMA21: ${e21} | RSI: ${RSI} | ATR: ${ATR}`,
    sl:null, tp1:null, tp2:null };
}

/* ═══════════════════════════════════════════════════
   CHART COMPONENTS
═══════════════════════════════════════════════════ */
function CandleChart({ candles, sig, trade }) {
  const SHOW=55, W=580, H=205, PL=60, PR=6, PT=6, PB=4;
  const last = candles.slice(-SHOW);
  const e21sl = (sig.e21s||[]).slice(-SHOW);
  const e50sl = (sig.e50s||[]).slice(-SHOW);
  const cw = (W-PL-PR)/SHOW;
  let mn = Math.min(...last.map(c => c.low));
  let mx = Math.max(...last.map(c => c.high));
  if (trade?.sl)  { mn=Math.min(mn,trade.sl);  mx=Math.max(mx,trade.sl); }
  if (trade?.tp2) { mn=Math.min(mn,trade.tp2); mx=Math.max(mx,trade.tp2); }
  const rng = mx-mn||4; mn-=rng*0.07; mx+=rng*0.07;
  const yS = p => PT + ((mx-p)/(mx-mn))*(H-PT-PB);
  const xc = i => PL + i*cw + cw/2;
  const lp  = arr => { const p=arr.map((v,i)=>v!=null?`${xc(i).toFixed(1)},${yS(v).toFixed(1)}`:null).filter(Boolean); return p.length>1?p.join(" "):null; };
  const grids = [0.1,0.3,0.5,0.7,0.9].map(f => mn+(mx-mn)*f);
  const {sup=[],res=[]} = sig;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      {grids.map((p,i)=>(
        <g key={i}>
          <line x1={PL} y1={yS(p)} x2={W-PR} y2={yS(p)} stroke="#0f172a" strokeWidth="1"/>
          <text x={PL-4} y={yS(p)+3} textAnchor="end" fontSize="8" fill="#1e293b">{p.toFixed(2)}</text>
        </g>
      ))}
      {sup.map((s,i)=><line key={`s${i}`} x1={PL} y1={yS(s)} x2={W-PR} y2={yS(s)} stroke="#34d399" strokeWidth="0.8" strokeDasharray="4,3" opacity="0.5"/>)}
      {res.map((r,i)=><line key={`r${i}`} x1={PL} y1={yS(r)} x2={W-PR} y2={yS(r)} stroke="#f87171" strokeWidth="0.8" strokeDasharray="4,3" opacity="0.5"/>)}
      {lp(e21sl)&&<polyline points={lp(e21sl)} fill="none" stroke="#38bdf8" strokeWidth="1.5"/>}
      {lp(e50sl)&&<polyline points={lp(e50sl)} fill="none" stroke="#fb923c" strokeWidth="1.2"/>}
      {last.map((c,i)=>{
        const bull=c.close>=c.open;
        const col=bull?"#10b981":"#ef4444";
        const top=yS(Math.max(c.open,c.close));
        const bH=Math.max(1.5,Math.abs(yS(c.open)-yS(c.close)));
        return (
          <g key={i}>
            <line x1={xc(i)} y1={yS(c.high)} x2={xc(i)} y2={yS(c.low)} stroke={col} strokeWidth="1"/>
            <rect x={xc(i)-cw*0.36} y={top} width={cw*0.72} height={bH} fill={col} opacity="0.9"/>
          </g>
        );
      })}
      {trade&&(<>
        <line x1={PL} y1={yS(trade.entry)} x2={W-PR} y2={yS(trade.entry)} stroke="#fbbf24" strokeWidth="1.3" strokeDasharray="5,3"/>
        <text x={W-PR-2} y={yS(trade.entry)-2} textAnchor="end" fontSize="7.5" fill="#fbbf24">ENTRY</text>
        {trade.sl&&<><line x1={PL} y1={yS(trade.sl)} x2={W-PR} y2={yS(trade.sl)} stroke="#f87171" strokeWidth="1" strokeDasharray="3,2"/><text x={W-PR-2} y={yS(trade.sl)-2} textAnchor="end" fontSize="7.5" fill="#f87171">SL</text></>}
        {trade.tp1&&<><line x1={PL} y1={yS(trade.tp1)} x2={W-PR} y2={yS(trade.tp1)} stroke="#34d399" strokeWidth="1" strokeDasharray="3,2"/><text x={W-PR-2} y={yS(trade.tp1)-2} textAnchor="end" fontSize="7.5" fill="#34d399">TP1</text></>}
        {trade.tp2&&<><line x1={PL} y1={yS(trade.tp2)} x2={W-PR} y2={yS(trade.tp2)} stroke="#6ee7b7" strokeWidth="0.8" strokeDasharray="2,2"/><text x={W-PR-2} y={yS(trade.tp2)-2} textAnchor="end" fontSize="7.5" fill="#6ee7b7">TP2</text></>}
      </>)}
      <rect x={PL} y={PT-1} width={200} height={14} fill="#020617" opacity="0.8" rx="2"/>
      <text x={PL+4}  y={PT+9} fontSize="8" fill="#38bdf8">━ EMA21</text>
      <text x={PL+60} y={PT+9} fontSize="8" fill="#fb923c">━ EMA50</text>
      <text x={PL+116} y={PT+9} fontSize="8" fill="#34d399">╌ SUP</text>
      <text x={PL+152} y={PT+9} fontSize="8" fill="#f87171">╌ RES</text>
    </svg>
  );
}

function RSIPanel({ rsiArr }) {
  const SHOW=55, W=580, H=52, PL=60, PR=6;
  const data=(rsiArr||[]).slice(-SHOW).map(v=>v??50);
  if (data.length<2) return null;
  const xc=i=>PL+(i/(SHOW-1))*(W-PL-PR);
  const yR=v=>3+((100-v)/100)*(H-6);
  const pts=data.map((v,i)=>`${xc(i).toFixed(1)},${yR(v).toFixed(1)}`).join(" ");
  const last=data[data.length-1];
  const col=last>70?"#f87171":last<30?"#34d399":"#a78bfa";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      {[70,50,30].map(v=>(
        <g key={v}>
          <line x1={PL} y1={yR(v)} x2={W-PR} y2={yR(v)} stroke={v===50?"#1e293b":v===70?"#450a0a":"#042f2e"} strokeWidth="0.7"/>
          <text x={PL-4} y={yR(v)+3} textAnchor="end" fontSize="7" fill={v===70?"#f87171":v===30?"#34d399":"#334155"}>{v}</text>
        </g>
      ))}
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.4"/>
      <circle cx={xc(data.length-1)} cy={yR(last)} r="2.5" fill={col}/>
      <text x={W-PR-2} y={yR(last)-3} textAnchor="end" fontSize="8" fill={col}>{last}</text>
    </svg>
  );
}

function EquityCurve({ history, start }) {
  const W=580,H=80,PL=60,PR=6,PT=5,PB=4;
  const pts=useMemo(()=>{ const p=[start]; let b=start; [...history].reverse().forEach(t=>{b=r2(b+t.pnl);p.push(b);}); return p; },[history,start]);
  if (pts.length<2) return <div style={{textAlign:"center",color:"#1e293b",padding:"22px 0",fontSize:11}}>No trades yet</div>;
  const mn=Math.min(...pts),mx=Math.max(...pts),sp=Math.max(mx-mn,50);
  const yE=v=>PT+((mx-v+sp*0.08)/(sp*1.16))*(H-PT-PB);
  const xE=i=>PL+(i/(pts.length-1))*(W-PL-PR);
  const poly=pts.map((v,i)=>`${xE(i).toFixed(1)},${yE(v).toFixed(1)}`).join(" ");
  const col=pts[pts.length-1]>=start?"#10b981":"#ef4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      <defs><linearGradient id="egX" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.25"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs>
      <line x1={PL} y1={yE(start)} x2={W-PR} y2={yE(start)} stroke="#334155" strokeWidth="0.5" strokeDasharray="4,3"/>
      <polygon points={`${xE(0)},${H} ${poly} ${xE(pts.length-1)},${H}`} fill="url(#egX)"/>
      <polyline points={poly} fill="none" stroke={col} strokeWidth="1.8"/>
      <circle cx={xE(pts.length-1)} cy={yE(pts[pts.length-1])} r="3" fill={col}/>
      <text x={PL-4} y={yE(start)+3} textAnchor="end" fontSize="7.5" fill="#475569">{start}</text>
    </svg>
  );
}

function Gauge({ score }) {
  const col=score>=80?"#10b981":score>=60?"#f59e0b":"#475569";
  const r=30,cx=40,cy=42;
  const xy=deg=>({x:cx+r*Math.cos((deg-90)*Math.PI/180),y:cy+r*Math.sin((deg-90)*Math.PI/180)});
  const s=xy(-120),eBg=xy(120),eFg=xy(-120+(score/100)*240);
  const la=(score/100)*240>180?1:0;
  return (
    <svg viewBox="0 0 80 64" style={{width:80,height:64,flexShrink:0}}>
      <path d={`M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 1 1 ${eBg.x.toFixed(1)} ${eBg.y.toFixed(1)}`} fill="none" stroke="#0f172a" strokeWidth="7" strokeLinecap="round"/>
      {score>0&&<path d={`M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 ${la} 1 ${eFg.x.toFixed(1)} ${eFg.y.toFixed(1)}`} fill="none" stroke={col} strokeWidth="7" strokeLinecap="round"/>}
      <text x={cx} y={cy-5} textAnchor="middle" fontSize="16" fontWeight="800" fill={col}>{score}</text>
      <text x={cx} y={cy+9} textAnchor="middle" fontSize="7" fill="#475569">SCORE</text>
    </svg>
  );
}

/* ═══════════════════════════════════════════════════
   AI ANALYSIS
═══════════════════════════════════════════════════ */
async function fetchAI(sig) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:180,
      messages:[{role:"user",content:
`You are a professional XAU/USD 15M scalp trader using real Binance live data.
Signal: ${sig.type} | Strategy: ${sig.strategy} | Score: ${sig.score}%
Live Price: $${sig.price} | EMA21: ${sig.e21} | EMA50: ${sig.e50} | RSI: ${sig.RSI} | ATR: ${sig.ATR}
${sig.sl?`SL: ${sig.sl} | TP1: ${sig.tp1} | TP2: ${sig.tp2}`:"Scanning for setup"}
Setup: ${sig.label}
${sig.desc}
Give exactly 3 sentences: (1) market structure, (2) entry logic, (3) key risk. Professional. No guarantees.`}]
    })
  });
  const d=await res.json();
  return d.content?.[0]?.text||"Analysis unavailable.";
}

/* ═══════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════ */
const INIT_BAL = 10000;
const T = (o={}) => ({fontFamily:"ui-monospace,monospace",...o});
const SC = {PULLBACK:"#60a5fa",SR_BOUNCE:"#a78bfa",SCAN:"#334155",WAIT:"#334155"};

export default function App() {
  const [candles,    setCand]     = useState([]);
  const [wsStatus,   setWS]       = useState("disconnected");
  const [wsError,    setWSError]  = useState("");
  const [loadErr,    setLoadErr]  = useState("");
  const [loading,    setLoading]  = useState(false);
  const [balance,    setBal]      = useState(INIT_BAL);
  const [trade,      setTrade]    = useState(null);
  const [history,    setHist]     = useState([]);
  const [aiText,     setAI]       = useState("");
  const [aiLoad,     setAILoad]   = useState(false);
  const [autoTrade,  setAuto]     = useState(false);
  const [lotSize,    setLot]      = useState(0.001);
  const [tab,        setTab]      = useState("chart");
  const [tp1Hit,     setTP1]      = useState(false);
  const [alerts,     setAlerts]   = useState([]);
  const [lastAIKey,  setLastKey]  = useState("");
  const [livePrice,  setLiveP]    = useState(null);
  const [mode,       setMode]     = useState("paper");

  // API state
  const [apiKey,     setApiKey]   = useState("");
  const [apiSecret,  setApiSec]   = useState("");
  
  // NOTE: Changed proxyUrl to empty string so it automatically calls its own backend
  const [proxyUrl,   setProxy]    = useState("");
  const [proxyOk,    setProxyOk]  = useState(false);
  const [proxyErr,   setProxyErr] = useState("");
  const [acctInfo,   setAcct]     = useState(null);
  const [apiErr,     setApiErr]   = useState("");
  const [lastOrder,  setLastOrd]  = useState(null);
  const [showSec,    setShowSec]  = useState(false);

  const R = useRef({});
  R.current.trade    = trade;
  R.current.auto     = autoTrade;
  R.current.lot      = lotSize;
  R.current.tp1Hit   = tp1Hit;
  R.current.mode     = mode;
  R.current.apiKey   = apiKey;
  R.current.apiSec   = apiSecret;
  R.current.proxy    = proxyUrl;
  R.current.proxyOk  = proxyOk;

  const wsRef      = useRef(null);
  const reconnectR = useRef(null);

  /* ── Signal & price ──────────────────────────────── */
  const sig   = useMemo(() => getSignal(candles), [candles]);
  const price = livePrice ?? (candles[candles.length-1]?.close || 0);

  /* ── Stats ───────────────────────────────────────── */
  const stats = useMemo(() => {
    const w=history.filter(t=>t.pnl>0), l=history.filter(t=>t.pnl<=0);
    const tp=r2(history.reduce((s,t)=>s+t.pnl,0));
    const wr=history.length?r1((w.length/history.length)*100):0;
    const aw=w.length?r2(w.reduce((s,t)=>s+t.pnl,0)/w.length):0;
    const al=l.length?r2(Math.abs(l.reduce((s,t)=>s+t.pnl,0))/l.length):0;
    const pf=al>0&&l.length>0?r1((aw*w.length)/(al*l.length)):w.length>0?"∞":"—";
    let peak=INIT_BAL,b=INIT_BAL,dd=0;
    [...history].reverse().forEach(t=>{b+=t.pnl;peak=Math.max(peak,b);dd=Math.max(dd,peak-b);});
    return {totalPnl:tp,winRate:wr,avgWin:aw,avgLoss:al,profFactor:pf,maxDD:r2(dd),wins:w.length,losses:l.length};
  },[history]);
  const livePnl = trade ? r2((trade.type==="BUY"?price-trade.entry:trade.entry-price)*trade.lots*100) : 0;

  /* ── Load candles (public, CORS-safe) ────────────── */
  const loadCandles = useCallback(async () => {
    setLoading(true); setLoadErr("");
    try {
      const klines = await fetchKlines(120);
      setCand(klines);
      setAlerts(a => [`✅ Loaded ${klines.length} live Binance 15M candles`,...a.slice(0,5)]);
    } catch(e) {
      setLoadErr(`Failed to load candles: ${e.message}`);
    }
    setLoading(false);
  }, []);

  /* ── WebSocket (public stream, CORS-free) ────────── */
  const connectWS = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current=null; }
    setWS("connecting"); setWSError("");

    const ws = new WebSocket(`${WS_BASE}/${SYMBOL.toLowerCase()}@kline_${INTERVAL}`);
    wsRef.current = ws;
    let pingInterval = null;

    ws.onopen = () => {
      setWS("live");
      setAlerts(a => [`🟢 WebSocket connected — live ${SYMBOL} 15M feed`,...a.slice(0,5)]);
      pingInterval = setInterval(() => { if (ws.readyState===1) ws.send(JSON.stringify({method:"ping"})); }, 20000);
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        const k   = msg.k;
        if (!k) return;

        
