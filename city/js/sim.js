'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Σ-9 · REMOTE SURVEY INSTRUMENT — relevé du territoire non-incorporé
   A settlement incorporates itself out of a drifting pressure field,
   fails in self-organized cascades, and is colonized by flora in the
   interval. Weather scours it. The cursor is a thermal anomaly.
   Rendered as an expedition plate: flat color, ink line, paper grain.
   ═══════════════════════════════════════════════════════════════════ */

const RW=768, RH=480;                  // internal plate (px)
const GW=124, GD=46, CW=6, RS=6;       // grid: columns, depth rows, cell px
const CX=12,  CY=104;                  // city origin on plate
const NC=GW*GD, TAU=Math.PI*2;
const TPS=30, SOL=180*TPS, MAXH=80;
const HUD_Y=404;
const VH=HUD_Y;   // visible plate height — the old HUD strip below is cropped off

let SEED=(Math.random()*1e9)|0;

/* ── state fields ── */
const HT=new Float32Array(NC),  SS=new Float32Array(NC),  SB=new Float32Array(NC),
      RES=new Float32Array(NC), ZO=new Float32Array(NC),  HE=new Float32Array(NC),
      HE2=new Float32Array(NC), AX=new Float32Array(NC),  BO=new Float32Array(NC),
      RV=new Float32Array(NC);
const STA=new Uint8Array(NC), SY=new Uint8Array(NC);
const sE=0,sB=1,sF=2,sU=3,sG=4,sV=5;   // void · structure · failing · ruin · vitric · flora

/* ── utils ── */
const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,k)=>a+(b-a)*k;
const sstep=(a,b,x)=>{const k=clamp((x-a)/(b-a),0,1);return k*k*(3-2*k)};
const mix=(c,d,k)=>[lerp(c[0],d[0],k),lerp(c[1],d[1],k),lerp(c[2],d[2],k)];
const css=c=>`rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
const rgba=(c,a)=>`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;

function hsh(x,y){let n=(x|0)*374761393+(y|0)*668265263+SEED;
  n=Math.imul(n^n>>>13,1274126177); n^=n>>>16; return (n>>>0)/4294967296}
function vno(x,y){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,
  u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
  return hsh(ix,iy)*(1-u)*(1-v)+hsh(ix+1,iy)*u*(1-v)+hsh(ix,iy+1)*(1-u)*v+hsh(ix+1,iy+1)*u*v}
function fbm(x,y){return .54*vno(x,y)+.30*vno(x*2.13+7.7,y*2.13+3.1)+.16*vno(x*4.4+13.2,y*4.4+9.8)}

/* ── moebius palette: flat colors, warm ink ── */
const INK=[58,44,48];
const FAC=[[198,103,62],[211,140,123],[ 96,182,170],[209,168, 92]];  // terracotta · rose · turquoise · ochre
const NIGHT_BODY=[46,43,86];
const CREAM=[246,238,218], WINDOW_N=[255,236,178];
const GLASS_C=[182,229,224], RUIN_C=[150,84,52], EMBER=[226,92,42], ICEC=[168,205,228];
const FLORA_B=[138,186,96], FLORA_D=[96,132,72], FLOWER=[230,102,80];

/* ── world time & mood ── */
let t=0, paused=false, hud=false, lensOn=true, introDone=false, introFadeAt=-1;
let day=0, night=1, skyZen=[0,0,0], skyHor=[0,0,0], fogHor=[0,0,0], sunC=[226,90,60];

/* ── telemetry ── */
let massNow=0, bCount=0, vCount=0, chi=0, heatBar=0, bFrac=0;
const massHist=new Float32Array(96); let massPtr=0;
const evMags=[]; const logs=[];
function log(s){logs.push({s,t});if(logs.length>30)logs.shift()}
const SEC_L="ABCDEFGHKLMN";
const secOf=i=>SEC_L[Math.floor((i%GW)/GW*10)]+"-"+(1+Math.floor((i/GW|0)/GD*6));

let evOpen=false, evSum=0, evLastFire=-999, evSec="";
let shake=0, vitLogT=-999;

/* ── particles ── */
const debris=[], fliers=[], rings=[], wxP=[];

/* ── scheduled phenomena ── */
let nextEvT=20*TPS+((Math.random()*55*TPS)|0);
let sweepX=-999, auroraT=0;
const wx={type:0,x:0,vx:0,w:0};        // 0 none · 1 scour front · 2 rain cell
let nextWxT=(55+Math.random()*70)*TPS|0;

/* ── glyph strip ── */
const GLY=new Uint8Array(10*35), glyFlash=new Float32Array(10);
for(let i=0;i<GLY.length;i++)GLY[i]=Math.random()<.42?1:0;
function flash(g){glyFlash[g]=1}

/* ═══ genesis ═══ */
let wall=[], stipple=[], clouds=[];
function reseed(first){
  SEED=(Math.random()*1e9)|0;
  HT.fill(0);SS.fill(0);SB.fill(0);ZO.fill(0);HE.fill(0);HE2.fill(0);
  AX.fill(0);BO.fill(0);RV.fill(0);STA.fill(sE);SY.fill(0);
  for(let i=0;i<NC;i++){
    const x=i%GW,y=i/GW|0;
    ZO[i]=fbm(x*.045,y*.062);
    RES[i]=Math.max(0,fbm(x*.09+40,y*.11+17)-.42)*1.3;
  }
  let best=[];
  for(let k=0;k<400;k++){const i=(Math.random()*NC)|0;best.push([ZO[i],i])}
  best.sort((a,b)=>b[0]-a[0]);
  for(let k=0;k<7;k++)nucleate(best[k*9][1],5);
  /* horizon mesas */
  wall=[];let mx=-10;
  while(mx<RW+10){const w=26+Math.random()*70,h=7+Math.random()*24;
    wall.push({x:mx,w,h,a:Math.random()<.2});mx+=w+8+Math.random()*30}
  /* desert stipple */
  stipple=[];
  for(let k=0;k<520;k++){const gx=(Math.random()*GW)|0,gy=(Math.random()*GD)|0;
    stipple.push([gx,gy,Math.random()])}
  if(!clouds.length)for(let k=0;k<4;k++)
    clouds.push({x:Math.random()*RW,y:18+Math.random()*52,w:70+Math.random()*120,s:.04+Math.random()*.1});
  if(!first){t=0;introDone=true;log("SITE ROTATION · COORDONNÉES RETENUES");flash(9)}
}
function nucleate(i,h0){
  STA[i]=sB; HT[i]=h0||.6; SS[i]=0; BO[i]=t;
  SB[i]=14+11*Math.random();
  const z=ZO[i], jit=vno((i%GW)*.3+9,(i/GW|0)*.3+4)-.5;
  const sty=clamp(Math.floor(clamp(z*1.25-.13+jit*.35,0,.999)*4),0,3);
  SY[i]=sty|(Math.random()<.5?4:0)|(((Math.random()*4)|0)<<3);   // bits3-4: slab·spire·dome·terrace
}

