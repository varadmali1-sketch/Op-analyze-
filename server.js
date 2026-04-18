// ═══════════════════════════════════════════════════════════════════
//  NIFTY OPTION CHAIN ANALYZER — GOD LEVEL PRO
//  Free NSE India API — No login, no API key
//  Live Greeks (Black-Scholes) · OI Analysis · FII/Retail Sentiment
//  Max Pain · PCR · IV Skew · Signal Engine · Auto-refresh
//  BUILD: npm install  |  START: node server.js
// ═══════════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 10000;

// ── STATE ────────────────────────────────────────────────────────
let chainData   = null;   // raw NSE option chain
let analyzed    = null;   // processed analysis
let lastFetch   = '—';
let fetchCount  = 0;
let isFetching  = false;
let fetchError  = null;
let symbol      = 'NIFTY'; // NIFTY | BANKNIFTY | FINNIFTY

// NSE session cookies (needed to bypass NSE's basic bot protection)
let nseSessionCookies = '';
let cookieExpiry = 0;

// ── NSE COOKIE REFRESH ──────────────────────────────────────────
async function getNSECookies() {
  if (nseSessionCookies && Date.now() < cookieExpiry) return nseSessionCookies;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      timeout: 10000
    }, r => {
      const cookies = r.headers['set-cookie'] || [];
      nseSessionCookies = cookies.map(c => c.split(';')[0]).join('; ');
      cookieExpiry = Date.now() + 600000; // 10 min
      let d = ''; r.on('data', x => d += x); r.on('end', () => resolve(nseSessionCookies));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

// ── FETCH NSE OPTION CHAIN ──────────────────────────────────────
async function fetchChain(sym) {
  const cookies = await getNSECookies();
  return new Promise((resolve, reject) => {
    const path = `/api/option-chain-indices?symbol=${sym}`;
    const req = https.request({
      hostname: 'www.nseindia.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/option-chain',
        'Cookie': cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Connection': 'keep-alive',
      },
      timeout: 12000
    }, r => {
      const chunks = [];
      r.on('data', x => chunks.push(x));
      r.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          const j = JSON.parse(raw);
          if (j?.records?.data) resolve(j);
          else reject(new Error('Invalid NSE response'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('NSE timeout')); });
    req.end();
  });
}

// ── BLACK-SCHOLES ENGINE ────────────────────────────────────────
function normCDF(x) {
  const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
  const s=x<0?-1:1; x=Math.abs(x);
  const t=1/(1+p*x);
  let y=1-(((((a[4]*t+a[3])*t)+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x);
  return 0.5*(1+s*y);
}
function normPDF(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

function bs(S, K, T, r, sigma, isCall) {
  if(T<=0||sigma<=0) return {price:Math.max(0,isCall?S-K:K-S),delta:isCall?1:0,gamma:0,theta:0,vega:0,rho:0};
  const d1=(Math.log(S/K)+(r+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  const sqT=Math.sqrt(T);
  const expRT=Math.exp(-r*T);
  let price,delta,gamma,theta,vega,rho;
  if(isCall){
    price=S*normCDF(d1)-K*expRT*normCDF(d2);
    delta=normCDF(d1);
    rho=K*T*expRT*normCDF(d2)/100;
  } else {
    price=K*expRT*normCDF(-d2)-S*normCDF(-d1);
    delta=normCDF(d1)-1;
    rho=-K*T*expRT*normCDF(-d2)/100;
  }
  gamma=normPDF(d1)/(S*sigma*sqT);
  theta=(-S*normPDF(d1)*sigma/(2*sqT) - (isCall?1:-1)*r*K*expRT*normCDF((isCall?1:-1)*d2))/365;
  vega=S*normPDF(d1)*sqT/100;
  return {price:Math.max(0,price),delta:+delta.toFixed(4),gamma:+gamma.toFixed(6),theta:+theta.toFixed(4),vega:+vega.toFixed(4),rho:+rho.toFixed(4)};
}

// Newton-Raphson IV solver
function calcIV(price, S, K, T, r, isCall, initGuess=0.3) {
  if(T<=0||price<=0) return 0;
  let sigma=initGuess;
  for(let i=0;i<100;i++){
    const g=bs(S,K,T,r,sigma,isCall);
    const diff=g.price-price;
    if(Math.abs(diff)<0.001) return sigma;
    if(Math.abs(g.vega*100)<0.00001) break;
    sigma=sigma-diff/(g.vega*100);
    if(sigma<=0) sigma=0.001;
    if(sigma>5) sigma=5;
  }
  return sigma;
}

// ── PROCESS & ANALYZE CHAIN ─────────────────────────────────────
function analyzeChain(raw, sym) {
  const records = raw.records;
  const filtered = raw.filtered;
  const spot = records.underlyingValue;
  const expiries = [...new Set(records.data.map(d=>d.expiryDate))];
  const nearExpiry = expiries[0];
  
  // IST date/time
  const now = new Date(Date.now()+19800000);
  const T = (() => {
    const exp = new Date(nearExpiry);
    exp.setHours(15,30,0,0);
    const ms = exp - now;
    return Math.max(0, ms/(1000*60*60*24*365));
  })();
  const r = 0.065; // risk-free rate

  // Filter to near-expiry, ATM ±15 strikes
  const atmStrike = Math.round(spot / (sym==='NIFTY'?50:100)) * (sym==='NIFTY'?50:100);
  const step = sym==='NIFTY'?50:100;
  const strikes = [];
  for(let i=-15;i<=15;i++) strikes.push(atmStrike+i*step);

  const rows = [];
  let totalCEOI=0, totalPEOI=0;
  let totalCEVol=0, totalPEVol=0;
  let totalCEOIChg=0, totalPEOIChg=0;

  // Process each strike
  const dataMap = {};
  records.data.filter(d=>d.expiryDate===nearExpiry).forEach(d=>{
    if(!dataMap[d.strikePrice]) dataMap[d.strikePrice]={};
    if(d.CE) dataMap[d.strikePrice].ce=d.CE;
    if(d.PE) dataMap[d.strikePrice].pe=d.PE;
  });

  strikes.forEach(strike => {
    const d = dataMap[strike] || {};
    const ce = d.ce || {};
    const pe = d.pe || {};
    const isATM = strike === atmStrike;
    const moneyness = ((spot-strike)/spot*100).toFixed(2);

    // CE data
    const ceLTP   = ce.lastPrice  || 0;
    const ceOI    = ce.openInterest || 0;
    const ceOIChg = ce.changeinOpenInterest || 0;
    const ceVol   = ce.totalTradedVolume || 0;
    const ceIVraw = ce.impliedVolatility || 0;

    // PE data
    const peLTP   = pe.lastPrice  || 0;
    const peOI    = pe.openInterest || 0;
    const peOIChg = pe.changeinOpenInterest || 0;
    const peVol   = pe.totalTradedVolume || 0;
    const peIVraw = pe.impliedVolatility || 0;

    // Compute Greeks via BS
    const ceIV = ceIVraw>0 ? ceIVraw/100 : (ceLTP>0 ? calcIV(ceLTP,spot,strike,T,r,true) : 0.15);
    const peIV = peIVraw>0 ? peIVraw/100 : (peLTP>0 ? calcIV(peLTP,spot,strike,T,r,false) : 0.15);
    const ceG  = ceLTP>0 ? bs(spot,strike,T,r,ceIV,true)  : {delta:0,gamma:0,theta:0,vega:0,rho:0};
    const peG  = peLTP>0 ? bs(spot,strike,T,r,peIV,false) : {delta:0,gamma:0,theta:0,vega:0,rho:0};

    totalCEOI+=ceOI; totalPEOI+=peOI;
    totalCEVol+=ceVol; totalPEVol+=peVol;
    totalCEOIChg+=ceOIChg; totalPEOIChg+=peOIChg;

    // OI interpretation
    const ceAction = ceOIChg>0 && ceLTP>0 ? (ceLTP>=(ce.previousClose||ceLTP)?'LONG_BUILD':'SHORT_BUILD') : (ceOIChg<0?'UNWINDING':'—');
    const peAction = peOIChg>0 && peLTP>0 ? (peLTP>=(pe.previousClose||peLTP)?'LONG_BUILD':'SHORT_BUILD') : (peOIChg<0?'UNWINDING':'—');

    rows.push({
      strike, isATM, moneyness,
      ce:{ltp:ceLTP,oi:ceOI,oiChg:ceOIChg,vol:ceVol,iv:+(ceIV*100).toFixed(2),
          delta:ceG.delta,gamma:ceG.gamma,theta:ceG.theta,vega:ceG.vega,action:ceAction,
          bid:ce.bidprice||0,ask:ce.askPrice||0},
      pe:{ltp:peLTP,oi:peOI,oiChg:peOIChg,vol:peVol,iv:+(peIV*100).toFixed(2),
          delta:peG.delta,gamma:peG.gamma,theta:peG.theta,vega:peG.vega,action:peAction,
          bid:pe.bidprice||0,ask:pe.askPrice||0},
    });
  });

  // ── MAX PAIN ───────────────────────────────────────────────────
  let maxPainStrike=atmStrike, minPain=Infinity;
  rows.forEach(r2=>{
    let pain=0;
    rows.forEach(r3=>{
      pain+=r3.ce.oi*Math.max(0,r3.strike-r2.strike);
      pain+=r3.pe.oi*Math.max(0,r2.strike-r3.strike);
    });
    if(pain<minPain){minPain=pain;maxPainStrike=r2.strike;}
  });

  // ── PCR ────────────────────────────────────────────────────────
  const pcrOI  = totalCEOI>0  ? +(totalPEOI/totalCEOI).toFixed(2)  : 0;
  const pcrVol = totalCEVol>0 ? +(totalPEVol/totalCEVol).toFixed(2) : 0;

  // ── IV SKEW ────────────────────────────────────────────────────
  const atmRow = rows.find(r=>r.strike===atmStrike)||rows[0];
  const otmCE  = rows.find(r=>r.strike===atmStrike+step*2);
  const otmPE  = rows.find(r=>r.strike===atmStrike-step*2);
  const ivSkew = otmPE&&otmCE ? +((otmPE.pe.iv-otmCE.ce.iv)).toFixed(2) : 0;
  const atmIV  = atmRow ? ((atmRow.ce.iv+atmRow.pe.iv)/2).toFixed(1) : '—';

  // ── SUPPORT / RESISTANCE ──────────────────────────────────────
  // Highest PE OI = support (put writers defend that level)
  // Highest CE OI = resistance (call writers cap that level)
  const sortedByPEOI = [...rows].filter(r=>r.pe.oi>0).sort((a,b)=>b.pe.oi-a.pe.oi);
  const sortedByCEOI = [...rows].filter(r=>r.ce.oi>0).sort((a,b)=>b.ce.oi-a.ce.oi);
  const support1    = sortedByPEOI[0]?.strike||0;
  const support2    = sortedByPEOI[1]?.strike||0;
  const resistance1 = sortedByCEOI[0]?.strike||0;
  const resistance2 = sortedByCEOI[1]?.strike||0;

  // ── FII vs RETAIL SENTIMENT ────────────────────────────────────
  // FII typically: large block OI additions at far strikes
  // Retail typically: near ATM, small lots
  // Proxy: large OI at strikes far from spot = institutional
  const farStrikes = rows.filter(r=>Math.abs(r.strike-spot)>step*5);
  const nearStrikes = rows.filter(r=>Math.abs(r.strike-spot)<=step*3);
  const fiiCEOI  = farStrikes.reduce((s,r)=>s+r.ce.oi,0);
  const fiiPEOI  = farStrikes.reduce((s,r)=>s+r.pe.oi,0);
  const retailCEOI = nearStrikes.reduce((s,r)=>s+r.ce.oi,0);
  const retailPEOI = nearStrikes.reduce((s,r)=>s+r.pe.oi,0);

  // FII: if more far PE OI = institutions buying puts = bearish hedge
  // FII: if more far CE OI = institutions buying calls = bullish
  const fiiBias = fiiPEOI>fiiCEOI*1.3?'BEARISH':fiiCEOI>fiiPEOI*1.3?'BULLISH':'NEUTRAL';
  // Retail: near-ATM OI bias
  const retailBias = retailPEOI>retailCEOI*1.2?'LONG PUT':retailCEOI>retailPEOI*1.2?'LONG CALL':'MIXED';

  // OI interpretation:
  // CE OI rising + price falling = CE writing (bearish momentum resistance)
  // PE OI rising + price rising = PE writing (bullish support)
  const ceOITrend = totalCEOIChg>0?'RISING':'FALLING';
  const peOITrend = totalPEOIChg>0?'RISING':'FALLING';

  // ── SIGNAL ENGINE ─────────────────────────────────────────────
  const signals = [];
  let bullScore=0, bearScore=0;

  // Signal 1: PCR
  if(pcrOI>1.3){bullScore+=20;signals.push({type:'BULL',src:'PCR',msg:`PCR ${pcrOI} > 1.3 — Put writers dominant, market likely supported`,score:20});}
  else if(pcrOI<0.8){bearScore+=20;signals.push({type:'BEAR',src:'PCR',msg:`PCR ${pcrOI} < 0.8 — Call writers dominant, market may face resistance`,score:20});}
  else signals.push({type:'NEUTRAL',src:'PCR',msg:`PCR ${pcrOI} neutral (0.8-1.3)`,score:0});

  // Signal 2: Max Pain
  const distFromMaxPain = spot - maxPainStrike;
  if(distFromMaxPain > step*2){bearScore+=15;signals.push({type:'BEAR',src:'MaxPain',msg:`Spot ${spot} far above max pain ${maxPainStrike}. Gravitates down toward max pain.`,score:15});}
  else if(distFromMaxPain < -step*2){bullScore+=15;signals.push({type:'BULL',src:'MaxPain',msg:`Spot ${spot} below max pain ${maxPainStrike}. Gravitates up toward max pain.`,score:15});}
  else signals.push({type:'NEUTRAL',src:'MaxPain',msg:`Spot near max pain ${maxPainStrike} — range-bound expected`,score:0});

  // Signal 3: IV Skew
  if(ivSkew>3){bearScore+=15;signals.push({type:'BEAR',src:'IVSkew',msg:`Put skew +${ivSkew}% — institutions paying premium for downside protection`,score:15});}
  else if(ivSkew<-3){bullScore+=15;signals.push({type:'BULL',src:'IVSkew',msg:`Call skew ${ivSkew}% — bullish sentiment, calls bid up`,score:15});}
  else signals.push({type:'NEUTRAL',src:'IVSkew',msg:`IV Skew ${ivSkew}% — balanced`,score:0});

  // Signal 4: Resistance level vs spot
  if(resistance1>0&&spot<resistance1){
    const distR=(resistance1-spot);
    if(distR<step){bearScore+=20;signals.push({type:'BEAR',src:'Resistance',msg:`Spot approaching max CE OI wall at ${resistance1} (${distR}pts away). Strong resistance.`,score:20});}
    else if(spot>resistance1){bullScore+=25;signals.push({type:'BULL',src:'Resistance',msg:`Spot BROKE ABOVE CE OI wall ${resistance1}. Bullish breakout!`,score:25});}
  }

  // Signal 5: Support level
  if(support1>0&&spot>support1){
    const distS=(spot-support1);
    if(distS<step){bullScore+=20;signals.push({type:'BULL',src:'Support',msg:`Spot near max PE OI support at ${support1} (${distS}pts). Strong support.`,score:20});}
    else if(spot<support1){bearScore+=25;signals.push({type:'BEAR',src:'Support',msg:`Spot BROKE BELOW PE OI support ${support1}. Bearish breakdown!`,score:25});}
  }

  // Signal 6: OI buildup
  if(ceOITrend==='RISING'&&peOITrend==='RISING'){
    if(totalCEOIChg>totalPEOIChg*1.5){bearScore+=10;signals.push({type:'BEAR',src:'OIBuild',msg:'CE OI rising faster — call writing dominating. Resistance building.',score:10});}
    else if(totalPEOIChg>totalCEOIChg*1.5){bullScore+=10;signals.push({type:'BULL',src:'OIBuild',msg:'PE OI rising faster — put writing dominating. Support building.',score:10});}
  }

  // Signal 7: FII bias
  if(fiiBias==='BULLISH'){bullScore+=20;signals.push({type:'BULL',src:'FII',msg:'FII positioning BULLISH — institutions loaded far-OTM calls',score:20});}
  else if(fiiBias==='BEARISH'){bearScore+=20;signals.push({type:'BEAR',src:'FII',msg:'FII positioning BEARISH — institutions buying protective puts',score:20});}

  // Signal 8: ATM IV level
  const atmIVNum=parseFloat(atmIV);
  if(atmIVNum>20){signals.push({type:'NEUTRAL',src:'ATM IV',msg:`High ATM IV ${atmIV}% — expensive options. Sellers have edge. Buyers need big moves.`,score:0});}
  else if(atmIVNum<14){bullScore+=5;signals.push({type:'BULL',src:'ATM IV',msg:`Low ATM IV ${atmIV}% — cheap options. Good time to BUY options.`,score:5});}

  // ── FINAL SIGNAL ──────────────────────────────────────────────
  const totalScore = bullScore+bearScore;
  const bullPct = totalScore>0?Math.round(bullScore/totalScore*100):50;
  const bearPct = totalScore>0?Math.round(bearScore/totalScore*100):50;
  let masterSignal, signalStrike, signalReason;

  if(bullScore>bearScore+15){
    masterSignal='BUY CALL';
    // Pick ATM or 1 strike OTM CE
    signalStrike=spot<resistance1?atmStrike:atmStrike+step;
    signalReason=`Bull score ${bullScore} vs Bear score ${bearScore}. ${signals.filter(s=>s.type==='BULL').map(s=>s.src).join(' + ')} aligned bullish.`;
  } else if(bearScore>bullScore+15){
    masterSignal='BUY PUT';
    signalStrike=spot>support1?atmStrike:atmStrike-step;
    signalReason=`Bear score ${bearScore} vs Bull score ${bullScore}. ${signals.filter(s=>s.type==='BEAR').map(s=>s.src).join(' + ')} aligned bearish.`;
  } else {
    masterSignal='WAIT / NEUTRAL';
    signalStrike=null;
    signalReason=`Mixed signals. Bull:${bullScore} Bear:${bearScore}. No clear edge. Wait for conviction.`;
  }

  return {
    spot, sym, expiry:nearExpiry, T:+(T*365).toFixed(1),
    atmStrike, atmIV, ivSkew,
    pcr:{oi:pcrOI,vol:pcrVol},
    maxPain:maxPainStrike,
    support:[support1,support2],
    resistance:[resistance1,resistance2],
    oi:{ceTotal:totalCEOI,peTotal:totalPEOI,ceChg:totalCEOIChg,peChg:totalPEOIChg},
    vol:{ceTotal:totalCEVol,peTotal:totalPEVol},
    fii:{bias:fiiBias,ceOI:fiiCEOI,peOI:fiiPEOI},
    retail:{bias:retailBias,ceOI:retailCEOI,peOI:retailPEOI},
    signals, bullScore, bearScore, bullPct, bearPct,
    masterSignal, signalStrike, signalReason,
    rows, lastUpdate:new Date(Date.now()+19800000).toISOString().slice(11,19)+' IST'
  };
}

// ── MAIN FETCH CYCLE ─────────────────────────────────────────────
async function refresh() {
  if(isFetching) return;
  isFetching=true; fetchError=null;
  try {
    const raw = await fetchChain(symbol);
    chainData = raw;
    analyzed  = analyzeChain(raw, symbol);
    fetchCount++;
    lastFetch = analyzed.lastUpdate;
    console.log(`[${lastFetch}] ${symbol} spot:${analyzed.spot} signal:${analyzed.masterSignal} bull:${analyzed.bullScore} bear:${analyzed.bearScore}`);
  } catch(e) {
    fetchError = e.message;
    console.log(`[WARN] Fetch failed: ${e.message} — using synthetic demo data`);
    // Generate realistic synthetic data for demo when market closed
    analyzed = generateSyntheticChain(symbol);
    lastFetch = new Date(Date.now()+19800000).toISOString().slice(11,19)+' IST (DEMO)';
  }
  isFetching=false;
}

// ── SYNTHETIC DEMO DATA ──────────────────────────────────────────
function generateSyntheticChain(sym) {
  const spot = sym==='NIFTY'?24350:sym==='BANKNIFTY'?52000:80000;
  const step = sym==='NIFTY'?50:100;
  const atm = Math.round(spot/step)*step;
  const T=3/365, r=0.065;
  const rows=[];
  const baseIV=0.15;
  let totalCEOI=0,totalPEOI=0,totalCEVol=0,totalPEVol=0;

  for(let i=-12;i<=12;i++){
    const K=atm+i*step;
    const skew=Math.abs(i)*0.003*(i<0?1.5:1);
    const ceIV=baseIV+(i>0?i*0.001:-i*0.001)+0.02;
    const peIV=baseIV+(-i>0?-i*0.001:i*0.001)+skew+0.025;
    const ceG=bs(spot,K,T,r,ceIV,true);
    const peG=bs(spot,K,T,r,peIV,false);
    const ceLTP=Math.max(0.5,+(ceG.price*(1+(Math.random()-0.5)*0.1)).toFixed(1));
    const peLTP=Math.max(0.5,+(peG.price*(1+(Math.random()-0.5)*0.1)).toFixed(1));
    // OI peaks at ATM and key strikes
    const oiBase=Math.round((1-Math.abs(i)/15)*5000000+Math.random()*500000);
    const ceOI=i>0?Math.round(oiBase*(1+i*0.1)):Math.round(oiBase*0.7);
    const peOI=i<0?Math.round(oiBase*(1+(-i)*0.1)):Math.round(oiBase*0.7);
    const ceVol=Math.round(ceOI*(0.1+Math.random()*0.1));
    const peVol=Math.round(peOI*(0.1+Math.random()*0.1));
    totalCEOI+=ceOI;totalPEOI+=peOI;totalCEVol+=ceVol;totalPEVol+=peVol;
    rows.push({
      strike:K,isATM:K===atm,moneyness:((spot-K)/spot*100).toFixed(2),
      ce:{ltp:ceLTP,oi:ceOI,oiChg:Math.round((Math.random()-0.4)*ceOI*0.1),vol:ceVol,
          iv:+(ceIV*100).toFixed(1),delta:+ceG.delta.toFixed(3),gamma:+ceG.gamma.toFixed(5),
          theta:+ceG.theta.toFixed(3),vega:+ceG.vega.toFixed(3),action:'—',bid:+(ceLTP*0.99).toFixed(1),ask:+(ceLTP*1.01).toFixed(1)},
      pe:{ltp:peLTP,oi:peOI,oiChg:Math.round((Math.random()-0.4)*peOI*0.1),vol:peVol,
          iv:+(peIV*100).toFixed(1),delta:+peG.delta.toFixed(3),gamma:+peG.gamma.toFixed(5),
          theta:+peG.theta.toFixed(3),vega:+peG.vega.toFixed(3),action:'—',bid:+(peLTP*0.99).toFixed(1),ask:+(peLTP*1.01).toFixed(1)},
    });
  }
  // Use same analysis engine on synthetic data
  const fakeRaw={records:{data:[],underlyingValue:spot}};
  // Build fake records
  rows.forEach(r=>{
    fakeRaw.records.data.push({expiryDate:'2026-04-24',strikePrice:r.strike,CE:{lastPrice:r.ce.ltp,openInterest:r.ce.oi,changeinOpenInterest:r.ce.oiChg,totalTradedVolume:r.ce.vol,impliedVolatility:r.ce.iv,bidprice:r.ce.bid,askPrice:r.ce.ask},PE:{lastPrice:r.pe.ltp,openInterest:r.pe.oi,changeinOpenInterest:r.pe.oiChg,totalTradedVolume:r.pe.vol,impliedVolatility:r.pe.iv,bidprice:r.pe.bid,askPrice:r.pe.ask}});
  });
  try{
    const res=analyzeChain(fakeRaw,sym);
    res.isDemoData=true;
    return res;
  }catch(e){
    return {spot,sym,isDemoData:true,rows,masterSignal:'DEMO MODE',bullScore:50,bearScore:50,bullPct:50,bearPct:50,signals:[],pcr:{oi:1.1,vol:1.0},maxPain:atm,support:[atm-step*3,atm-step*6],resistance:[atm+step*3,atm+step*6],oi:{ceTotal:totalCEOI,peTotal:totalPEOI,ceChg:0,peChg:0},vol:{ceTotal:totalCEVol,peTotal:totalPEVol},fii:{bias:'NEUTRAL',ceOI:0,peOI:0},retail:{bias:'MIXED',ceOI:0,peOI:0},atmIV:'15.0',ivSkew:2,atmStrike:atm,expiry:'2026-04-24',T:3,signalReason:'Demo mode',lastUpdate:lastFetch};
  }
}

// ── HTML DASHBOARD ───────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtNum(n){if(!n&&n!==0)return'—';if(n>=10000000)return(n/10000000).toFixed(2)+'Cr';if(n>=100000)return(n/100000).toFixed(2)+'L';if(n>=1000)return(n/1000).toFixed(1)+'K';return n.toLocaleString('en-IN');}

function buildHTML(sym) {
  const a = analyzed;
  if(!a) return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Option Chain</title><meta http-equiv="refresh" content="3"></head><body style="background:#020409;color:#dde8ff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;font-size:14px;flex-direction:column;gap:12px"><div style="font-size:24px">⏳</div><div>Fetching ${sym} option chain from NSE...</div><div style="color:#5a6f96;font-size:11px">First load may take 5-10 seconds</div></body></html>`;

  const sigColor = a.masterSignal.includes('CALL')?'#00ff88':a.masterSignal.includes('PUT')?'#ff3355':'#f4c430';
  const isDemoBar = a.isDemoData?`<div style="background:rgba(244,196,48,.1);border:1px solid rgba(244,196,48,.3);padding:6px 12px;font-family:monospace;font-size:9px;color:#f4c430;text-align:center">⚠️ DEMO MODE — NSE API unavailable (market closed or blocked). Showing synthetic data with real Greeks calculation.</div>`:'';

  // Master signal box
  const masterBox = `
  <div style="background:${sigColor}11;border:2px solid ${sigColor}44;border-radius:14px;padding:16px;margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:3px;color:${sigColor}">${esc(a.masterSignal)}</div>
        ${a.signalStrike?`<div style="font-family:monospace;font-size:10px;color:#dde8ff;margin-top:2px">Strike: <strong>${a.signalStrike}</strong> ${a.masterSignal.includes('CALL')?'CE':'PE'} · Expiry: ${esc(a.expiry)}</div>`:''}
      </div>
      <div style="text-align:right">
        <div style="display:flex;gap:8px;align-items:center">
          <div style="text-align:center"><div style="font-family:monospace;font-size:8px;color:#00ff88">BULL</div><div style="font-family:'Space Mono',monospace;font-size:16px;font-weight:700;color:#00ff88">${a.bullPct}%</div></div>
          <div style="font-family:monospace;font-size:14px;color:#5a6f96">vs</div>
          <div style="text-align:center"><div style="font-family:monospace;font-size:8px;color:#ff3355">BEAR</div><div style="font-family:'Space Mono',monospace;font-size:16px;font-weight:700;color:#ff3355">${a.bearPct}%</div></div>
        </div>
        <!-- Bull/Bear bar -->
        <div style="width:120px;height:6px;background:#ff3355;border-radius:3px;overflow:hidden;margin-top:4px">
          <div style="height:100%;width:${a.bullPct}%;background:#00ff88;border-radius:3px"></div>
        </div>
      </div>
    </div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.6">${esc(a.signalReason)}</div>
  </div>`;

  // Key levels
  const levelsBox = `
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px">
    ${[
      ['SPOT',a.spot.toLocaleString('en-IN'),'#dde8ff'],
      ['ATM STRIKE',a.atmStrike,'#00e5ff'],
      ['MAX PAIN',a.maxPain,'#ffe566'],
      ['RESISTANCE 1',a.resistance[0]||'—','#ff3355'],
      ['RESISTANCE 2',a.resistance[1]||'—','#ff8c00'],
      ['ATM IV',a.atmIV+'%',parseFloat(a.atmIV)>20?'#ff3355':parseFloat(a.atmIV)<14?'#00ff88':'#f4c430'],
      ['SUPPORT 1',a.support[0]||'—','#00ff88'],
      ['SUPPORT 2',a.support[1]||'—','#00ff88'],
      ['IV SKEW',a.ivSkew+'%',a.ivSkew>3?'#ff3355':a.ivSkew<-3?'#00ff88':'#f4c430'],
    ].map(([l,v,c])=>`<div style="background:#090b15;border:1px solid #162030;border-radius:8px;padding:8px"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:3px">${l}</div><div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
  </div>`;

  // PCR + OI Summary
  const pcrBox = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">PCR ANALYSIS</div>
      ${[['OI PCR',a.pcr.oi,a.pcr.oi>1.3?'🐂 BULLISH':a.pcr.oi<0.8?'🐻 BEARISH':'⚖️ NEUTRAL'],
         ['Volume PCR',a.pcr.vol,a.pcr.vol>1.3?'🐂 BULLISH':a.pcr.vol<0.8?'🐻 BEARISH':'⚖️ NEUTRAL']].map(([l,v,b])=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #0f1624">
          <span style="font-family:monospace;font-size:9px;color:#5a6f96">${l}</span>
          <div style="text-align:right"><span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${v>1.3?'#00ff88':v<0.8?'#ff3355':'#f4c430'}">${v}</span><span style="font-family:monospace;font-size:8px;color:#5a6f96;margin-left:5px">${b}</span></div>
        </div>`).join('')}
    </div>
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">OI SUMMARY</div>
      ${[['Total CE OI',fmtNum(a.oi.ceTotal),'#ff3355'],['Total PE OI',fmtNum(a.oi.peTotal),'#00ff88'],['CE OI Change',(a.oi.ceChg>0?'+':'')+fmtNum(a.oi.ceChg),a.oi.ceChg>0?'#ff3355':'#00ff88'],['PE OI Change',(a.oi.peChg>0?'+':'')+fmtNum(a.oi.peChg),a.oi.peChg>0?'#00ff88':'#ff3355']].map(([l,v,c])=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #0f1624">
          <span style="font-family:monospace;font-size:8px;color:#5a6f96">${l}</span>
          <span style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:${c}">${v}</span>
        </div>`).join('')}
    </div>
  </div>`;

  // FII vs Retail
  const sentBox = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
    <div style="background:#090b15;border:1px solid ${a.fii.bias==='BULLISH'?'rgba(0,255,136,.3)':a.fii.bias==='BEARISH'?'rgba(255,51,85,.3)':'#162030'};border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:4px">FII POSITIONING</div>
      <div style="font-family:monospace;font-size:14px;font-weight:700;color:${a.fii.bias==='BULLISH'?'#00ff88':a.fii.bias==='BEARISH'?'#ff3355':'#f4c430'}">${a.fii.bias==='BULLISH'?'🐂 LONG':'🐻 SHORT/HEDGE'} ${a.fii.bias}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:4px">Far-OTM CE: ${fmtNum(a.fii.ceOI)}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96">Far-OTM PE: ${fmtNum(a.fii.peOI)}</div>
    </div>
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:4px">RETAIL POSITIONING</div>
      <div style="font-family:monospace;font-size:12px;font-weight:700;color:#f4c430">${esc(a.retail.bias)}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:4px">Near CE OI: ${fmtNum(a.retail.ceOI)}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96">Near PE OI: ${fmtNum(a.retail.peOI)}</div>
    </div>
  </div>`;

  // Signals list
  const signalsList = `
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:12px">
    <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">SIGNAL BREAKDOWN</div>
    ${a.signals.map(s=>{
      const col=s.type==='BULL'?'#00ff88':s.type==='BEAR'?'#ff3355':'#f4c430';
      const ic=s.type==='BULL'?'▲':s.type==='BEAR'?'▼':'●';
      return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #0f1624">
        <div style="font-size:10px;color:${col};width:12px;flex-shrink:0;margin-top:1px">${ic}</div>
        <div style="flex:1"><div style="font-family:monospace;font-size:8px;color:${col};font-weight:700">${s.src} ${s.score>0?'+'+s.score:''}</div><div style="font-family:monospace;font-size:9px;color:#5a6f96;margin-top:1px">${esc(s.msg)}</div></div>
      </div>`;
    }).join('')}
  </div>`;

  // OI Bar chart (visual OI distribution)
  const maxOI = Math.max(...a.rows.map(r=>Math.max(r.ce.oi,r.pe.oi)), 1);
  const oiChart = `
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:12px;overflow-x:auto">
    <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">OI DISTRIBUTION CHART</div>
    <div style="min-width:320px">
      ${a.rows.slice().reverse().map(r=>{
        const ceW=Math.round(r.ce.oi/maxOI*100);
        const peW=Math.round(r.pe.oi/maxOI*100);
        const isATM=r.isATM;
        const isS=r.strike===a.support[0];
        const isR=r.strike===a.resistance[0];
        const isMP=r.strike===a.maxPain;
        const label=isATM?'ATM':isS?'SUP':isR?'RES':isMP?'MP':'';
        const labelColor=isATM?'#00e5ff':isS?'#00ff88':isR?'#ff3355':'#ffe566';
        return `<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;height:14px">
          <div style="width:52px;text-align:right;font-family:monospace;font-size:7px;color:${isATM?'#00e5ff':'#5a6f96'};flex-shrink:0">${r.strike}</div>
          ${label?`<div style="width:22px;font-family:monospace;font-size:7px;color:${labelColor};text-align:center;flex-shrink:0">${label}</div>`:'<div style="width:22px;flex-shrink:0"></div>'}
          <div style="flex:1;display:flex;height:10px;gap:1px">
            <!-- PE bar (left aligned, green) -->
            <div style="flex:1;display:flex;justify-content:flex-end">
              <div style="height:100%;width:${peW}%;background:rgba(0,255,136,${isS?0.8:0.35});border-radius:2px 0 0 2px;min-width:${r.pe.oi>0?1:0}px"></div>
            </div>
            <div style="width:1px;background:#162030;flex-shrink:0"></div>
            <!-- CE bar (right aligned, red) -->
            <div style="flex:1">
              <div style="height:100%;width:${ceW}%;background:rgba(255,51,85,${isR?0.8:0.35});border-radius:0 2px 2px 0;min-width:${r.ce.oi>0?1:0}px"></div>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div style="display:flex;justify-content:center;gap:16px;margin-top:6px">
        <span style="font-family:monospace;font-size:8px;color:#00ff88">█ PE OI</span>
        <span style="font-family:monospace;font-size:8px;color:#ff3355">█ CE OI</span>
      </div>
    </div>
  </div>`;

  // Option Chain Table
  const tableRows = a.rows.map(r=>{
    const isATM=r.isATM;
    const bg=isATM?'background:#0a1628;':'';
    const ceOICol=r.ce.oiChg>0?'#ff3355':r.ce.oiChg<0?'#00ff88':'#5a6f96';
    const peOICol=r.pe.oiChg>0?'#00ff88':r.pe.oiChg<0?'#ff3355':'#5a6f96';
    const isSupport=r.strike===a.support[0];
    const isResist=r.strike===a.resistance[0];
    const isMP=r.strike===a.maxPain;
    const strikeBg=isATM?'#00e5ff':isSupport?'#00ff88':isResist?'#ff3355':isMP?'#ffe566':'#5a6f96';
    return `<tr style="${bg}">
      <!-- CE side -->
      <td style="text-align:right;padding:4px 6px;font-family:monospace;font-size:9px;color:#ff8c00">${r.ce.iv}</td>
      <td style="text-align:right;padding:4px 4px;font-family:monospace;font-size:9px;color:#5a6f96">${r.ce.delta}</td>
      <td style="text-align:right;padding:4px 4px;font-family:monospace;font-size:8px;color:#253348">${r.ce.theta}</td>
      <td style="text-align:right;padding:4px 6px;font-family:'Space Mono',monospace;font-size:9px;color:${ceOICol}">${fmtNum(r.ce.oi)}</td>
      <td style="text-align:right;padding:4px 4px;font-family:monospace;font-size:9px;color:${ceOICol}">${r.ce.oiChg>0?'+':''+(r.ce.oiChg!==0?r.ce.oiChg.toLocaleString('en-IN'):'—')}</td>
      <td style="text-align:right;padding:4px 6px;font-family:'Space Mono',monospace;font-size:9px;color:#dde8ff;font-weight:${isATM?700:400}">${r.ce.ltp}</td>
      <!-- STRIKE -->
      <td style="text-align:center;padding:4px 6px;font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:${strikeBg};background:rgba(255,255,255,.03)">${r.strike}${isATM?' ★':isSupport?' S':isResist?' R':isMP?' MP':''}</td>
      <!-- PE side -->
      <td style="text-align:left;padding:4px 6px;font-family:'Space Mono',monospace;font-size:9px;color:#dde8ff;font-weight:${isATM?700:400}">${r.pe.ltp}</td>
      <td style="text-align:left;padding:4px 4px;font-family:monospace;font-size:9px;color:${peOICol}">${r.pe.oiChg>0?'+':''+(r.pe.oiChg!==0?r.pe.oiChg.toLocaleString('en-IN'):'—')}</td>
      <td style="text-align:left;padding:4px 6px;font-family:'Space Mono',monospace;font-size:9px;color:${peOICol}">${fmtNum(r.pe.oi)}</td>
      <td style="text-align:left;padding:4px 4px;font-family:monospace;font-size:8px;color:#253348">${r.pe.theta}</td>
      <td style="text-align:left;padding:4px 4px;font-family:monospace;font-size:9px;color:#5a6f96">${r.pe.delta}</td>
      <td style="text-align:left;padding:4px 6px;font-family:monospace;font-size:9px;color:#ff8c00">${r.pe.iv}</td>
    </tr>`;
  }).join('');

  const symOptions = ['NIFTY','BANKNIFTY','FINNIFTY'].map(s=>`<a href="/set?sym=${s}" style="padding:5px 12px;border-radius:7px;border:1px solid ${sym===s?'rgba(0,229,255,.5)':'#253348'};background:${sym===s?'rgba(0,229,255,.12)':'transparent'};color:${sym===s?'#00e5ff':'#5a6f96'};font-family:monospace;font-size:9px;font-weight:700;text-decoration:none">${s}</a>`).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${sym} Option Chain — GOD LEVEL</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}
table{width:100%;border-collapse:collapse}
tr:hover{background:rgba(255,255,255,.02)}
td{border-bottom:1px solid #0a0f1a}
.tabs{display:flex;overflow-x:auto;background:#06080e;border-bottom:1px solid #0f1624}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:10px 14px;font-family:monospace;font-size:10px;font-weight:700;color:#253348;white-space:nowrap;text-decoration:none;border-bottom:3px solid transparent}
.pg{display:none;padding:11px}.pg.act{display:block}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.ld{width:5px;height:5px;border-radius:50%;background:#00ff88;box-shadow:0 0 6px #00ff88;animation:bl 1.5s infinite;display:inline-block;vertical-align:middle}
@keyframes pu{0%{transform:scale(1)}50%{transform:scale(1.05)}100%{transform:scale(1)}}
.pulse{animation:pu 2s infinite}
</style>
</head><body>

<!-- TOPBAR -->
<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:8px 12px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-family:'Bebas Neue',cursive;font-size:16px;letter-spacing:3px;background:linear-gradient(90deg,#ffd700,#00ff88);-webkit-background-clip:text;-webkit-text-fill-color:transparent">OPTION CHAIN</span>
      <span style="font-family:monospace;font-size:8px;padding:2px 8px;border-radius:5px;border:1px solid ${sigColor}44;background:${sigColor}11;color:${sigColor};font-weight:700" class="${a.masterSignal!=='WAIT / NEUTRAL'?'pulse':''}">${esc(a.masterSignal)}</span>
      ${a.isDemoData?'<span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:4px;border:1px solid rgba(244,196,48,.3);color:#f4c430">DEMO</span>':''}
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="ld"></span>
      <span style="font-family:monospace;font-size:8px;color:#5a6f96">${esc(a.lastUpdate||lastFetch)}</span>
      <a href="/refresh" style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);color:#00e5ff;font-family:monospace;font-size:8px;padding:4px 10px;border-radius:5px;text-decoration:none">↻</a>
    </div>
  </div>
  <!-- Index selector -->
  <div style="display:flex;gap:5px;align-items:center">
    ${symOptions}
    <div style="margin-left:8px;font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:#dde8ff">${a.spot.toLocaleString('en-IN')}</div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96">DTE: ${a.T}d · Expiry: ${esc(a.expiry)}</div>
  </div>
</div>

${isDemoBar}

<!-- TABS -->
<div class="tabs">
  <a href="/?tab=signal" class="tab" style="color:${(new URLSearchParams('?tab=signal')).get('tab')?'#ffe566':'#253348'}">⚡ Signal</a>
  <a href="/?tab=chain" class="tab">📊 Chain</a>
  <a href="/?tab=oi" class="tab">📈 OI Chart</a>
  <a href="/?tab=greek" class="tab">🔬 Greeks</a>
  <a href="/?tab=sentiment" class="tab">🐂 Sentiment</a>
</div>

<!-- We always show all sections stacked for mobile simplicity -->
<div style="padding:11px">

${masterBox}
${levelsBox}
${pcrBox}
${sentBox}
${signalsList}
${oiChart}

<!-- CHAIN TABLE -->
<div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:12px;overflow-x:auto">
  <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">OPTION CHAIN TABLE — ${sym} · ${esc(a.expiry)} · ★=ATM S=Support R=Resistance MP=MaxPain</div>
  <div style="min-width:640px">
  <table>
    <thead>
      <tr style="background:#0f1624">
        <th colspan="5" style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#ff3355;letter-spacing:2px;border-bottom:1px solid #162030">◄ CALLS</th>
        <th style="padding:5px;font-family:monospace;font-size:8px;color:#ff3355">LTP</th>
        <th style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#5a6f96">STRIKE</th>
        <th style="padding:5px;font-family:monospace;font-size:8px;color:#00ff88">LTP</th>
        <th colspan="5" style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#00ff88;letter-spacing:2px;border-bottom:1px solid #162030">PUTS ►</th>
      </tr>
      <tr style="background:#06080e">
        <td style="text-align:right;padding:3px 6px;font-family:monospace;font-size:7px;color:#ff8c00">IV%</td>
        <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:7px;color:#5a6f96">Δ</td>
        <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:7px;color:#253348">Θ</td>
        <td style="text-align:right;padding:3px 6px;font-family:monospace;font-size:7px;color:#ff3355">OI</td>
        <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:7px;color:#ff3355">OI Chg</td>
        <td style="text-align:right;padding:3px 6px;font-family:monospace;font-size:7px;color:#dde8ff">LTP</td>
        <td style="text-align:center;padding:3px 6px;font-family:monospace;font-size:7px;color:#5a6f96">STRIKE</td>
        <td style="text-align:left;padding:3px 6px;font-family:monospace;font-size:7px;color:#dde8ff">LTP</td>
        <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:7px;color:#00ff88">OI Chg</td>
        <td style="text-align:left;padding:3px 6px;font-family:monospace;font-size:7px;color:#00ff88">OI</td>
        <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:7px;color:#253348">Θ</td>
        <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:7px;color:#5a6f96">Δ</td>
        <td style="text-align:left;padding:3px 6px;font-family:monospace;font-size:7px;color:#ff8c00">IV%</td>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</div>

<!-- GREEKS SUMMARY -->
<div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:12px">
  <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">GREEKS GUIDE</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
    ${[
      ['Δ Delta','Option price change per ₹1 index move. ATM ≈ 0.5. CE positive, PE negative.','#5a6f96'],
      ['Γ Gamma','Rate of delta change. High near ATM on expiry = dangerous.','#bb66ff'],
      ['Θ Theta','Daily time decay. Negative for buyers. Accelerates near expiry.','#ff8c00'],
      ['V Vega','Price change per 1% IV change. High when IV is low = good to buy.','#00e5ff'],
    ].map(([n,d,c])=>`<div style="padding:7px;background:#020409;border-radius:6px;border:1px solid #0f1624"><div style="font-family:monospace;font-size:9px;font-weight:700;color:${c};margin-bottom:2px">${n}</div><div style="font-family:monospace;font-size:8px;color:#5a6f96;line-height:1.5">${d}</div></div>`).join('')}
  </div>
</div>

<div style="text-align:center;font-family:monospace;font-size:8px;color:#253348;padding:8px">
  Data: NSE India · Refreshes every 60s · Greeks: Black-Scholes computed · Fetch #${fetchCount}<br>
  ⚠️ For educational purposes only. Not financial advice.
</div>

</div>

<script>
// Auto-refresh every 60s during market hours
const ist=new Date(Date.now()+19800000);
const t=ist.getUTCHours()*60+ist.getUTCMinutes();
const mktOpen=ist.getUTCDay()>=1&&ist.getUTCDay()<=5&&t>=555&&t<=930;
if(mktOpen){
  setTimeout(()=>window.location.reload(),60000);
  document.title='[LIVE] ${sym} Option Chain';
} else {
  setTimeout(()=>window.location.reload(),120000);
}
// Highlight active tab
const tab=new URLSearchParams(window.location.search).get('tab')||'signal';
document.querySelectorAll('.tab').forEach(t=>{
  if(t.href.includes('tab='+tab)){t.style.color='#ffe566';t.style.borderBottom='3px solid #ffe566';}
});
</script>
</body></html>`;
}

// ── HTTP SERVER ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  
  if(url.pathname==='/health'){
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end(`OK symbol=${symbol} fetches=${fetchCount} error=${fetchError||'none'} last=${lastFetch}`);
    return;
  }

  if(url.pathname==='/set'){
    const s=url.searchParams.get('sym');
    if(['NIFTY','BANKNIFTY','FINNIFTY'].includes(s)){
      symbol=s; chainData=null; analyzed=null;
      await refresh();
    }
    res.writeHead(302,{'Location':'/'}); res.end(); return;
  }

  if(url.pathname==='/refresh'){
    await refresh();
    res.writeHead(302,{'Location':'/'}); res.end(); return;
  }

  // Main page
  if(!analyzed) await refresh();
  try {
    const html = buildHTML(symbol);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
    res.end(html);
  } catch(e) {
    console.error('Build error:',e.message);
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('Option Chain Analyzer starting... refresh in 5s\n'+e.message);
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('═══════════════════════════════════════════════════');
  console.log(' NIFTY OPTION CHAIN ANALYZER — GOD LEVEL PRO');
  console.log('═══════════════════════════════════════════════════');
  console.log(' Port:', PORT);
  console.log(' Data: NSE India free API (no login needed)');
  console.log(' Features: Greeks · OI · PCR · Max Pain · IV Skew');
  console.log('           FII/Retail Sentiment · Signal Engine');
  console.log(' BUILD: npm install | START: node server.js');
  console.log('═══════════════════════════════════════════════════');
  refresh();
  // Auto-refresh every 60 seconds
  setInterval(refresh, 60000);
});
server.on('error',e=>{console.error('FATAL:',e.message);process.exit(1);});
