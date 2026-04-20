// ══════════════════════════════════════════════════════════════════
//  INDIA PAPER TRADER v3 — 15 STRATEGIES
//  Nifty · BankNifty · Sensex — Yahoo Finance Live Prices
//  NO API KEY NEEDED — Paper trading only — 24x7 on Render
//
//  STRATEGIES (15):
//  1.  TrendMom      — Price + EMA + VWAP momentum
//  2.  EMACross      — 9/21 EMA crossover
//  3.  GapPlay       — Gap-up/down follow-through (9:15-9:40)
//  4.  RSIRev        — RSI extreme reversal
//  5.  VWAPBounce    — Price reclaims/rejects VWAP
//  6.  PivotReact    — S1/R1 pivot bounce
//  7.  MACDCross     — MACD histogram flip
//  8.  StrongClose   — Previous strong close follow-through
//  9.  InsideBar     — Inside day breakout
// 10.  ExpiryPlay    — Thursday ATM directional scalp
// 11.  HighVIX       — VIX spike fear buy
// 12.  WeekBreak     — Break of prev day high/low
// 13.  GapReversal   — Gap-up rejected / Gap-down filled
// 14.  ORR           — Opening Range Reversal (day high/low bounce)
// 15.  ExpiryRevert  — Expiry morning mean reversion to ATM
//
//  CAPITAL PROTECTION:
//  - Daily stop: 5% of capital
//  - Per trade: max 12% of capital
//  - Time stop: 150 minutes
//  - 5-phase ATR trailing stop
//  - Partial exit 50% at +40%
//  BUILD: npm install  |  START: node server.js
// ══════════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 10000;
const CAPITAL = parseFloat(process.env.CAPITAL || '100000');

// ── STATE ─────────────────────────────────────────────────────────
let capital = CAPITAL, startCap = CAPITAL;
let positions = [], closed = [], feed = [], logs = [];
let cycleCount = 0, botMode = 'AUTO';
let marketOpen = false, isExpiry = false;
let dailyPnL = 0, dailyStop = false;
let startTime = Date.now(), lastFetch = '—';
let partialExits = 0;

// ── INSTRUMENTS ───────────────────────────────────────────────────
const INST = {
  NIFTY: {
    sym:'%5ENSEI', name:'Nifty50', short:'NIFTY',
    lot:75, step:50, col:'#00ff88',
    ltp:24350, prev:24350, open:24350, high:0, low:0, vwap:24350,
    ema9:24350, ema21:24350, rsi:50, rsiPrev:50,
    macdH:0, prevMacdH:0, atr:80, change:0, pct:0,
    supertrend:'UP', prevST:'UP',
    prevH:24500, prevL:24200, prevC:24350, ok:false
  },
  BANKNIFTY: {
    sym:'%5ENSEBANK', name:'BankNifty', short:'BANKNIFTY',
    lot:35, step:100, col:'#00e5ff',
    ltp:52000, prev:52000, open:52000, high:0, low:0, vwap:52000,
    ema9:52000, ema21:52000, rsi:50, rsiPrev:50,
    macdH:0, prevMacdH:0, atr:250, change:0, pct:0,
    supertrend:'UP', prevST:'UP',
    prevH:52500, prevL:51500, prevC:52000, ok:false
  },
  SENSEX: {
    sym:'%5EBSESN', name:'Sensex', short:'SENSEX',
    lot:20, step:100, col:'#f4c430',
    ltp:80000, prev:80000, open:80000, high:0, low:0, vwap:80000,
    ema9:80000, ema21:80000, rsi:50, rsiPrev:50,
    macdH:0, prevMacdH:0, atr:400, change:0, pct:0,
    supertrend:'UP', prevST:'UP',
    prevH:80500, prevL:79500, prevC:80000, ok:false
  }
};
let globalVix = 15;

// Strategy stats per instrument
const SS = {};
const STRATS = ['TrendMom','EMACross','GapPlay','RSIRev','VWAPBounce',
  'PivotReact','MACDCross','StrongClose','InsideBar','ExpiryPlay',
  'HighVIX','WeekBreak','GapReversal','ORR','ExpiryRevert'];
Object.keys(INST).forEach(k => {
  SS[k] = {};
  STRATS.forEach(s => { SS[k][s] = {t:0, w:0}; });
});