/* ═══ simulation (30 ticks/s) ═══ */
function step(){
  t++;
  /* slow layer: the zoning field drifts — districts migrate over minutes */
  {const ph=t*6e-4;
   for(let y=t%8;y<GD;y+=8)for(let x=0;x<GW;x++)
     ZO[y*GW+x]=fbm(x*.045+ph,y*.062-ph*.7);}

  /* thermal field */
  if(P.act&&!paused){
    const amp=P.cold?-.5:.42, cgx=P.gx|0, cgy=P.gy|0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const x=cgx+dx,y=cgy+dy;
      if(x<0||x>=GW||y<0||y>=GD)continue;
      const g=Math.exp(-(dx*dx+dy*dy)*.35);
      HE[y*GW+x]=clamp(HE[y*GW+x]+amp*g,-1.3,1.6);
    }
  }
  for(let y=0;y<GD;y++)for(let x=0;x<GW;x++){
    const i=y*GW+x,
      l=x>0?HE[i-1]:HE[i], r=x<GW-1?HE[i+1]:HE[i],
      u=y>0?HE[i-GW]:HE[i], d=y<GD-1?HE[i+GW]:HE[i];
    HE2[i]=(HE[i]*.62+(l+r+u+d)*.095)*.955;
  }
  HE.set(HE2);

  /* weather front */
  if(wx.type===0&&t>=nextWxT)startWx();
  let wxL=-1e9,wxR=-1e9;
  if(wx.type){
    wx.x+=wx.vx;
    wxL=wx.x-wx.w/2;wxR=wx.x+wx.w/2;
    if((wx.vx>0&&wxL>RW+20)||(wx.vx<0&&wxR<-20)){wx.type=0;nextWxT=t+((90+Math.random()*150)*TPS|0)}
    else{
      for(let k=0;k<500;k++){
        const i=(Math.random()*NC)|0, px=CX+(i%GW)*CW;
        if(px<wxL||px>wxR)continue;
        const st=STA[i];
        if(wx.type===1){                              // scour: erode, stress, strip flora
          if(st===sB){SS[i]+=.004;HT[i]=Math.max(2,HT[i]-.03)}
          else if(st===sV){HT[i]-=.35;if(HT[i]<1){STA[i]=sE;RES[i]=Math.min(1.5,RES[i]+.05)}}
        }else{                                        // rain: enrich, bloom
          RES[i]=Math.min(1.5,RES[i]+.005);
          if(st===sV)HT[i]+=.05;
          else if((st===sE||st===sU)&&RES[i]>.2&&Math.random()<.012){STA[i]=sV;HT[i]=.5;AX[i]=(2+Math.random()*4)*TPS}
        }
      }
      if(wxP.length<420)for(let k=0;k<(wx.type===1?22:16);k++)spawnWxP(wxL,wxR);
    }
  }

  /* cells */
  let mass=0,cnt=0,vcnt=0,ssum=0,scnt=0;
  const crowd=Math.max(0,1-bFrac*2.4), dayG=.7+.3*day;
  for(let i=0;i<NC;i++){
    const st=STA[i], heat=HE[i];
    if(st===sE){
      RES[i]*=.99985;
      const z=ZO[i];
      if(z>.52){
        const x=i%GW,y=i/GW|0;
        const nb=(x>0&&STA[i-1]===sB)||(x<GW-1&&STA[i+1]===sB)||
                 (y>0&&STA[i-GW]===sB)||(y<GD-1&&STA[i+GW]===sB);
        let p=3e-5+(nb?9e-4*crowd:0)+RES[i]*4e-4;
        p*=(heat>0?1+heat*1.2:Math.max(.15,1+heat))*(.45+.55*day)*(1+mic.treb*1.2);
        if(Math.random()<p)nucleate(i);
      }
      else if(RES[i]>.3&&Math.random()<2.2e-5*(.3+.7*day)){
        STA[i]=sV;HT[i]=.5;AX[i]=(4+Math.random()*5)*TPS;   // margins green over
      }
    }
    else if(st===sB){
      const z=ZO[i], zs=sstep(.45,.85,z);
      const tgt=clamp(MAXH*(.10+.90*zs)*(.75+.45*Math.min(1,RES[i]))*(1+mic.bass*.3),5,MAXH);
      const gf=heat>=0?1+heat*1.05:Math.max(.06,1+heat*.8);
      const rv=.05+.045*((Math.imul(i,2654435761)>>>13&255)/255);
      if(HT[i]<tgt)HT[i]+=rv*gf*dayG;
      else if(HT[i]>tgt+12)SS[i]+=.004;
      const x=i%GW,y=i/GW|0;
      let mh=0;
      if(x>0&&HT[i-1]>mh)mh=HT[i-1]; if(x<GW-1&&HT[i+1]>mh)mh=HT[i+1];
      if(y>0&&HT[i-GW]>mh)mh=HT[i-GW]; if(y<GD-1&&HT[i+GW]>mh)mh=HT[i+GW];
      const exp=HT[i]-(mh*.8+18);
      if(exp>0)SS[i]+=exp*.0016;
      SS[i]+=.0016+Math.max(0,heat)*.045;
      if(heat<0)SS[i]=Math.max(0,SS[i]+heat*.06);
      SS[i]*=.9993;
      const age=t-BO[i];
      const eff=SB[i]*(age<500?1.25:1)*(1-Math.min(.62,age/((90+(i&7)*8)*TPS)*.62));
      if(heat>1.02&&Math.random()<.07){
        STA[i]=sG; sfx.ping();
        if(t-vitLogT>2*TPS){log("VITRIFICATION · SEC "+secOf(i));vitLogT=t;flash(2)}
      }
      else if(SS[i]>eff){STA[i]=sF;AX[i]=2+(Math.random()*4|0)}
      mass+=HT[i];cnt++;ssum+=SS[i]/eff;scnt++;
    }
    else if(st===sF){
      if(AX[i]>0){AX[i]--;if(AX[i]<=0){fire(i);AX[i]=-1}}
      else{
        HT[i]=HT[i]*.86-1;
        if(debris.length<700&&Math.random()<.85)spawnDebris(i,SY[i]&3);
        if(HT[i]<=1){
          RES[i]=Math.min(1.5,RES[i]+.06+BO[i]*.005);
          STA[i]=sU;AX[i]=(6+10*Math.random())*TPS;HT[i]=.8+Math.random();SS[i]=0;
        }
      }
      mass+=Math.max(0,HT[i]);
    }
    else if(st===sU){
      AX[i]--;RES[i]*=.99996;
      if(AX[i]<=0){
        /* succession: the garden moves into rich ruins */
        if(RES[i]>.26&&Math.random()<.3){STA[i]=sV;HT[i]=.5;AX[i]=(4+Math.random()*5)*TPS}
        else{STA[i]=sE;HT[i]=0}
      }
    }
    else if(st===sG){SS[i]*=.97;mass+=HT[i]}
    else if(st===sV){
      /* flora: colonizes ruins and rich ground, withers when it spends the soil */
      const vt=6+RES[i]*13;
      if(HT[i]<vt)HT[i]+=.022*(.25+.75*day);
      RES[i]-=.00012;
      if(heat>.55){HT[i]-=heat*.5;
        if(HT[i]<1){STA[i]=sE;RES[i]=Math.min(1.5,RES[i]+.08);
          if(debris.length<700)spawnDebris(i,-2)}}
      else{
        AX[i]--;
        if(AX[i]<=0){
          AX[i]=(6+Math.random()*8)*TPS;
          const x=i%GW,y=i/GW|0,dir=(Math.random()*4)|0,
            j=dir===0?(x>0?i-1:-1):dir===1?(x<GW-1?i+1:-1):dir===2?(y>0?i-GW:-1):(y<GD-1?i+GW:-1);
          if(j>=0&&(STA[j]===sU||(STA[j]===sE&&RES[j]>.18))){
            let shade=false;                       // tall structures shade out colonists
            const jx=j%GW,jy=j/GW|0;
            if(jx>0&&STA[j-1]===sB&&HT[j-1]>30)shade=true;
            if(jx<GW-1&&STA[j+1]===sB&&HT[j+1]>30)shade=true;
            if(jy>0&&STA[j-GW]===sB&&HT[j-GW]>30)shade=true;
            if(jy<GD-1&&STA[j+GW]===sB&&HT[j+GW]>30)shade=true;
            if(!shade){STA[j]=sV;HT[j]=.5;AX[j]=(2+Math.random()*4)*TPS;
              if(Math.random()<.02)flash(1)}
          }
        }
        if(RES[i]<.04){HT[i]-=.05;if(HT[i]<1){STA[i]=sE;HT[i]=0}}
      }
      vcnt++;
    }
    RV[i]*=.985;
  }
  massNow=mass;bCount=cnt;vCount=vcnt;bFrac=cnt/NC;
  chi=scnt?ssum/scnt:0;
  if(t%20===0){massHist[massPtr]=mass;massPtr=(massPtr+1)%96}
  {let h=0;for(let k=0;k<NC;k+=37)h+=Math.abs(HE[k]);heatBar=h/(NC/37)}

  /* avalanche window */
  if(evOpen&&t-evLastFire>24){
    evOpen=false;
    if(evSum>34){
      const mu=Math.log2(1+evSum)/2;
      log("SUBSIDENCE · SEC "+evSec+" · μ"+mu.toFixed(1));
      evMags.push(mu);if(evMags.length>56)evMags.shift();
      flash(0); if(evSum>300)sfx.boom(evSum);
    }
    evSum=0;
  }
  shake*=.86;

  /* carriers */
  if(fliers.length<12&&Math.random()<.018+.02*night){
    const dir=Math.random()<.5?1:-1;
    fliers.push({x:dir>0?-6:RW+6,y:24+Math.random()*120,vx:dir*(.7+Math.random()),
      ph:Math.random()*99,big:Math.random()<.3});
  }
  for(let k=fliers.length-1;k>=0;k--){const f=fliers[k];f.x+=f.vx;
    if(f.x<-12||f.x>RW+12)fliers.splice(k,1)}
  for(let k=debris.length-1;k>=0;k--){const d=debris[k];
    d.x+=d.vx;d.y+=d.vy;d.vy+=.13;d.life--;
    if(d.y>d.gy){d.y=d.gy;d.vy=0;d.vx*=.4;d.life-=3}
    if(d.life<=0)debris.splice(k,1)}
  for(let k=rings.length-1;k>=0;k--){const r=rings[k];r.r+=2;
    if(r.r>r.max)rings.splice(k,1)}
  for(let k=wxP.length-1;k>=0;k--){const p=wxP[k];
    p.x+=p.vx;p.y+=p.vy;p.life--;
    if(p.life<=0||p.y>HUD_Y-8)wxP.splice(k,1)}

  /* rare phenomena */
  if(t>=nextEvT){scheduleEvent();nextEvT=t+((45+Math.random()*65)*TPS|0)}
  if(sweepX>-999){sweepX+=3.5;
    if(sweepX<RW+24)markReveal();else sweepX=-999}
  if(auroraT>0){auroraT--;
    if(auroraT===(6*TPS|0))mutateBand()}

  /* acoustic transients: a sharp sound is a distant quake */
  if(mic.on&&mic.onset&&t-mic.lastQ>3*TPS){
    mic.lastQ=t;mic.onset=false;
    const ci=(Math.random()*NC)|0;
    pulseAt(ci%GW,ci/GW|0,11,9);
    log("ACOUSTIC TRANSIENT · SEC "+secOf(ci)+" · ORIGINE EXTERNE");flash(3);
  }
}

function fire(i){
  const h=HT[i], x=i%GW;
  BO[i]=h;                                   // repurposed: rubble yield
  if(!evOpen){evOpen=true;evSec=secOf(i)}
  evSum+=h;evLastFire=t;
  shake=Math.min(3,shake+h*.02);
  sfx.crumble(h);
  const push=(j,w)=>{
    if(j<0||j>=NC)return;
    const s=STA[j], imp=w*h*(.75+.5*Math.random());
    if(s===sB)SS[j]+=imp*.05;
    else if(s===sG&&imp>13)shatter(j);
    else if(s===sV&&imp>9){STA[j]=sE;HT[j]=0;RES[j]=Math.min(1.5,RES[j]+.06)}
  };
  if(x>0)push(i-1,1);if(x<GW-1)push(i+1,1);
  push(i-GW,1);push(i+GW,1);
  if(x>0){push(i-GW-1,.45);push(i+GW-1,.45)}
  if(x<GW-1){push(i-GW+1,.45);push(i+GW+1,.45)}
}
function shatter(i){
  for(let k=0;k<8;k++)spawnDebris(i,-1);
  RES[i]=Math.min(1.5,RES[i]+.5);
  STA[i]=sU;AX[i]=(8+8*Math.random())*TPS;HT[i]=.6;SS[i]=0;
  sfx.shatter();
}
function spawnDebris(i,sty){
  const x=i%GW,y=i/GW|0,px=CX+x*CW+2.5,base=CY+y*RS+5;
  debris.push({x:px+(Math.random()-.5)*4,y:base-HT[i]*Math.random(),
    vx:(Math.random()-.5)*1.7,vy:-(.3+Math.random()*.9),gy:base,
    life:30+Math.random()*40|0,
    c:sty===-1?rgba(GLASS_C,.95):sty===-2?rgba(FLORA_D,.9):
      Math.random()<.4?rgba(INK,.8):rgba(mix(FAC[sty],CREAM,.2),.9)});
}
function spawnWxP(L,R){
  if(wx.type===1)wxP.push({x:L+Math.random()*(R-L),y:CY-30+Math.random()*(HUD_Y-CY),
    vx:wx.vx*9*(.6+Math.random()*.8),vy:(Math.random()-.4)*.6,life:8+Math.random()*10|0,ty:1});
  else wxP.push({x:L+Math.random()*(R-L),y:CY-50+Math.random()*40,
    vx:wx.vx*1.5,vy:3+Math.random()*1.6,life:60,ty:2});
}
function startWx(){
  const dir=Math.random()<.5?1:-1;
  wx.type=Math.random()<.55?1:2;
  wx.w=130+Math.random()*110;
  wx.vx=dir*(.55+Math.random()*.5);
  wx.x=dir>0?-wx.w/2-10:RW+wx.w/2+10;
  if(wx.type===1){log("SCOUR FRONT · BEARING "+(dir>0?"094":"274")+" · ABRASIVE");flash(9);sfx.thump()}
  else{log("PRECIPITATION CELL · SUBSTRATE BLOOM EXPECTED");flash(8)}
}
function scheduleEvent(){
  const r=Math.random();
  if(r<.3){sweepX=-12;log("SURVEY SWEEP · FIELD CONTOURS EXPOSED");flash(6)}
  else if(r<.5){auroraT=12*TPS;log("CHROMATIC DRIFT · SPECTRUM UNSTABLE");flash(7)}
  else if(r<.78){
    const ci=(Math.random()*NC)|0;
    pulseAt(ci%GW,ci/GW|0,17,12);
    log("RECLAMATION ORDER · SEC "+secOf(ci)+" · AUTORITÉ NON VÉRIFIÉE");flash(5)}
  else{
    for(let i=0;i<NC;i++)if(fbm((i%GW)*.07+t*.001,(i/GW|0)*.09)>0.6)
      RES[i]=Math.min(1.5,RES[i]+.4);
    log("NUTRIENT FRONT · SUBSTRATE ENRICHED");flash(8)}
}
function markReveal(){
  for(let y=0;y<GD;y++)for(let x=0;x<GW;x++){
    const px=CX+x*CW;
    if(Math.abs(px-sweepX)<8){
      const i=y*GW+x;
      if((ZO[i]*6)%1<.14)RV[i]=1;
    }
  }
}
function mutateBand(){
  const y0=(Math.random()*(GD-10))|0;
  for(let y=y0;y<y0+8;y++)for(let x=0;x<GW;x++){
    const i=y*GW+x;
    if(STA[i]===sB&&Math.random()<.6)SY[i]=(Math.random()*4|0)|(SY[i]&~3);
  }
}
function pulseAt(gx,gy,radius,amp){
  for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
    const x=gx+dx,y=gy+dy;
    if(x<0||x>=GW||y<0||y>=GD)continue;
    const d=Math.sqrt(dx*dx+dy*dy);if(d>radius)continue;
    const i=y*GW+x,f=amp*(1-d/radius);
    if(STA[i]===sB)SS[i]+=f*(.6+.8*Math.random());
    else if(STA[i]===sG&&f>8)shatter(i);
  }
  rings.push({x:CX+gx*CW+3,y:CY+gy*RS+3,r:3,max:radius*CW*1.2});
}