function tlog(t,m){const l='['+new Date().toISOString().slice(11,19)+']['+t+'] '+m;console.log(l);logs.push(l);if(logs.length>200)logs.shift();}
function addFeed(ic,lb,msg,amt,side){feed.push({t:new Date().toISOString().slice(11,19),ic,lb,msg,amt:amt||'',side});if(feed.length>100)feed.shift();}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── YAHOO FINANCE FETCH ───────────────────────────────────────────
function yahooGet(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:host, path, method:'GET',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept':'application/json, */*',
        'Accept-Language':'en-US,en;q=0.9',
        'Referer':'https://finance.yahoo.com/',
        'Cache-Control':'no-cache'
      },
      timeout:10000
    }, r => {
      let d=''; r.on('data',x=>d+=x);
      r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
    req.end();
  });
}

async function fetchInst(key) {
  const I = INST[key];
  const now = Math.floor(Date.now()/1000), from = now-86400;
  const eps = [
    {host:'query1.finance.yahoo.com',path:`/v8/finance/chart/${I.sym}?period1=${from}&period2=${now}&interval=2m&includePrePost=false`},
    {host:'query2.finance.yahoo.com',path:`/v8/finance/chart/${I.sym}?period1=${from}&period2=${now}&interval=5m&includePrePost=false`},
    {host:'query1.finance.yahoo.com',path:`/v8/finance/chart/${I.sym}?period1=${from}&period2=${now}&interval=1d`},
  ];
  for(const ep of eps){
    try{
      const j=await yahooGet(ep.host,ep.path);
      const res=j?.chart?.result?.[0];
      if(!res) continue;
      const q=res.indicators?.quote?.[0];
      if(!q) continue;
      const closes=(q.close||[]).filter(v=>v!=null&&v>0);
      if(!closes.length) continue;
      const highs=(q.high||[]).filter(v=>v!=null&&v>0);
      const lows=(q.low||[]).filter(v=>v!=null&&v>0);
      const opens=(q.open||[]).filter(v=>v!=null&&v>0);
      I.prev=I.ltp;
      I.ltp=Math.round(closes[closes.length-1]);
      if(highs.length) I.high=Math.round(Math.max(...highs));
      if(lows.length)  I.low=Math.round(Math.min(...lows));
      if(opens.length) I.open=Math.round(opens[0]);
      if(I.high>0&&I.low>0) I.vwap=Math.round((I.high+I.low+I.ltp)/3);
      I.change=I.ltp-I.prev;
      I.pct=I.prev>0?+((I.ltp-I.prev)/I.prev*100).toFixed(2):0;
      I.ok=true;
      tlog('INFO',`${key}:${I.ltp}(${I.pct>0?'+':''}${I.pct}%) via ${ep.host}`);
      return true;
    }catch(e){tlog('WARN',`${key} fetch fail (${ep.host}): ${e.message}`);}
  }
  I.ok=false; return false;
}

async function fetchVix(){
  const now=Math.floor(Date.now()/1000);
  try{
    const j=await yahooGet('query1.finance.yahoo.com',`/v8/finance/chart/%5EINDIAVIX?period1=${now-86400}&period2=${now}&interval=1d`);
    const c=(j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close||[]).filter(v=>v>0);
    if(c.length) globalVix=+c[c.length-1].toFixed(1);
  }catch(e){globalVix=Math.max(10,Math.min(40,globalVix+(Math.random()-0.5)*0.3));}
}

function simInst(key){
  const I=INST[key];
  const noise=(Math.random()-0.49)*0.004;
  I.prev=I.ltp;
  I.ltp=Math.round(Math.max(key==='SENSEX'?50000:key==='BANKNIFTY'?30000:15000,I.ltp*(1+noise)));
  I.high=I.high?Math.max(I.high,I.ltp):I.ltp;
  I.low=I.low?Math.min(I.low,I.ltp):I.ltp;
  I.vwap=Math.round((I.high+I.low+I.ltp)/3);
  I.change=I.ltp-I.prev;
  I.pct=I.prev>0?+((I.ltp-I.prev)/I.prev*100).toFixed(2):0;
  I.ok=false;
}

function updateInd(key){
  const I=INST[key];
  I.ema9=I.ema9*(1-2/10)+I.ltp*(2/10);
  I.ema21=I.ema21*(1-2/22)+I.ltp*(2/22);
  I.rsiPrev=I.rsi;
  const chg=I.ltp-I.prev;
  if(chg>0) I.rsi=Math.min(82,I.rsi+Math.abs(chg)/I.ltp*380);
  else       I.rsi=Math.max(18,I.rsi-Math.abs(chg)/I.ltp*380);
  I.prevST=I.supertrend;
  I.supertrend=I.ltp>I.ema21?'UP':'DOWN';
  I.prevMacdH=I.macdH;
  const macd=I.ema9-I.ema21;
  I.macdH=macd-(I.macdH*0.85+macd*0.15);
  I.atr=Math.max(key==='SENSEX'?150:key==='BANKNIFTY'?100:40,Math.abs(I.high-I.low)*0.6||I.atr);
}

// ── MARKET SESSION ────────────────────────────────────────────────
function checkSession(){
  const ist=new Date(Date.now()+19800000);
  const day=ist.getUTCDay(), t=ist.getUTCHours()*60+ist.getUTCMinutes();
  const was=marketOpen;
  marketOpen=day>=1&&day<=5&&t>=555&&t<=930;
  isExpiry=day===4;
  if(!was&&marketOpen){
    dailyPnL=0;dailyStop=false;
    Object.keys(INST).forEach(k=>{const I=INST[k];I.high=0;I.low=0;I.open=I.ltp;});
    tlog('INFO','🔔 Market OPEN 9:15 AM IST'+(isExpiry?' [EXPIRY]':''));
    addFeed('🔔','MARKET OPEN','NSE/BSE opened. All 15 strategies scanning Nifty+BankNifty+Sensex.'+(isExpiry?' ⚡ Expiry day.':''),null,'info');
  }
  if(was&&!marketOpen){
    tlog('INFO','🔕 Market CLOSED 3:30 PM');
    squareAll('Market closed 3:30 PM IST');
    addFeed('🔕','MARKET CLOSED','All paper positions squared off at 3:30 PM.',null,'info');
  }
}
function tIST(){const ist=new Date(Date.now()+19800000);return ist.getUTCHours()*60+ist.getUTCMinutes();}
function noLate(){return tIST()<=870;}
function inWin(){const t=tIST();return(t>=570&&t<=690)||(t>=750&&t<=870);}

// ── 15 STRATEGIES ────────────────────────────────────────────────
function getSignals(key){
  const I=INST[key];
  const sigs=[];
  const t=tIST();
  if(!noLate()) return sigs;

  // 1. TREND MOMENTUM
  if(inWin()){
    if(I.pct>0.35&&I.ema9>I.ema21&&I.rsi>52&&I.rsi<72&&I.ltp>I.vwap)
      sigs.push({key,opt:'CE',strat:'TrendMom',conf:74,reason:`${I.short} +${I.pct}% + EMA bull + above VWAP. RSI:${I.rsi.toFixed(0)}.`});
    if(I.pct<-0.35&&I.ema9<I.ema21&&I.rsi<48&&I.rsi>28&&I.ltp<I.vwap)
      sigs.push({key,opt:'PE',strat:'TrendMom',conf:72,reason:`${I.short} ${I.pct}% + EMA bear + below VWAP. RSI:${I.rsi.toFixed(0)}.`});
  }

  // 2. EMA CROSS
  if(inWin()){
    if(I.supertrend==='UP'&&I.prevST==='DOWN'&&I.rsi>46&&I.rsi<68)
      sigs.push({key,opt:'CE',strat:'EMACross',conf:76,reason:`${I.short} EMA(9) crossed above EMA(21). Fresh bull cross. RSI:${I.rsi.toFixed(0)}.`});
    if(I.supertrend==='DOWN'&&I.prevST==='UP'&&I.rsi<54&&I.rsi>32)
      sigs.push({key,opt:'PE',strat:'EMACross',conf:74,reason:`${I.short} EMA(9) crossed below EMA(21). Fresh bear cross. RSI:${I.rsi.toFixed(0)}.`});
  }

  // 3. GAP PLAY (9:15-9:40, strict marketOpen guard)
  if(marketOpen&&t>=555&&t<=580&&I.open>0){
    const gp=(I.ltp-I.open)/I.open*100;
    if(gp>0.4&&I.ltp>I.open&&I.ema9>I.ema21)
      sigs.push({key,opt:'CE',strat:'GapPlay',conf:73,reason:`${I.short} gap-up ${gp.toFixed(2)}% follow-through. EMA bullish.`});
    if(gp<-0.4&&I.ltp<I.open&&I.ema9<I.ema21)
      sigs.push({key,opt:'PE',strat:'GapPlay',conf:71,reason:`${I.short} gap-down ${Math.abs(gp).toFixed(2)}% follow-through. EMA bearish.`});
  }

  // 4. RSI REVERSAL
  if(inWin()){
    if(I.rsiPrev<32&&I.rsi>34&&I.ltp>I.prev)
      sigs.push({key,opt:'CE',strat:'RSIRev',conf:75,reason:`${I.short} RSI oversold (${I.rsiPrev.toFixed(0)}) recovering to ${I.rsi.toFixed(0)}. Buy dip.`});
    if(I.rsiPrev>68&&I.rsi<66&&I.ltp<I.prev)
      sigs.push({key,opt:'PE',strat:'RSIRev',conf:73,reason:`${I.short} RSI overbought (${I.rsiPrev.toFixed(0)}) falling to ${I.rsi.toFixed(0)}. Sell top.`});
  }

  // 5. VWAP BOUNCE
  if(inWin()&&I.vwap>0){
    const dev=(I.ltp-I.vwap)/I.vwap*100;
    if(dev>0.15&&I.prev<I.vwap&&I.ltp>I.vwap&&I.rsi>50)
      sigs.push({key,opt:'CE',strat:'VWAPBounce',conf:75,reason:`${I.short} reclaimed VWAP (${I.vwap}). Institutional support. RSI:${I.rsi.toFixed(0)}.`});
    if(dev<-0.15&&I.prev>I.vwap&&I.ltp<I.vwap&&I.rsi<50)
      sigs.push({key,opt:'PE',strat:'VWAPBounce',conf:73,reason:`${I.short} broke below VWAP (${I.vwap}). Selling pressure. RSI:${I.rsi.toFixed(0)}.`});
  }

  // 6. PIVOT REACTION
  if(inWin()&&I.prevH&&I.prevL&&I.prevC){
    const pp=(I.prevH+I.prevL+I.prevC)/3;
    const s1=Math.round(2*pp-I.prevH), r1=Math.round(2*pp-I.prevL);
    if(Math.abs(I.ltp-s1)<I.atr*0.4&&I.rsi<45&&I.ltp>I.prev)
      sigs.push({key,opt:'CE',strat:'PivotReact',conf:74,reason:`${I.short} bouncing from S1 (${s1}). RSI ${I.rsi.toFixed(0)} turning up.`});
    if(Math.abs(I.ltp-r1)<I.atr*0.4&&I.rsi>55&&I.ltp<I.prev)
      sigs.push({key,opt:'PE',strat:'PivotReact',conf:72,reason:`${I.short} rejected at R1 (${r1}). RSI ${I.rsi.toFixed(0)} turning down.`});
  }

  // 7. MACD CROSS
  if(inWin()){
    if(I.macdH>0&&I.prevMacdH<=0&&I.ltp>I.prev&&I.rsi>46&&I.rsi<68)
      sigs.push({key,opt:'CE',strat:'MACDCross',conf:74,reason:`${I.short} MACD turned positive. Bull momentum. RSI:${I.rsi.toFixed(0)}.`});
    if(I.macdH<0&&I.prevMacdH>=0&&I.ltp<I.prev&&I.rsi<54&&I.rsi>32)
      sigs.push({key,opt:'PE',strat:'MACDCross',conf:72,reason:`${I.short} MACD turned negative. Bear momentum. RSI:${I.rsi.toFixed(0)}.`});
  }

  // 8. STRONG CLOSE (morning follow-through, 9:15-9:45 only)
  if(marketOpen&&t>=555&&t<=585&&I.prevH&&I.prevL&&I.prevC){
    const rng=I.prevH-I.prevL;
    if(rng>I.atr*0.5){
      const cp=(I.prevC-I.prevL)/rng;
      if(cp>0.78&&I.ltp>I.prevC&&I.ema9>I.ema21)
        sigs.push({key,opt:'CE',strat:'StrongClose',conf:73,reason:`${I.short} yesterday strong bull close (${(cp*100).toFixed(0)}%). Follow-through buying.`});
      if(cp<0.22&&I.ltp<I.prevC&&I.ema9<I.ema21)
        sigs.push({key,opt:'PE',strat:'StrongClose',conf:71,reason:`${I.short} yesterday strong bear close (${(cp*100).toFixed(0)}%). Follow-through selling.`});
    }
  }

  // 9. INSIDE BAR BREAKOUT
  if(inWin()&&I.high>0&&I.low>0&&I.prevH&&I.prevL){
    const tr=I.high-I.low, pr=I.prevH-I.prevL;
    if(pr>0&&tr<pr*0.55){
      if(I.ltp>I.prevH*1.001&&I.rsi>52)
        sigs.push({key,opt:'CE',strat:'InsideBar',conf:76,reason:`${I.short} inside bar breakout above ${I.prevH}. Volatility expansion. RSI:${I.rsi.toFixed(0)}.`});
      if(I.ltp<I.prevL*0.999&&I.rsi<48)
        sigs.push({key,opt:'PE',strat:'InsideBar',conf:74,reason:`${I.short} inside bar breakdown below ${I.prevL}. RSI:${I.rsi.toFixed(0)}.`});
    }
  }

  // 10. EXPIRY PLAY (Thursday, strict windows: 9:30-11 AM and 2-3:15 PM)
  if(marketOpen&&isExpiry&&((t>=570&&t<=660)||(t>=840&&t<=915))&&globalVix<28){
    if(I.ltp>I.vwap&&I.rsi>58&&I.ema9>I.ema21)
      sigs.push({key,opt:'CE',strat:'ExpiryPlay',conf:75,reason:`EXPIRY: ${I.short} above VWAP + EMA bull + RSI:${I.rsi.toFixed(0)}. Gamma CE.`});
    if(I.ltp<I.vwap&&I.rsi<42&&I.ema9<I.ema21)
      sigs.push({key,opt:'PE',strat:'ExpiryPlay',conf:73,reason:`EXPIRY: ${I.short} below VWAP + EMA bear + RSI:${I.rsi.toFixed(0)}. Gamma PE.`});
  }

  // 11. HIGH VIX FEAR BUY
  if(inWin()&&globalVix>22&&globalVix<38){
    if(I.rsi>38&&I.rsi<55&&I.ltp>I.prev)
      sigs.push({key,opt:'CE',strat:'HighVIX',conf:72,reason:`VIX ${globalVix.toFixed(1)} elevated. ${I.short} recovering from fear. CE buy.`});
  }

  // 12. WEEKLY BREAKOUT
  if(inWin()&&I.prevH&&I.prevL){
    if(I.ltp>I.prevH*1.002&&I.ltp>I.open&&I.rsi>55&&I.ema9>I.ema21)
      sigs.push({key,opt:'CE',strat:'WeekBreak',conf:74,reason:`${I.short} breakout above prev high (${I.prevH}). Momentum CE.`});
    if(I.ltp<I.prevL*0.998&&I.ltp<I.open&&I.rsi<45&&I.ema9<I.ema21)
      sigs.push({key,opt:'PE',strat:'WeekBreak',conf:72,reason:`${I.short} breakdown below prev low (${I.prevL}). Momentum PE.`});
  }

  // 13. GAP REVERSAL — catches gap-up rejection / gap-down recovery
  // This was the key missed move on April 17 expiry day
  if(marketOpen&&t>=555&&t<=620&&I.open>0&&I.prevC>0){
    const gapPct=(I.open-I.prevC)/I.prevC*100;
    const openRej=gapPct>0.3&&I.ltp<I.open*0.9985; // Gapped up but now below open
    const gapFill=gapPct<-0.3&&I.ltp>I.open*1.0015; // Gapped down but now above open
    if(openRej&&I.rsi<52&&I.ema9<I.ema21)
      sigs.push({key,opt:'PE',strat:'GapReversal',conf:78,reason:`${I.short} gap-up ${gapPct.toFixed(2)}% REJECTED. Price fell below open. Institutions sold the gap. PE.`});
    if(gapFill&&I.rsi>48&&I.ema9>I.ema21)
      sigs.push({key,opt:'CE',strat:'GapReversal',conf:76,reason:`${I.short} gap-down ${Math.abs(gapPct).toFixed(2)}% FILLED. Price bounced above open. Recovery CE.`});
  }

  // 14. ORR — Opening Range Reversal (catches day-low bounce / day-high rejection)
  // 9:45-12:00 PM window — after 30min range is established
  if(marketOpen&&t>=585&&t<=720&&I.high>0&&I.low>0){
    const dayRng=I.high-I.low;
    const nearLow=I.ltp<I.low+dayRng*0.08;
    const nearHigh=I.ltp>I.high-dayRng*0.08;
    if(nearLow&&I.ltp>I.prev&&I.rsi>35&&I.rsi<52&&dayRng>I.atr*0.5)
      sigs.push({key,opt:'CE',strat:'ORR',conf:77,reason:`${I.short} at day low (${I.low}) reversing up. RSI:${I.rsi.toFixed(0)}. Range:${dayRng}pts. Recovery CE.`});
    if(nearHigh&&I.ltp<I.prev&&I.rsi<65&&I.rsi>50&&dayRng>I.atr*0.5)
      sigs.push({key,opt:'PE',strat:'ORR',conf:75,reason:`${I.short} at day high (${I.high}) reversing down. RSI:${I.rsi.toFixed(0)}. Range:${dayRng}pts. Rejection PE.`});
  }

  // 15. EXPIRY REVERT — Mean reversion to ATM on expiry morning
  // Institutions pin strikes. Price far from ATM reverts back.
  if(marketOpen&&isExpiry&&t>=555&&t<=660&&I.ltp>0){
    const atm=Math.round(I.ltp/I.step)*I.step;
    const dist=Math.abs(I.ltp-atm)/atm*100;
    if(dist>0.5&&I.ltp>atm&&I.ltp<I.prev&&I.rsi>50)
      sigs.push({key,opt:'PE',strat:'ExpiryRevert',conf:76,reason:`EXPIRY: ${I.short} ${dist.toFixed(2)}% above ATM ${atm}. Pin pull. Mean revert PE.`});
    if(dist>0.5&&I.ltp<atm&&I.ltp>I.prev&&I.rsi<50)
      sigs.push({key,opt:'CE',strat:'ExpiryRevert',conf:74,reason:`EXPIRY: ${I.short} ${dist.toFixed(2)}% below ATM ${atm}. Pin pull up. Recovery CE.`});
  }

  return sigs
    .filter(s=>!positions.find(p=>p.strat===s.strat&&p.key===s.key))
    .filter(s=>s.conf>=72)
    .sort((a,b)=>b.conf-a.conf);
}

// ── POSITION SIZING + PREMIUM ─────────────────────────────────────
function getLots(key,conf){if(globalVix>30)return 1;return Math.min(2,Math.max(1,Math.floor(conf/60)));}
function getPrem(key){
  const I=INST[key];
  const iv=Math.max(12,globalVix*1.05)/100;
  const day=new Date(Date.now()+19800000).getUTCDay();
  const dte=Math.max(1,day<=4?4-day:4+(7-day));
  const p=Math.round(I.ltp*iv*Math.sqrt(dte/365)*0.42);
  const mn=key==='SENSEX'?50:key==='BANKNIFTY'?40:30;
  const mx=key==='SENSEX'?800:key==='BANKNIFTY'?600:400;
  return Math.max(mn,Math.min(mx,p));
}

// ── ENTER ────────────────────────────────────────────────────────
function enter(sig){
  const I=INST[sig.key];
  const lots=getLots(sig.key,sig.conf);
  const qty=lots*I.lot;
  const prem=getPrem(sig.key);
  const entry=Math.round(prem*1.015);
  const sl=Math.round(entry*0.60);
  const tp=Math.round(entry*1.65);
  const spent=entry*qty;
  if(spent>capital*0.12||capital<spent*1.1) return;
  const atm=Math.round(I.ltp/I.step)*I.step;
  const strike=sig.opt==='CE'?atm+I.step:atm-I.step;
  capital-=spent;
  const id=Date.now();
  positions.push({
    id,key:sig.key,inst:I.short,sym:`${I.short}_${strike}_${sig.opt}`,
    opt:sig.opt,strike,strat:sig.strat,conf:sig.conf,
    entry,cur:entry,peak:entry,sl,tp,
    trailFloor:sl,trailPhase:0,
    qty,spent,reason:sig.reason,
    openTime:id,partialDone:false,_ltpEntry:I.ltp
  });
  if(SS[sig.key]?.[sig.strat]) SS[sig.key][sig.strat].t++;
  tlog('TRADE',`PAPER BUY ${I.short} ${strike}${sig.opt} ₹${entry} qty:${qty} [${sig.strat}] conf:${sig.conf}%`);
  addFeed(sig.opt==='CE'?'📈':'📉',
    `📋 ${I.short} ${sig.strat} ${sig.opt}`,
    `${I.short} ${strike} ${sig.opt} | ${sig.reason.slice(0,75)}`,
    '₹'+spent.toFixed(0),'entry');
}

// ── 5-PHASE ATR TRAIL ────────────────────────────────────────────
function updateTrail(pos){
  const I=INST[pos.key];
  const pp=(pos.cur-pos.entry)/pos.entry*100;
  const atrP=(I?.atr||80)*0.5;
  let fl=null;
  if(pp>=80){fl=pos.peak*0.88;pos.trailPhase=4;}
  else if(pp>=50){fl=pos.peak-atrP*0.7;pos.trailPhase=3;}
  else if(pp>=30){fl=pos.peak-atrP*1.0;pos.trailPhase=2;}
  else if(pp>=15){fl=pos.peak-atrP*1.5;pos.trailPhase=1;}
  else{fl=pos.sl;pos.trailPhase=0;}
  const hm=(Date.now()-pos.openTime)/60000;
  if(hm>=30&&pp>0) fl=Math.max(fl,pos.entry*1.01);
  if(fl!==null&&fl>(pos.trailFloor||0)) pos.trailFloor=fl;
}

function checkPartial(pos){
  if(pos.partialDone) return;
  const pp=(pos.cur-pos.entry)/pos.entry*100;
  if(pp>=40){
    const hq=Math.floor(pos.qty/2),hpnl=(pos.cur-pos.entry)*hq;
    capital+=pos.entry*hq+hpnl;dailyPnL+=hpnl;
    pos.qty-=hq;pos.spent=pos.entry*pos.qty;
    pos.partialDone=true;partialExits++;
    tlog('TRADE',`PARTIAL ${pos.sym} 50% +${pp.toFixed(0)}% ₹${hpnl.toFixed(0)}`);
    addFeed('📤',`PARTIAL ${pos.inst} ${pos.strat}`,`${pos.sym} 50% off at +${pp.toFixed(0)}%. Half with trail.`,'+₹'+hpnl.toFixed(0),'win');
  }
}

function updatePosPx(pos){
  const I=INST[pos.key];
  if(!I) return;
  const mv=I.ltp>0&&pos._ltpEntry>0?(I.ltp-pos._ltpEntry)/pos._ltpEntry*100:0;
  const delta=pos.opt==='CE'?0.45:-0.45;
  const premMov=mv*delta*2.2;
  const noise=(Math.random()-0.50)*0.02;
  pos.cur=Math.max(1,Math.round(pos.entry*(1+premMov/100+noise)));
  if(pos.cur>pos.peak) pos.peak=pos.cur;
}

function checkExits(){
  for(let i=positions.length-1;i>=0;i--){
    const pos=positions[i];
    updatePosPx(pos);updateTrail(pos);checkPartial(pos);
    const pnl=(pos.cur-pos.entry)*pos.qty;
    const hm=(Date.now()-pos.openTime)/60000;
    let reason=null,type=null;
    if(pos.cur<=pos.sl){reason=`SL hit ₹${pos.cur}. Loss ₹${Math.abs(pnl).toFixed(0)}`;type='SL';}
    else if(pos.trailFloor>pos.sl&&pos.cur<pos.trailFloor&&pos.trailPhase>0){reason=`Trail Ph${pos.trailPhase} ₹${pos.cur}. Gain ₹${pnl.toFixed(0)}`;type='TRAIL';}
    else if(pos.cur>=pos.tp){reason=`Target +65% hit ₹${pos.cur}`;type='TP';}
    else if(!marketOpen){reason='Market closed EOD';type='EOD';}
    else if(hm>150){reason=`Time stop 150min ₹${pnl.toFixed(0)}`;type='TIME';}
    else if(globalVix>38){reason='VIX>38 black swan exit';type='VIX';}
    if(reason) doExit(pos,i,reason,pnl,type);
  }
}

function doExit(pos,idx,reason,pnl,type){
  capital+=pos.spent+pnl;dailyPnL+=pnl;
  closed.push({...pos,win:pnl>0,pnl,reason,type,exit:pos.cur,
    held:Math.round((Date.now()-pos.openTime)/60000),
    time:new Date().toISOString().slice(11,19)});
  if(SS[pos.key]?.[pos.strat]){SS[pos.key][pos.strat].t++;if(pnl>0)SS[pos.key][pos.strat].w++;}
  positions.splice(idx,1);
  const ic={SL:'🛑',TP:'💰',TRAIL:'📈',EOD:'🔕',TIME:'⏱',VIX:'⚡'};
  tlog('TRADE',`${type} ${pos.sym} ₹${pnl.toFixed(0)} [${pos.strat}]`);
  addFeed(ic[type]||'🔴',`📋 ${pos.inst} ${type} ${pos.strat}`,
    `${pos.sym} — ${reason}`,
    (pnl>=0?'+':'')+'₹'+Math.abs(pnl).toFixed(0),pnl>0?'win':'loss');
}

function squareAll(r){
  for(let i=positions.length-1;i>=0;i--){
    const p=positions[i];doExit(p,i,r||'Square off',(p.cur-p.entry)*p.qty,'EOD');
  }
}

function stopCheck(){
  if(dailyPnL<-(CAPITAL*0.05)&&!dailyStop){
    dailyStop=true;
    addFeed('🛡','DAILY STOP','5% daily loss limit hit. No new trades today.',null,'guard');
    tlog('WARN','DAILY STOP ₹'+dailyPnL.toFixed(0));
  }
  return !dailyStop;
}

// ── MAIN CYCLE ────────────────────────────────────────────────────
async function runCycle(){
  cycleCount++;
  checkSession();

  // Fetch all 3 instruments in parallel
  const results=await Promise.all([
    fetchInst('NIFTY'),fetchInst('BANKNIFTY'),fetchInst('SENSEX')
  ]);
  if(!results[0]) simInst('NIFTY');
  if(!results[1]) simInst('BANKNIFTY');
  if(!results[2]) simInst('SENSEX');

  // VIX every 5 cycles
  if(cycleCount%5===0) await fetchVix();

  Object.keys(INST).forEach(updateInd);
  lastFetch=new Date(Date.now()+19800000).toISOString().slice(11,16)+' IST';

  checkExits();

  if(marketOpen&&botMode==='AUTO'&&stopCheck()&&positions.length<6&&globalVix<36&&noLate()){
    const allSigs=[
      ...getSignals('NIFTY'),
      ...getSignals('BANKNIFTY'),
      ...getSignals('SENSEX'),
    ].sort((a,b)=>b.conf-a.conf);
    for(const sig of allSigs.slice(0,2)){
      if(positions.length<6) enter(sig);
    }
  }

  const pnl=positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  const tot=closed.length,wins=closed.filter(t=>t.win).length;
  const N=INST.NIFTY,BN=INST.BANKNIFTY,SX=INST.SENSEX;
  tlog('INFO',`#${cycleCount} [${botMode}] N:${N.ltp}(${N.ok?'live':'sim'}) BN:${BN.ltp}(${BN.ok?'live':'sim'}) SX:${SX.ltp}(${SX.ok?'live':'sim'}) VIX:${globalVix.toFixed(1)} Pos:${positions.length} Win:${tot?Math.round(wins/tot*100):0}% PnL:₹${pnl.toFixed(0)}`);
}

// ── DASHBOARD HTML ────────────────────────────────────────────────
function buildPage(tab){
  const totalPnL=positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  const wins=closed.filter(t=>t.win).length,tot=closed.length,losses=tot-wins;
  const wr=tot?Math.round(wins/tot*100):0;
  const up=Math.round((Date.now()-startTime)/60000);
  const mc=botMode==='AUTO'?'#00ff88':botMode==='MANUAL'?'#f4c430':'#ff3355';
  const pnlCol=totalPnL>=0?'#00ff88':'#ff3355';
  const ist=new Date(Date.now()+19800000).toISOString().slice(11,16)+' IST';
  const N=INST.NIFTY,BN=INST.BANKNIFTY,SX=INST.SENSEX;

  const feedHtml=!feed.length
    ?`<div style="font-family:monospace;font-size:11px;color:#253348;padding:18px;text-align:center">${marketOpen?'Scanning 15 strategies × 3 instruments...':'Market closed. Opens Mon-Fri 9:15 AM IST.'}</div>`
    :[...feed].reverse().slice(0,25).map(f=>{
      const col=f.side==='entry'?'#00ff88':f.side==='win'?'#00ff88':f.side==='loss'?'#ff3355':f.side==='guard'?'#ff8c00':'#5a6f96';
      return`<div style="display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #0f1624;border-left:3px solid ${col}"><div style="font-size:15px;width:20px;flex-shrink:0">${esc(f.ic)}</div><div style="flex:1;min-width:0"><div style="font-family:monospace;font-size:8px;color:#bb66ff;margin-bottom:2px;font-weight:700">${esc(f.lb)}</div><div style="font-family:monospace;font-size:10px;color:#5a6f96;line-height:1.5">${esc(f.msg)}</div></div><div style="text-align:right;flex-shrink:0">${f.amt?`<div style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${esc(f.amt)}</div>`:''}<div style="font-family:monospace;font-size:7px;color:#253348;margin-top:2px">${esc(f.t)}</div></div></div>`;
    }).join('');

  const posHtml=!positions.length
    ?`<div style="font-family:monospace;font-size:11px;color:#253348;padding:14px;text-align:center">No positions. ${marketOpen?'Scanning 15 strategies...':'Market closed.'}</div>`
    :positions.map(pos=>{
      const I=INST[pos.key];
      const pnl=(pos.cur-pos.entry)*pos.qty,pp=(pos.cur/pos.entry-1)*100;
      const col=pnl>=0?'#00ff88':'#ff3355';
      const hm=Math.round((Date.now()-pos.openTime)/60000);
      const phl=['Fixed SL','1.5×ATR','1×ATR','0.7×ATR','0.4×ATR'];
      const ic=I?.col||'#5a6f96';
      return`<div style="padding:11px;border:1px solid #0f1624;border-radius:10px;background:#06080e;margin-bottom:8px;border-left:3px solid ${col}">
        <div style="display:flex;justify-content:space-between;margin-bottom:7px">
          <div>
            <div style="font-weight:700;font-size:12px">
              <span style="font-family:monospace;font-size:8px;padding:2px 6px;border-radius:3px;background:${ic}18;border:1px solid ${ic}44;color:${ic};margin-right:4px">${esc(pos.inst)}</span>
              ${esc(pos.strike)} ${esc(pos.opt)}
              <span style="font-family:monospace;font-size:8px;padding:2px 5px;border-radius:3px;border:1px solid rgba(187,102,255,.3);background:rgba(187,102,255,.1);color:#bb66ff;margin-left:3px">${esc(pos.strat)}</span>
              ${pos.partialDone?'<span style="font-family:monospace;font-size:7px;color:#f4c430;margin-left:4px">½ SOLD</span>':''}
            </div>
            <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:2px">📋 PAPER · ${hm}m · conf:${pos.conf}%</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:${col}">${(pnl>=0?'+':'')+'₹'+Math.abs(pnl).toFixed(0)}</div>
            <div style="font-family:monospace;font-size:8px;color:#5a6f96">${pp.toFixed(1)}%</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:7px">
          ${[['Entry','₹'+pos.entry,'#dde8ff'],['LTP','₹'+pos.cur,'#00e5ff'],['Peak','₹'+pos.peak,'#f4c430'],['Target','₹'+pos.tp,'#00ff88']]
            .map(([l,v,c])=>`<div style="font-family:monospace;font-size:9px;padding:4px;background:#090b15;border-radius:5px;border:1px solid #0f1624"><span style="color:#253348;display:block">${l}</span><span style="color:${c};font-weight:600">${v}</span></div>`).join('')}
        </div>
        <div style="background:rgba(255,229,102,.04);border:1px solid rgba(255,229,102,.12);border-radius:6px;padding:6px 9px">
          <div style="font-family:monospace;font-size:7px;color:#ffe566;margin-bottom:4px">TRAIL Ph${pos.trailPhase}: ${phl[pos.trailPhase]||'—'} · Floor: ₹${(pos.trailFloor||pos.sl).toFixed(0)} · Locked: ${pos.trailPhase>0?'+'+((pos.trailFloor/pos.entry-1)*100).toFixed(1)+'%':'—'}</div>
        </div>
        <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:6px">${esc(pos.reason.slice(0,90))}</div>
      </div>`;
    }).join('');

  // Strategy bars grouped by instrument
  const scols={TrendMom:'#ff8c00',EMACross:'#00e5ff',GapPlay:'#f4c430',RSIRev:'#bb66ff',VWAPBounce:'#4499ff',PivotReact:'#ff8c00',MACDCross:'#00ff88',StrongClose:'#ffe566',InsideBar:'#00e5ff',ExpiryPlay:'#ff3355',HighVIX:'#f4c430',WeekBreak:'#00ff88',GapReversal:'#ff3355',ORR:'#bb66ff',ExpiryRevert:'#ffe566'};
  const stratBars=Object.keys(INST).map(k=>{
    const I=INST[k];
    const bars=Object.entries(SS[k]).map(([s,v])=>{
      if(!v.t)return'';
      const r=Math.round(v.w/v.t*100);
      return`<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span style="font-family:monospace;font-size:7px;color:#5a6f96;width:90px;flex-shrink:0">${s}</span><div style="flex:1;height:3px;background:#0f1624;border-radius:2px;overflow:hidden"><div style="height:100%;width:${r}%;background:${scols[s]||'#5a6f96'};border-radius:2px"></div></div><span style="font-family:monospace;font-size:7px;color:${scols[s]||'#5a6f96'};min-width:45px;text-align:right">${r}% (${v.t})</span></div>`;
    }).join('');
    return bars?`<div style="margin-bottom:10px"><div style="font-family:monospace;font-size:7px;letter-spacing:2px;color:${I.col};margin-bottom:5px;text-transform:uppercase">${k}</div>${bars}</div>`:'';
  }).join('');

  const histHtml=!closed.length
    ?'<div style="font-family:monospace;font-size:11px;color:#253348;padding:10px;text-align:center">No closed trades yet.</div>'
    :[...closed].reverse().slice(0,30).map(t=>{
      const I=INST[t.key];const ic=I?.col||'#5a6f96';
      const col=t.win?'#00ff88':'#ff3355';
      return`<div style="display:flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid #0f1624;border-radius:8px;background:#06080e;margin-bottom:5px;border-left:3px solid ${col}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;flex-wrap:wrap">
            <span style="font-family:monospace;font-size:8px;padding:1px 5px;border-radius:3px;background:${ic}18;color:${ic};border:1px solid ${ic}44">${esc(t.inst)}</span>
            <span style="font-weight:700;font-size:11px;color:#dde8ff">${esc(t.strike)} ${esc(t.opt)}</span>
            <span style="font-family:monospace;font-size:8px;padding:1px 4px;border-radius:3px;font-weight:700;background:${t.win?'rgba(0,255,136,.12)':'rgba(255,51,85,.1)'};color:${col};border:1px solid ${col}">${t.win?'WIN':'LOSS'}</span>
            <span style="font-family:monospace;font-size:8px;color:#bb66ff;border:1px solid rgba(187,102,255,.2);padding:1px 4px;border-radius:3px">${esc(t.strat)}</span>
            <span style="font-family:monospace;font-size:7px;color:#253348">${esc(t.type)}</span>
          </div>
          <div style="font-family:monospace;font-size:8px;color:#253348">${esc(t.reason.slice(0,65))} · ${t.held}m · ${esc(t.time)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${(t.pnl>=0?'+':'')+'₹'+Math.abs(t.pnl).toFixed(0)}</div>
        </div>
      </div>`;
    }).join('');

  const logHtml=logs.slice(-60).reverse().map(l=>{
    const col=l.includes('[TRADE]')?'#00ff88':l.includes('[WARN]')?'#ff8c00':l.includes('[ERROR]')?'#ff3355':'#00e5ff';
    return`<div style="margin-bottom:1px"><span style="color:#253348">${esc(l.slice(0,11))}</span><span style="color:${col}">${esc(l.slice(11))}</span></div>`;
  }).join('');

  const tabs=['feed','pos','hist','log'];
  const tlb={feed:'📡 Feed',pos:`📊 Pos(${positions.length})`,hist:`📈 Hist(${tot})`,log:'🖥 Log'};
  const tc={feed:'#00ff88',pos:'#bb66ff',hist:'#f4c430',log:'#00e5ff'};

  return`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>India Paper Trader v3 — ${botMode}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}
.tabs{display:flex;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:9px 12px;font-weight:700;font-size:10px;border-bottom:3px solid transparent;color:#253348;white-space:nowrap;flex-shrink:0;text-decoration:none;display:block}
.pg{display:none;padding:11px}.pg.act{display:block}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.ld{width:5px;height:5px;border-radius:50%;background:${marketOpen?'#00ff88':'#253348'};box-shadow:0 0 5px ${marketOpen?'#00ff88':'transparent'};animation:bl 1.8s infinite;display:inline-block;vertical-align:middle}
.mbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:8px;font-family:monospace;font-size:9px;font-weight:700;text-decoration:none;border:1.5px solid}
</style>
</head><body>

<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:8px 12px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span style="font-family:'Bebas Neue',cursive;font-size:13px;letter-spacing:2px;background:linear-gradient(90deg,#00ff88,#f4c430);-webkit-background-clip:text;-webkit-text-fill-color:transparent">PAPER TRADER v3</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:5px;border:1px solid rgba(0,229,255,.3);color:#00e5ff">📋 PAPER</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:5px;border:1px solid ${marketOpen?'rgba(0,255,136,.3)':'#253348'};color:${marketOpen?'#00ff88':'#5a6f96'}">${marketOpen?'● OPEN':'● CLOSED'}</span>
      ${isExpiry?'<span style="font-family:monospace;font-size:7px;padding:2px 5px;border-radius:5px;border:1px solid rgba(255,229,102,.3);color:#ffe566">⚡ EXPIRY</span>':''}
    </div>
    <div style="text-align:right">
      <div style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:#f4c430">₹${capital.toFixed(0)}</div>
      <div style="font-family:monospace;font-size:7px;color:#253348">${esc(ist)} · #${cycleCount}</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:6px">
    <span style="font-family:monospace;font-size:8px;color:#253348">MODE:</span>
    <a href="/set?mode=AUTO&from=${tab}" class="mbtn" style="color:#00ff88;border-color:rgba(0,255,136,.4);background:${botMode==='AUTO'?'rgba(0,255,136,.18)':'rgba(0,255,136,.05)'}">🤖 AUTO</a>
    <a href="/set?mode=MANUAL&from=${tab}" class="mbtn" style="color:#f4c430;border-color:rgba(244,196,48,.4);background:${botMode==='MANUAL'?'rgba(244,196,48,.18)':'rgba(244,196,48,.05)'}">🎮 MANUAL</a>
    <a href="/set?mode=OFF&from=${tab}" class="mbtn" style="color:#ff3355;border-color:rgba(255,51,85,.4);background:${botMode==='OFF'?'rgba(255,51,85,.18)':'rgba(255,51,85,.05)'}">🛑 OFF</a>
    <span style="margin-left:auto;font-family:monospace;font-size:8px;color:${mc}">● ${botMode}</span>
  </div>
</div>

<div style="background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto">
  <div style="display:flex;min-width:max-content">
    ${[['NIFTY',N],['BANKNIFTY',BN],['SENSEX',SX]].map(([nm,I])=>`
    <div style="padding:8px 10px;border-right:1px solid #0f1624;min-width:110px">
      <div style="font-family:monospace;font-size:7px;color:${I.col};letter-spacing:1.5px;font-weight:700;margin-bottom:3px">${nm}</div>
      <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:#dde8ff">${I.ltp.toLocaleString('en-IN')}</div>
      <div style="font-family:monospace;font-size:9px;font-weight:700;color:${I.pct>=0?'#00ff88':'#ff3355'};margin-top:1px">${I.pct>=0?'+':''}${I.pct}%</div>
      <div style="font-family:monospace;font-size:7px;color:#253348;margin-top:1px">VWAP:${I.vwap} ${I.ok?'●live':'○sim'}</div>
    </div>`).join('')}
    <div style="padding:8px 10px;flex-shrink:0;display:flex;flex-direction:column;justify-content:center;gap:2px">
      <div style="font-family:monospace;font-size:7px;color:#253348">VIX</div>
      <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:${globalVix>25?'#ff3355':globalVix>18?'#f4c430':'#00ff88'}">${globalVix.toFixed(1)}</div>
      <div style="display:flex;align-items:center;gap:3px"><span class="ld"></span><span style="font-family:monospace;font-size:7px;color:${marketOpen?'#00ff88':'#5a6f96'}">${marketOpen?'LIVE':'WAIT'}</span></div>
    </div>
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(4,1fr);background:#06080e;border-bottom:1px solid #0f1624">
  ${[['P&L',(totalPnL>=0?'+':'')+'₹'+totalPnL.toFixed(0),pnlCol,'total'],
     ['Win%',tot?wr+'%':'—','#f4c430',tot?wins+'W '+losses+'L':'—'],
     ['Trades',tot,'#bb66ff',positions.length+' open'],
     ['Daily',(dailyPnL>=0?'+':'')+'₹'+dailyPnL.toFixed(0),dailyPnL>=0?'#00ff88':'#ff3355',dailyStop?'⛔STOPPED':'✓OK(5%)']]
    .map(([l,v,c,s])=>`<div style="padding:6px 7px;border-right:1px solid #0f1624">
      <div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">${l}</div>
      <div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${c}">${v}</div>
      <div style="font-family:monospace;font-size:7px;color:#253348">${s}</div>
    </div>`).join('')}
</div>

<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 12px;background:#090b15;border-bottom:1px solid #0f1624;font-family:monospace;font-size:8px;color:#5a6f96">
  <span>Data: <strong style="color:${INST.NIFTY.ok?'#00ff88':'#f4c430'}">${INST.NIFTY.ok?'Yahoo Finance (live)':'Simulated (mkt closed)'}</strong></span>
  <span>Last: <strong style="color:#dde8ff">${esc(lastFetch)}</strong></span>
  <span>Up: <strong style="color:#dde8ff">${up}m</strong></span>
</div>

<div class="tabs">${tabs.map(t=>`<a class="tab" href="/?tab=${t}" style="color:${tab===t?tc[t]:'#253348'};border-bottom:3px solid ${tab===t?tc[t]:'transparent'}">${tlb[t]}</a>`).join('')}</div>

<div class="pg ${tab==='feed'?'act':''}" id="pg-feed">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-family:monospace;font-size:8px;letter-spacing:1.5px;color:#253348;text-transform:uppercase">15 STRATEGIES · NIFTY + BANKNIFTY + SENSEX</div>
    <a href="/?tab=feed" style="background:rgba(244,196,48,.08);border:1px solid rgba(244,196,48,.3);color:#f4c430;font-family:monospace;font-size:9px;padding:5px 12px;border-radius:6px;text-decoration:none">↻</a>
  </div>
  <div style="background:#090b15;border:1px solid ${marketOpen?'rgba(0,255,136,.2)':'#162030'};border-radius:10px;padding:11px;margin-bottom:10px">
    <div style="font-family:monospace;font-size:8px;color:${marketOpen?'#00ff88':'#5a6f96'};letter-spacing:2px;margin-bottom:6px">${marketOpen?'🟢 MARKET OPEN — 15 STRATEGIES ACTIVE':'🔴 MARKET CLOSED — WAITING FOR 9:15 AM IST'}</div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.7">
      <strong style="color:#00ff88">Nifty:</strong> ${N.ltp} · <strong style="color:#00e5ff">BankNifty:</strong> ${BN.ltp} · <strong style="color:#f4c430">Sensex:</strong> ${SX.ltp.toLocaleString('en-IN')}<br>
      <strong style="color:#dde8ff">Daily SL:</strong> <span style="color:${dailyStop?'#ff3355':'#00ff88'}">${dailyStop?'⛔ HIT':'✓ OK (5%)'}</span> · <strong style="color:#dde8ff">Positions:</strong> ${positions.length}/6 · <strong style="color:#dde8ff">Partial exits:</strong> ${partialExits}
    </div>
  </div>
  ${feedHtml}
</div>

<div class="pg ${tab==='pos'?'act':''}" id="pg-pos">
  <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#253348;text-transform:uppercase;margin-bottom:8px;display:flex;justify-content:space-between">
    <span>PAPER POSITIONS — 5-PHASE ATR TRAIL</span><span style="color:#f4c430">${positions.length}/6 open</span>
  </div>
  ${posHtml}
</div>

<div class="pg ${tab==='hist'?'act':''}" id="pg-hist">
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:12px;margin-bottom:9px">
    <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#b8880a;margin-bottom:9px">PERFORMANCE — ALL 3 INSTRUMENTS — 15 STRATEGIES</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px">
      ${[['Total P&L',(totalPnL>=0?'+':'')+'₹'+totalPnL.toFixed(0),pnlCol],
         ['Win Rate',tot?wr+'%':'—',wr>=55?'#00ff88':wr>=45?'#f4c430':'#ff3355'],
         ['Total Trades',tot,'#bb66ff'],
         ['Capital','₹'+capital.toFixed(0),'#f4c430'],
         ['Partials',partialExits,'#ffe566'],
         ['Daily P&L',(dailyPnL>=0?'+':'')+'₹'+dailyPnL.toFixed(0),dailyPnL>=0?'#00ff88':'#ff3355']]
        .map(([l,v,c])=>`<div style="padding:6px;background:#020409;border-radius:6px;border:1px solid #0f1624"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">${l}</div><div style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
    </div>
    <div style="font-family:monospace;font-size:8px;color:#253348;text-transform:uppercase;margin-bottom:5px">STRATEGY WIN RATES BY INSTRUMENT</div>
    ${stratBars||'<div style="font-family:monospace;font-size:9px;color:#253348">No trades yet. Waiting for 9:15 AM IST.</div>'}
  </div>
  ${histHtml}
</div>

<div class="pg ${tab==='log'?'act':''}" id="pg-log">
  <a href="/?tab=log" style="background:rgba(244,196,48,.08);border:1px solid rgba(244,196,48,.3);color:#f4c430;font-family:monospace;font-size:9px;padding:5px 12px;border-radius:6px;text-decoration:none;display:inline-block;margin-bottom:10px">↻ REFRESH</a>
  <div style="background:#020408;border:1px solid #0f1624;border-radius:8px;padding:9px 11px;font-family:monospace;font-size:9px;line-height:1.8;max-height:420px;overflow-y:auto;color:#5a6f96">${logHtml||'<span style="color:#253348">No log yet.</span>'}</div>
</div>

<script>setTimeout(function(){window.location.reload();},30000);</script>
</body></html>`;
}

// ── HTTP SERVER ────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){
    const N=INST.NIFTY,BN=INST.BANKNIFTY,SX=INST.SENSEX;
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end(`OK paper-v3-15strats mode=${botMode} market=${marketOpen} N:${N.ltp}(${N.ok?'live':'sim'}) BN:${BN.ltp}(${BN.ok?'live':'sim'}) SX:${SX.ltp}(${SX.ok?'live':'sim'}) vix=${globalVix.toFixed(1)} open=${positions.length} closed=${closed.length} cycle=${cycleCount}`);
    return;
  }
  if(url.pathname==='/set'){
    const p=url.searchParams,from=p.get('from')||'feed';
    if(p.has('mode')&&['AUTO','MANUAL','OFF'].includes(p.get('mode'))){
      botMode=p.get('mode');tlog('INFO','Mode → '+botMode);
      addFeed(botMode==='AUTO'?'🤖':botMode==='MANUAL'?'🎮':'🛑','MODE: '+botMode,
        botMode==='AUTO'?'Auto-trading all 15 strategies resumed.':
        botMode==='MANUAL'?'Auto-trading paused.':'All trading stopped.',null,'info');
    }
    if(p.has('reset')&&p.get('reset')==='1'){
      positions=[];closed=[];capital=startCap;dailyPnL=0;dailyStop=false;
      cycleCount=0;feed=[];logs=[];partialExits=0;
      Object.keys(INST).forEach(k=>Object.keys(SS[k]).forEach(s=>{SS[k][s]={t:0,w:0};}));
      tlog('INFO','Reset done');
    }
    res.writeHead(302,{'Location':'/?tab='+from});res.end();return;
  }
  if(url.pathname==='/reset'){
    positions=[];closed=[];capital=startCap;dailyPnL=0;dailyStop=false;
    cycleCount=0;feed=[];logs=[];partialExits=0;
    Object.keys(INST).forEach(k=>Object.keys(SS[k]).forEach(s=>{SS[k][s]={t:0,w:0};}));
    tlog('INFO','Full reset via /reset');
    res.writeHead(302,{'Location':'/'});res.end();return;
  }
  try{
    const tab=url.searchParams.get('tab')||'feed';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache, no-store'});
    res.end(buildPage(tab));
  }catch(e){
    tlog('ERROR','buildPage: '+e.message);
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('PAPER TRADER v3 OK\nCycle:'+cycleCount+'\nErr:'+e.message);
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  tlog('INFO','════════════════════════════════════════════════════');
  tlog('INFO',' INDIA PAPER TRADER v3 — 15 STRATEGIES — PORT '+PORT);
  tlog('INFO','════════════════════════════════════════════════════');
  tlog('INFO','Instruments: Nifty50 (lot:75) + BankNifty (lot:35) + Sensex (lot:20)');
  tlog('INFO','Data: Yahoo Finance ^NSEI ^NSEBANK ^BSESN ^INDIAVIX (free, no key)');
  tlog('INFO','Strategies (15): TrendMom · EMACross · GapPlay · RSIRev · VWAPBounce');
  tlog('INFO','   PivotReact · MACDCross · StrongClose · InsideBar · ExpiryPlay');
  tlog('INFO','   HighVIX · WeekBreak · GapReversal · ORR · ExpiryRevert');
  tlog('INFO','Trail: 5-phase ATR · Partial exit +40% · Time stop 150min');
  tlog('INFO','Risk: Daily 5% stop · Per trade 12% max · Max 6 positions');
  tlog('INFO','Market: Mon-Fri 9:15 AM – 3:30 PM IST (auto-detected)');
  tlog('INFO','Reset anytime: visit /reset endpoint');
  tlog('INFO','UptimeRobot: ping /health every 5min to prevent Render sleep');
  runCycle();
  setInterval(runCycle,30000);
});
server.on('error',e=>{console.error('FATAL:',e.message);process.exit(1);});