/* ═══ rendering: the expedition plate ═══ */
const cv=document.getElementById('v'), mctx=cv.getContext('2d');
const off=document.createElement('canvas');off.width=RW;off.height=RH;
const ctx=off.getContext('2d');
let dpr=1,mw=0,mh=0,scale=1,ox=0,oy=0,vig=null,grain=null;

function resize(){
  dpr=window.devicePixelRatio||1;
  mw=Math.round(innerWidth*dpr);mh=Math.round(innerHeight*dpr);
  cv.width=mw;cv.height=mh;
  /* reserve strips top & bottom for the Sound Labs chrome, so the brand
     card and tool tag sit on the dark frame and never cover the plate */
  const mTop=84*dpr, mBot=72*dpr, availH=Math.max(1,mh-mTop-mBot);
  /* VH = visible plate height: crop off the old HUD strip below the desert */
  scale=Math.min(mw/RW,availH/VH);
  ox=(mw-RW*scale)/2|0;oy=(mTop+(availH-VH*scale)/2)|0;
  vig=document.createElement('canvas');vig.width=mw;vig.height=mh;
  const g=vig.getContext('2d'),
    rad=g.createRadialGradient(mw/2,mh/2,Math.min(mw,mh)*.36,mw/2,mh/2,Math.max(mw,mh)*.74);
  rad.addColorStop(0,'rgba(0,0,0,0)');rad.addColorStop(1,'rgba(44,26,18,.4)');
  g.fillStyle=rad;g.fillRect(0,0,mw,mh);
  grain=document.createElement('canvas');grain.width=160;grain.height=160;
  const gg=grain.getContext('2d');
  for(let k=0;k<3400;k++){
    gg.fillStyle=Math.random()<.8?`rgba(58,44,48,${Math.random()*.07})`:`rgba(255,250,235,${Math.random()*.05})`;
    gg.fillRect(Math.random()*160|0,Math.random()*160|0,1,1);
  }
}
addEventListener('resize',resize);resize();

const stars=[];for(let i=0;i<90;i++)stars.push([Math.random()*RW,Math.random()*(CY-18),Math.random()]);

/* per-frame palette cache */
const PB=GD>>1;
const facCache=new Array(4*PB*2), roofCache=new Array(4*PB*2), inkRow=new Array(PB),
      glassCache=new Array(PB), floraCache=new Array(PB), groundBand=new Array(8);
let winCol='', winA=0, accentNight=0;

function buildPalette(){
  const dph=(t%SOL)/SOL, elev=Math.sin(dph*TAU);
  day=sstep(-.12,.3,elev);night=1-day;
  const aur=auroraT>0?Math.sin(clamp(auroraT/(12*TPS),0,1)*Math.PI):0;
  sunC=mix([214,72,52],[236,118,84],clamp(elev,0,1));
  /* flat paper skies: pale turquoise→cream by day, indigo plate by night */
  skyZen=mix([30,28,64],[178,212,200],day);
  skyHor=mix([72,56,92],[244,226,186],day);
  if(aur>0){skyZen=mix(skyZen,[120,190,170],aur*.35);skyHor=mix(skyHor,[230,170,160],aur*.35)}
  fogHor=mix(skyHor,[226,206,196],.35);
  for(let b=0;b<8;b++){
    const k=b/7;
    const dayC=mix([216,186,148],[234,210,166],k);         // dusty rose-sand → warm sand
    const nightC=mix([56,50,92],[34,32,62],k);
    groundBand[b]=css(mix(mix(nightC,dayC,day),fogHor,(1-k)*.42));
  }
  winA=.5+.4*night;
  winCol=night>.45?rgba(WINDOW_N,.55+.4*night):rgba(INK,.5);
  for(let rb=0;rb<PB;rb++){
    const fogK=Math.round(Math.pow(1-(rb*2)/GD,1.3)*.58*4)/4;   // posterized depth
    inkRow[rb]=css(mix(mix(INK,[30,26,54],night*.5),fogHor,fogK*.9));
    glassCache[rb]=css(mix(mix(GLASS_C,NIGHT_BODY,night*.45),fogHor,fogK));
    floraCache[rb]=css(mix(mix(FLORA_B,[56,86,82],night*.42),fogHor,fogK));
    for(let st=0;st<4;st++){
      for(let v=0;v<2;v++){
        const bright=v?1.12:.9;
        let body=[FAC[st][0]*bright,FAC[st][1]*bright,FAC[st][2]*bright];
        body=mix(body,NIGHT_BODY,night*.58);
        facCache[(st*PB+rb)*2+v]=css(mix(body,fogHor,fogK));
        let roof=mix(body,CREAM,.5+.1*day);
        roofCache[(st*PB+rb)*2+v]=css(mix(roof,fogHor,fogK*.8));
      }
    }
  }
}

function render(rt){
  /* sky: posterized bands */
  const NB=7;
  for(let b=0;b<NB;b++){
    ctx.fillStyle=css(mix(skyZen,skyHor,b/(NB-1)));
    ctx.fillRect(0,b*CY/NB,RW,CY/NB+1);
  }
  if(night>.08){ctx.fillStyle=rgba(CREAM,.7*night);
    for(const s of stars)if(s[2]<.8)ctx.fillRect(s[0],s[1],1,1)}
  /* flat disc sun (day) and moon (night), each with a ring */
  {const dph=(t%SOL)/SOL, elev=Math.sin(dph*TAU);
   const drawDisc=(frac,el,r,col,ring)=>{
     if(el<=-.06)return;
     const sx=RW*(.12+.76*frac), sy=CY-12-el*78;
     ctx.fillStyle=css(col);
     ctx.beginPath();ctx.arc(sx,sy,r,0,TAU);ctx.fill();
     ctx.strokeStyle=rgba(col,.55);ctx.lineWidth=1.5;
     ctx.beginPath();ctx.arc(sx,sy,r+ring,0,TAU);ctx.stroke();
     return [sx,sy]};
   drawDisc(dph,elev,30,sunC,8);
   const mph=(dph+.5)%1, mel=Math.sin(mph*TAU);
   const mp=drawDisc(mph,mel,16,mix([222,222,212],skyZen,.18),6);
   if(mp){ctx.fillStyle='rgba(120,116,140,.5)';
     ctx.fillRect(mp[0]-5,mp[1]-3,3,3);ctx.fillRect(mp[0]+3,mp[1]+4,2,2)}}
  /* banded clouds */
  for(const c of clouds){
    c.x+=c.s;if(c.x>RW+90)c.x=-c.w-60;
    const ca=.32+.5*day;
    ctx.fillStyle=rgba(mix(CREAM,skyZen,.12),ca);
    ctx.fillRect(c.x,c.y,c.w,6);
    ctx.fillRect(c.x+c.w*.16,c.y-5,c.w*.58,5);
    ctx.fillRect(c.x+c.w*.34,c.y-9,c.w*.3,4);
    ctx.fillStyle=rgba(INK,.18*ca*2);
    ctx.fillRect(c.x+2,c.y+6,c.w-4,1);
  }
  /* chromatic drift ribbons */
  if(auroraT>0){const aur=Math.sin(clamp(auroraT/(12*TPS),0,1)*Math.PI);
    for(let rb=0;rb<3;rb++){
      ctx.strokeStyle=rgba(rb===1?[226,150,140]:[130,200,180],.2*aur);
      ctx.lineWidth=2;ctx.beginPath();
      for(let x=0;x<=RW;x+=16){
        const y=20+rb*15+Math.sin(x*.02+rt*.7+rb*2)*7+Math.sin(x*.005-rt*.3)*5;
        x?ctx.lineTo(x,y):ctx.moveTo(x,y)}
      ctx.stroke()}}
  /* storm cloud bank riding the front */
  if(wx.type){
    const cc=wx.type===1?mix([150,118,104],skyHor,.25):mix([128,138,158],skyHor,.3);
    ctx.fillStyle=rgba(cc,.85);
    const bw=wx.w*1.15;
    ctx.fillRect(wx.x-bw/2,34,bw,9);
    ctx.fillRect(wx.x-bw*.38,26,bw*.76,8);
    ctx.fillRect(wx.x-bw*.22,19,bw*.44,7);
    ctx.fillStyle=rgba(INK,.3);ctx.fillRect(wx.x-bw/2+3,43,bw-6,1);
  }
  /* horizon mesas */
  ctx.fillStyle=css(mix(mix(fogHor,[120,96,124],.5),skyHor,.42));
  for(const m of wall){ctx.fillRect(m.x,CY-m.h,m.w,m.h+2);
    if(m.a)ctx.fillRect(m.x+m.w/2,CY-m.h-5,1,5)}
  ctx.fillStyle=rgba(INK,.22);
  for(const m of wall)ctx.fillRect(m.x,CY-m.h,m.w,1);
  /* desert floor: flat bands + contour rules + stipple */
  for(let b=0;b<8;b++){
    const y0=CY+b*(GD*RS)/8;
    ctx.fillStyle=groundBand[b];
    ctx.fillRect(0,y0,RW,(GD*RS)/8+1);
    if(b)ctx.fillStyle=rgba(INK,.08),ctx.fillRect(0,y0,RW,1);
  }
  ctx.fillStyle=groundBand[7];ctx.fillRect(0,CY+GD*RS,RW,HUD_Y-CY-GD*RS);  // apron
  for(const s of stipple){
    const i=s[1]*GW+s[0];
    if(STA[i]!==sE)continue;
    ctx.fillStyle=rgba(INK,.13+.1*s[2]);
    ctx.fillRect(CX+s[0]*CW+(s[2]*4|0),CY+s[1]*RS+(s[2]*7|0)%5,1,1);
  }
  /* ground stains: rubble, embers, frost, revealed contours */
  for(let y=0;y<GD;y++){const by=CY+y*RS;
    for(let x=0;x<GW;x++){
      const i=y*GW+x, he=HE[i], px=CX+x*CW;
      if(RES[i]>.12&&STA[i]===sE){ctx.fillStyle=rgba(RUIN_C,Math.min(.34,RES[i]*.26));ctx.fillRect(px,by+1,5,3)}
      if(he>.06){ctx.fillStyle=rgba(EMBER,Math.min(.5,he*.36));ctx.fillRect(px,by,6,RS)}
      else if(he<-.06){ctx.fillStyle=rgba(ICEC,Math.min(.45,-he*.34));ctx.fillRect(px,by,6,RS)}
      if(RV[i]>.05){ctx.fillStyle=rgba([60,150,140],RV[i]*.6);ctx.fillRect(px,by+2,5,1)}
    }}
  /* the city: painter's order, ligne claire */
  const blink=(t>>3)&7;
  for(let y=0;y<GD;y++){
    const base=CY+y*RS+5, rb=y>>1;
    for(let x=0;x<GW;x++){
      const i=y*GW+x, st=STA[i];
      if(st===sE)continue;
      let hh=Math.max(1,HT[i]|0);
      if(mic.on&&(st===sB||st===sV)){
        const bi=clamp(7-(HT[i]*7/MAXH|0)+(i&1),0,7);   // tall→bass, short→treble
        const k=st===sV?.5:1;
        const boost=hh*BND_AMP[bi]*BND[bi]*k;
        /* `|0` truncates toward zero, so short buildings' boosts (often
           under 1px) always vanished silently. Round instead, and force
           a visible 1px bump on a real hit so small buildings join in too. */
        let bump=Math.round(boost);
        if(bump===0&&BND[bi]>.3)bump=1;
        hh=Math.min(base-12,hh+bump);
      }
      let px=CX+x*CW;
      const topY=base-hh;
      if(st===sU){
        ctx.fillStyle=css(mix(RUIN_C,NIGHT_BODY,night*.5));ctx.fillRect(px+1,base-3,4,3);
        ctx.fillStyle=inkRow[rb];ctx.fillRect(px+1,base-3,1,1);
        continue}
      if(st===sV){
        const ic=inkRow[rb];
        ctx.fillStyle=ic;ctx.fillRect(px,topY-1,5,hh+2);
        ctx.fillStyle=floraCache[rb];ctx.fillRect(px+1,topY,3,hh);
        ctx.fillStyle=ic;ctx.fillRect(px+1,topY-2,3,1);
        ctx.fillStyle=floraCache[rb];ctx.fillRect(px+1,topY-1,3,1);
        ctx.fillStyle='rgba(255,255,255,.16)';ctx.fillRect(px+1,topY,3,1);
        if(hh>4&&(i%3)===0){ctx.fillStyle=rgba(FLOWER,.95);ctx.fillRect(px+2,topY-3,1,2)}
        continue}
      const sty=SY[i]&3, v=(SY[i]&4)?1:0, shape=(SY[i]>>3)&3;
      const ic=inkRow[rb];
      if(st===sG){
        ctx.fillStyle=ic;ctx.fillRect(px,topY-1,6,hh+2);
        ctx.fillStyle=glassCache[rb];ctx.fillRect(px+1,topY,4,hh);
        ctx.fillStyle='rgba(255,255,255,.5)';ctx.fillRect(px+2,topY+1,1,Math.max(1,hh-2));
        ctx.fillStyle=css(CREAM);ctx.fillRect(px+1,topY,4,1);
        continue}
      if(st===sF){
        if(AX[i]>0&&((t+i)&1))px+=Math.random()<.5?-1:1;
        ctx.fillStyle=ic;ctx.fillRect(px,topY-1,6,hh+2);
        ctx.fillStyle=AX[i]<0?rgba(CREAM,.95):facCache[(sty*PB+rb)*2+v];
        ctx.fillRect(px+1,topY,4,hh+1);
        continue}
      /* ink silhouette, flat body, cream roofline */
      if(shape===3&&hh>20){                       // terraced setback
        const upper=hh*.45|0;
        ctx.fillStyle=ic;
        ctx.fillRect(px,base-(hh-upper)-1,6,hh-upper+1);
        ctx.fillRect(px+1,topY-1,4,upper+2);
        ctx.fillStyle=facCache[(sty*PB+rb)*2+v];
        ctx.fillRect(px+1,base-(hh-upper),4,hh-upper);
        ctx.fillRect(px+2,topY,2,upper);
        ctx.fillStyle=roofCache[(sty*PB+rb)*2+v];
        ctx.fillRect(px+2,topY,2,1);ctx.fillRect(px+1,base-(hh-upper),4,1);
      }else{
        ctx.fillStyle=ic;ctx.fillRect(px,topY-1,6,hh+2);
        ctx.fillStyle=facCache[(sty*PB+rb)*2+v];
        ctx.fillRect(px+1,topY,4,hh+1);
        ctx.fillStyle=roofCache[(sty*PB+rb)*2+v];
        ctx.fillRect(px+1,topY,4,1);
        if(shape===1&&hh>14){                     // spire mast
          const ml=Math.min(9,3+hh*.12|0);
          ctx.fillStyle=ic;ctx.fillRect(px+2,topY-ml,1,ml);
          ctx.fillStyle=css(CREAM);ctx.fillRect(px+2,topY-ml,1,1);
        }else if(shape===2&&hh>10){               // dome cap
          ctx.fillStyle=ic;ctx.fillRect(px+1,topY-2,4,1);ctx.fillRect(px+2,topY-3,2,1);
          ctx.fillStyle=roofCache[(sty*PB+rb)*2+v];ctx.fillRect(px+2,topY-2,2,1);
        }
      }
      if(hh>16){                                  // window seam
        ctx.fillStyle=winCol;ctx.globalAlpha=.6;
        ctx.fillRect(px+3,topY+3,1,hh-6);
        ctx.globalAlpha=1;
      }
      if(hh>44&&night>.4){                        // landmark windows ignite at night
        ctx.fillStyle=rgba(WINDOW_N,.9);
        for(let wy=topY+4;wy<base-4;wy+=5)ctx.fillRect(px+1,wy,1,1);
      }
      if(hh>40&&((i+blink)&7)===0){ctx.fillStyle=rgba(FLOWER,.9);ctx.fillRect(px+2,topY-2,1,1)}
      const age=t-BO[i],
        eff=SB[i]*(age<500?1.25:1)*(1-Math.min(.62,age/((90+(i&7)*8)*TPS)*.62));
      if(SS[i]>eff*.82&&((t+i)&3)<2){ctx.fillStyle='rgba(198,52,32,.9)';ctx.fillRect(px+1,topY-1,2,1)}
      if(HE[i]>.5){ctx.fillStyle=rgba(EMBER,.55);ctx.fillRect(px+1,base-1,4,1)}
    }
  }
  /* debris · weather particles · carriers · rings */
  for(const d of debris){ctx.fillStyle=d.c;ctx.globalAlpha=Math.min(1,d.life/20);
    ctx.fillRect(d.x,d.y,1,1)}
  ctx.globalAlpha=1;
  for(const p of wxP){
    if(p.ty===1){ctx.fillStyle=rgba([196,160,110],.5);ctx.fillRect(p.x,p.y,3,1)}
    else{ctx.fillStyle=rgba([170,190,210],.55);ctx.fillRect(p.x,p.y,1,4)}
  }
  for(const f of fliers){
    const bl=Math.sin(rt*6+f.ph)>.55;
    ctx.fillStyle=rgba(INK,.85);
    if(f.big){ctx.fillRect(f.x-2,f.y,5,2);ctx.fillRect(f.x,f.y-1,2,1);
      ctx.fillStyle=rgba(bl?FLOWER:CREAM,.95);ctx.fillRect(f.x+(f.vx>0?2:-2),f.y,1,1)}
    else{ctx.fillRect(f.x,f.y,2,1);
      if(bl){ctx.fillStyle=rgba(CREAM,.9);ctx.fillRect(f.x+(f.vx>0?-2:3),f.y,1,1)}}
    ctx.fillStyle=rgba(INK,.18);
    ctx.fillRect(f.x-(f.vx>0?9:-6),f.y+1,5,1);
  }
  for(const r of rings){
    ctx.strokeStyle=rgba(INK,.6*(1-r.r/r.max));ctx.lineWidth=1;
    ctx.beginPath();ctx.ellipse(r.x,r.y,r.r,r.r*.55,0,0,TAU);ctx.stroke();
    ctx.strokeStyle=rgba(CREAM,.5*(1-r.r/r.max));
    ctx.beginPath();ctx.ellipse(r.x,r.y,r.r*.8,r.r*.44,0,0,TAU);ctx.stroke();
  }
  /* survey beam */
  if(sweepX>-999&&sweepX<RW+12){
    ctx.fillStyle='rgba(60,150,140,.13)';ctx.fillRect(sweepX-9,0,18,HUD_Y-4);
    ctx.fillStyle='rgba(60,150,140,.65)';ctx.fillRect(sweepX,0,1,HUD_Y-4);
  }
  if(P.act&&P.cold){
    ctx.strokeStyle=rgba(ICEC,.75);ctx.lineWidth=1;
    ctx.beginPath();ctx.ellipse(CX+P.gx*CW,CY+P.gy*RS,13,7,0,0,TAU);ctx.stroke();
  }
  if(hud)drawHUD(rt);
  drawIntro();
  /* drafting bezel */
  ctx.strokeStyle=rgba(INK,.5);ctx.lineWidth=1;
  ctx.strokeRect(3.5,3.5,RW-7,VH-7);
  ctx.strokeStyle=rgba(INK,.22);
  ctx.strokeRect(7.5,7.5,RW-15,VH-15);
}

/* ── the instrument face: ink on paper ── */
function drawHUD(rt){
  ctx.fillStyle='rgba(238,228,205,.95)';ctx.fillRect(8,HUD_Y,RW-16,RH-HUD_Y-8);
  ctx.fillStyle=rgba(INK,.65);ctx.fillRect(8,HUD_Y,RW-16,1);
  ctx.fillStyle=rgba(INK,.25);ctx.fillRect(8,HUD_Y+2,RW-16,1);
  ctx.font='9px monospace';ctx.textBaseline='top';
  const ink=a=>rgba(INK,a);
  /* top captions */
  ctx.fillStyle=ink(.8);
  ctx.fillText('Σ-9 · RELEVÉ DU TERRITOIRE NON-INCORPORÉ',14,14);
  const sol=1+(t/SOL|0), dph=(t%SOL)/SOL;
  ctx.fillStyle=ink(.55);
  ctx.fillText('SOL '+sol+' · φ'+dph.toFixed(2)+(paused?' · SUSPENDU':'')+(sfx.on?' · ♪':'')+(mic.on?' · ⊜':''),14,25);
  if(chi>.62){ctx.fillStyle=`rgba(198,52,32,${.5+.5*Math.sin(rt*5)})`;
    ctx.fillText('⚠ CRITICALITÉ',14,36)}
  /* glyph sigils */
  for(let gi=0;gi<10;gi++){
    const fl=glyFlash[gi];glyFlash[gi]*=.97;
    ctx.fillStyle=rgba(mix(INK,[198,52,32],fl),.3+.7*fl);
    for(let b=0;b<35;b++)if(GLY[gi*35+b])
      ctx.fillRect(RW-104+gi*9+(b%5),14+(b/5|0),1,1);
  }
  if((t%60)===0)GLY[(Math.random()*350)|0]^=1;
  /* spectral bands */
  if(mic.on){
    ctx.fillStyle=ink(.2);ctx.fillRect(RW-104,33,90,1);
    for(let b=0;b<8;b++){
      const v=Math.min(1,BND[b]);
      ctx.fillStyle=rgba([198,52,32],.3+.6*v);
      ctx.fillRect(RW-104+b*11,33-v*8,8,Math.max(1,v*8));
    }
  }
  /* log */
  for(let k=0;k<4;k++){
    const L=logs[logs.length-1-k];if(!L)break;
    const age=(t-L.t)/TPS, a=clamp(1.1-age/16,0,1)*(k?.5:.9);
    ctx.fillStyle=ink(a);
    ctx.fillText('▸ '+L.s,14,HUD_Y+8+k*11);
  }
  /* readouts */
  const fmt=v=>v>9999?(v/1e3).toFixed(1)+'k':v|0;
  ctx.fillStyle=ink(.85);
  ctx.fillText('Σμ '+fmt(massNow),356,HUD_Y+8);
  ctx.fillText('N̂  '+bCount,356,HUD_Y+19);
  ctx.fillText('Φ  '+vCount,356,HUD_Y+30);
  ctx.fillStyle=chi>.6?'rgba(198,52,32,.95)':ink(.85);
  ctx.fillText('χ  '+chi.toFixed(2),430,HUD_Y+8);
  ctx.fillStyle=ink(.85);
  ctx.fillText('θ̄  '+heatBar.toFixed(2),430,HUD_Y+19);
  ctx.fillText('ζ  '+(wx.type===1?'SCOUR':wx.type===2?'PLUIE':'CALME'),430,HUD_Y+30);
  /* mass trend */
  ctx.fillStyle=ink(.4);ctx.fillText('Σμ«',506,HUD_Y+6);
  let mmax=1;for(let k=0;k<96;k++)if(massHist[k]>mmax)mmax=massHist[k];
  ctx.fillStyle=ink(.75);
  for(let k=0;k<96;k++){
    const vv=massHist[(massPtr+k)%96]/mmax;
    ctx.fillRect(506+k,HUD_Y+42-vv*26,1,1);
  }
  /* event magnitudes */
  ctx.fillStyle=ink(.4);ctx.fillText('μ-LOG',614,HUD_Y+6);
  for(let k=0;k<evMags.length;k++){
    const m=evMags[k];
    ctx.fillStyle=m>4?'rgba(198,52,32,.85)':ink(.6);
    const bh=Math.min(26,m*4);
    ctx.fillRect(614+k*1.5,HUD_Y+42-bh,1,bh);
  }
  /* keys */
  ctx.fillStyle=ink(.42);ctx.font='8px monospace';
  const keys=['M son','H face','L loupe','A oreille','R site','␣ tenir'];
  for(let k=0;k<6;k++)ctx.fillText(keys[k],706,HUD_Y+6+k*10);
  ctx.font='9px monospace';
}

function drawIntro(){
  if(introDone)return;
  let a=1;
  if(introFadeAt>=0){
    a=clamp(1-(t-introFadeAt)/22,0,1);
    if(a<=0){introDone=true;return}
  }
  ctx.fillStyle=`rgba(238,228,205,${.72*a})`;ctx.fillRect(40,128,RW-80,190);
  ctx.strokeStyle=rgba(INK,.6*a);ctx.strokeRect(44.5,132.5,RW-89,181);
  ctx.textAlign='center';ctx.textBaseline='top';
  const ink=al=>rgba(INK,al*a);
  ctx.fillStyle=ink(.95);ctx.font='13px monospace';
  ctx.fillText('LIVING CITY',RW/2,150);
  ctx.fillStyle='rgba(198,52,32,'+(.85*a)+')';ctx.font='9px monospace';
  ctx.fillText('A SETTLEMENT THAT BUILDS ITSELF',RW/2,170);
  ctx.fillStyle=ink(.82);
  ctx.fillText('It builds. It strains. It falls. The garden grows back.',RW/2,198);
  ctx.fillText('Move your cursor over the ground to warm it and speed things up.',RW/2,212);
  ctx.fillStyle=ink(.7);
  ctx.fillText('A  turn on your microphone — the city grows to your music',RW/2,240);
  ctx.fillText('M sound     R new city     space pause',RW/2,254);
  ctx.fillStyle=ink(.9);
  ctx.fillText('WATCH. YOU CAN NUDGE IT, NOT CONTROL IT.',RW/2,282);
  if(introFadeAt<0){
    const pulse=.55+.35*Math.sin(t*.09);
    ctx.fillStyle=`rgba(198,52,32,${pulse*a})`;ctx.font='10px monospace';
    ctx.fillText('CLICK ANYWHERE TO BEGIN',RW/2,300);
  }
  ctx.textAlign='left';
}

/* ── composite: plate → screen, paper grain, loupe ── */
function composite(){
  mctx.fillStyle='#14100f';mctx.fillRect(0,0,mw,mh);
  const sx=ox+((Math.random()-.5)*shake*scale|0), sy=oy+((Math.random()-.5)*shake*scale|0);
  mctx.imageSmoothingEnabled=false;
  mctx.drawImage(off,0,0,RW,VH,sx,sy,RW*scale,VH*scale);
  mctx.save();
  mctx.globalAlpha=.5;
  mctx.fillStyle=mctx.createPattern(grain,'repeat');
  mctx.fillRect(ox,oy,RW*scale,VH*scale);
  mctx.restore();
  mctx.drawImage(vig,0,0);
  if(lensOn&&P.act&&!P.down)drawLens();
}
function drawLens(){
  const destR=Math.min(mh*.16,120*dpr);
  const m=3, srcR=clamp(destR/(m*scale),8,46);
  const cxs=ox+P.x*scale, cys=oy+Math.min(P.y,HUD_Y-26)*scale;
  const sx0=clamp(P.x-srcR,0,RW-2*srcR), sy0=clamp(Math.min(P.y,HUD_Y-26)-srcR,0,RH-2*srcR);
  mctx.save();
  mctx.beginPath();mctx.arc(cxs,cys,destR,0,TAU);mctx.clip();
  mctx.imageSmoothingEnabled=false;
  mctx.drawImage(off,sx0,sy0,srcR*2,srcR*2,cxs-destR,cys-destR,destR*2,destR*2);
  mctx.restore();
  mctx.lineWidth=Math.max(1.5,scale*.8);
  mctx.strokeStyle='rgba(58,44,48,.9)';
  mctx.beginPath();mctx.arc(cxs,cys,destR,0,TAU);mctx.stroke();
  mctx.strokeStyle='rgba(238,228,205,.7)';
  mctx.beginPath();mctx.arc(cxs,cys,destR+Math.max(2,scale*1.6),0,TAU);mctx.stroke();
  for(let k=0;k<4;k++){const a=k*TAU/4;
    mctx.strokeStyle='rgba(58,44,48,.8)';
    mctx.beginPath();
    mctx.moveTo(cxs+Math.cos(a)*destR*.86,cys+Math.sin(a)*destR*.86);
    mctx.lineTo(cxs+Math.cos(a)*destR,cys+Math.sin(a)*destR);
    mctx.stroke()}
  /* specimen tag removed — just a clean magnifier, no numbers */
}

/* ═══ audio: hum, wind, rumbles ═══ */
const sfx={on:false,ac:null,master:null,nbuf:null,voices:0,lastT:0,windG:null,windBP:null,
  init(){if(this.ac)return;
    try{
      const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
      this.ac=new AC();
      this.master=this.ac.createGain();this.master.gain.value=.42;
      const comp=this.ac.createDynamicsCompressor();
      this.master.connect(comp);comp.connect(this.ac.destination);
      const nb=this.ac.createBuffer(1,this.ac.sampleRate*2,this.ac.sampleRate),
        d=nb.getChannelData(0);
      for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
      this.nbuf=nb;
      const lp=this.ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=190;
      const dg=this.ac.createGain();dg.gain.value=.08;
      lp.connect(dg);dg.connect(this.master);
      for(const[f,g]of[[54,.5],[54.6,.5],[27,.8]]){
        const o=this.ac.createOscillator();o.type=f<30?'sine':'sawtooth';
        o.frequency.value=f;
        const og=this.ac.createGain();og.gain.value=g;
        o.connect(og);og.connect(lp);o.start();
      }
      const lfo=this.ac.createOscillator();lfo.frequency.value=.05;
      const lg=this.ac.createGain();lg.gain.value=55;
      lfo.connect(lg);lg.connect(lp.frequency);lfo.start();
      const ws=this.ac.createBufferSource();ws.buffer=nb;ws.loop=true;
      this.windBP=this.ac.createBiquadFilter();this.windBP.type='bandpass';
      this.windBP.frequency.value=380;this.windBP.Q.value=.7;
      this.windG=this.ac.createGain();this.windG.gain.value=.022;
      ws.connect(this.windBP);this.windBP.connect(this.windG);this.windG.connect(this.master);ws.start();
      const lfo2=this.ac.createOscillator();lfo2.frequency.value=.073;
      const lg2=this.ac.createGain();lg2.gain.value=190;
      lfo2.connect(lg2);lg2.connect(this.windBP.frequency);lfo2.start();
      this.on=true;
    }catch(e){}
  },
  toggle(){this.init();if(!this.ac)return;
    this.on=!this.on;this.master.gain.value=this.on?.42:0;
    if(this.on)this.ac.resume()},
  env(node,peak,att,dec){const g=this.ac.createGain(),T=this.ac.currentTime;
    g.gain.setValueAtTime(0,T);g.gain.linearRampToValueAtTime(peak,T+att);
    g.gain.exponentialRampToValueAtTime(.0005,T+att+dec);
    node.connect(g);g.connect(this.master);
    this.voices++;setTimeout(()=>this.voices--,(att+dec)*1000+80);
    return T},
  ok(){return this.on&&this.ac&&this.voices<9&&performance.now()-this.lastT>50},
  crumble(h){if(!this.ok())return;this.lastT=performance.now();
    const s=this.ac.createBufferSource();s.buffer=this.nbuf;
    s.playbackRate.value=.5+Math.random()*.3;
    const f=this.ac.createBiquadFilter();f.type='lowpass';f.frequency.value=110+h*3;
    s.connect(f);
    const T=this.env(f,.05+Math.min(.3,h*.003),.008,.2+Math.min(1,h*.008));
    s.start(T);s.stop(T+1.4)},
  boom(m){if(!this.on||!this.ac)return;
    const o=this.ac.createOscillator();o.type='sine';
    const T0=this.ac.currentTime;
    o.frequency.setValueAtTime(82,T0);o.frequency.exponentialRampToValueAtTime(30,T0+.9);
    const T=this.env(o,Math.min(.5,.15+m*.0005),.01,1.1);o.start(T);o.stop(T+1.2)},
  ping(){if(!this.ok())return;this.lastT=performance.now();
    const o=this.ac.createOscillator();o.type='triangle';
    const T0=this.ac.currentTime;
    o.frequency.setValueAtTime(1380,T0);o.frequency.exponentialRampToValueAtTime(880,T0+.22);
    const T=this.env(o,.06,.005,.25);o.start(T);o.stop(T+.3)},
  shatter(){if(!this.ok())return;this.lastT=performance.now();
    const s=this.ac.createBufferSource();s.buffer=this.nbuf;s.playbackRate.value=1.6;
    const f=this.ac.createBiquadFilter();f.type='highpass';f.frequency.value=2200;
    s.connect(f);const T=this.env(f,.1,.004,.28);s.start(T);s.stop(T+.4);this.ping()},
  thump(){if(!this.on||!this.ac)return;
    const o=this.ac.createOscillator();o.type='sine';
    const T0=this.ac.currentTime;
    o.frequency.setValueAtTime(72,T0);o.frequency.exponentialRampToValueAtTime(34,T0+.32);
    const T=this.env(o,.34,.006,.4);o.start(T);o.stop(T+.5)}
};

/* ── microphone: the territory hears your room ── */
const mic={on:false,an:null,buf:null,level:0,bass:0,treb:0,prev:0,onset:false,lastQ:-999};
/* 8 spectral bands with spring envelopes — the skyline is an equalizer */
const BND=new Float32Array(8), bndFloor=new Float32Array(8).fill(.05),
      bndP=new Float32Array(8), bndV=new Float32Array(8);
const BND_R=[[1,3],[3,6],[6,10],[10,16],[16,26],[26,42],[42,70],[70,110]];
const BND_AMP=[.55,.5,.44,.4,.36,.32,.29,.26];   // bigger than before, and see the "excess above floor" fix below
async function toggleMic(){
  if(mic.on){mic.on=false;log("CANAL AUDITIF FERMÉ");return}
  sfx.init();if(!sfx.ac)return;
  try{
    const st=await navigator.mediaDevices.getUserMedia({audio:true});
    const src=sfx.ac.createMediaStreamSource(st);
    mic.an=sfx.ac.createAnalyser();mic.an.fftSize=256;
    src.connect(mic.an);
    mic.buf=new Uint8Array(mic.an.frequencyBinCount);
    mic.on=true;sfx.ac.resume();
    log("CANAL AUDITIF OUVERT · LISTENING");
  }catch(e){log("CANAL AUDITIF REFUSÉ")}
}
function micPoll(){
  if(!mic.on||!mic.an){for(let k=0;k<8;k++)BND[k]*=.88;return}
  mic.an.getByteFrequencyData(mic.buf);
  let b=0,tr=0,al=0;
  for(let k=1;k<9;k++)b+=mic.buf[k];
  for(let k=48;k<110;k++)tr+=mic.buf[k];
  for(let k=0;k<mic.buf.length;k++)al+=mic.buf[k];
  mic.bass=b/(8*255);mic.treb=tr/(62*255);
  const lv=al/(mic.buf.length*255);
  if(lv-mic.prev>.14)mic.onset=true;
  mic.prev=lerp(mic.prev,lv,.25);mic.level=lv;
  /* per-band spring: fast attack, overshoot, quick settle.
     bndFloor tracks the room's QUIET level (rises slowly, falls fast),
     not the music's peak — so a loud passage never becomes "the new
     normal" the way a peak-chasing gain would. Only energy clearly
     above that floor counts, and a mild curve pushes weak/ambient
     noise down further while letting real hits reach full height. */
  for(let k=0;k<8;k++){
    const r=BND_R[k];let e=0;
    for(let j=r[0];j<r[1];j++)e+=mic.buf[j];
    e/=(r[1]-r[0])*255;
    bndFloor[k]+=(e-bndFloor[k])*(e<bndFloor[k]?.03:.003);
    const ex=Math.max(0,e-bndFloor[k]*1.15)/.22;
    const norm=Math.pow(clamp(ex,0,1),1.25);
    bndV[k]+=(norm-bndP[k])*.6;bndV[k]*=.6;bndP[k]+=bndV[k];
    BND[k]=clamp(bndP[k],0,1.6);
  }
}

/* ═══ input: you are weather, not god ═══ */
const P={x:0,y:0,gx:0,gy:0,act:false,down:false,downAt:0,cold:false};
function toBuf(e){const r=cv.getBoundingClientRect();
  return[((e.clientX-r.left)*dpr-ox)/scale,((e.clientY-r.top)*dpr-oy)/scale]}
function track(e){
  const[bx,by]=toBuf(e);
  P.x=bx;P.y=by;
  const gx=(bx-CX)/CW, gy=(by-CY)/RS;
  P.act=gx>-3&&gx<GW+3&&gy>-8&&gy<GD+3&&by<HUD_Y;
  P.gx=clamp(gx,0,GW-1);P.gy=clamp(gy,0,GD-1);
  P.cold=P.down&&performance.now()-P.downAt>230;
}
cv.addEventListener('pointermove',track);
cv.addEventListener('pointerdown',e=>{
  sfx.init();if(sfx.ac)sfx.ac.resume();
  if(!introDone&&introFadeAt<0){introFadeAt=t;return}   // first click just dismisses the intro
  P.down=true;P.downAt=performance.now();track(e);
});
cv.addEventListener('pointerup',e=>{
  const dur=performance.now()-P.downAt;
  P.down=false;P.cold=false;track(e);
  if(dur<230&&P.act){
    pulseAt(P.gx|0,P.gy|0,14,15);
    log("PRESSURE TRANSIENT · SEC "+secOf((P.gy|0)*GW+(P.gx|0))+" · ORIGINE INCONNUE");
    flash(4);sfx.thump();
  }
});
cv.addEventListener('pointerleave',()=>{P.act=false;P.down=false;P.cold=false});
cv.addEventListener('contextmenu',e=>e.preventDefault());
addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  if(k==='m')sfx.toggle();
  else if(k==='h')hud=!hud;
  else if(k==='l')lensOn=!lensOn;
  else if(k==='a')toggleMic();
  else if(k==='r')reseed(false);
  else if(k===' '){paused=!paused;e.preventDefault()}
  if(sfx.ac)sfx.ac.resume();
});

let thermSeen=0;
setInterval(()=>{
  if(P.act&&!P.cold&&thermSeen<3){
    log("THERMAL ANOMALY · SEC "+secOf((P.gy|0)*GW+(P.gx|0))+" · INEXPLIQUÉE");
    flash(3);thermSeen++;
  }
},9000);

/* ═══ main loop ═══ */
let last=performance.now(), acc=0;
function frame(now){
  requestAnimationFrame(frame);
  let dt=now-last;last=now;
  if(dt>250)dt=250;
  micPoll();
  if(!paused){
    acc+=dt;
    let n=0;
    while(acc>=1000/TPS&&n<5){step();acc-=1000/TPS;n++}
  }
  /* wind follows the weather */
  if(sfx.on&&sfx.windG){
    const tg=wx.type===1?.085:wx.type===2?.05:.022,
      tf=wx.type===1?170:wx.type===2?1700:380;
    sfx.windG.gain.value+=(tg-sfx.windG.gain.value)*.04;
    sfx.windBP.frequency.value+=(tf-sfx.windBP.frequency.value)*.04;
  }
  const rt=now/1000;
  buildPalette();
  render(rt);
  composite();
}
reseed(true);
log("INSTRUMENT EN LIGNE · L'OBSERVATION COMMENCE");
requestAnimationFrame(frame);
