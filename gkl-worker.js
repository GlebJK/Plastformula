/* gkl-worker.js — Web Worker для GPU-driven 3D рендера
 * Источник: plastformula.com / bitrix24
 * Grabs: importScripts(Three.js UMD) → init OffscreenCanvas → render loop
 * Загружается главным потоком через new Worker('https://plastformula.store/gkl-worker.js')
 * v1.0.0 — 2026-04-16
 */

/* gkl-3d-worker-v2.js — GPU-driven 3D renderer
 * ALL granule movement computed in vertex shader (GPU).
 * JS sends only 3 values per frame: uTime, uCursorX, uCursorY.
 * Single scene, single render pass, DPR 1.5 max.
 *
 * BITRIX24: lives inside <script type="text/js-worker"> in HTML block.
 * Main thread reads textContent → Blob → new Worker(blobURL).
 * Three.js loaded via importScripts (UMD build).
 */

var IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (IS_WORKER) importScripts('https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js');

/* ═══ GPU DETECTION ═══ */
let _dpr = 2;
let _isLaptop = false;

function detectGPU(gl) {
  if (!gl) return { tier: 0, renderer: 'none', maxTex: 0 };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rnd = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let tier = 2;
  const r = rnd.toLowerCase();
  if (/powervr|mali-[4t]|adreno\s*[23]\d{2}|intel.*(hd\s*[2-5]|uhd\s*[56][0-2])|swiftshader|llvmpipe|software/i.test(r)) tier = 1;
  if (/nvidia|geforce|radeon|rx\s*[5-9]|adreno\s*[7-9]\d{2}|mali-g[7-9]\d{2}|apple\s*(m[1-9]|a1[5-9]|gpu)|intel.*arc|xe/i.test(r)) tier = 3;
  if (maxTex < 4096) tier = Math.min(tier, 1);
  if (maxTex >= 16384 && tier < 3) tier = Math.min(tier + 1, 3);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { tier, renderer: rnd, maxTex };
}

/* ═══ QUALITY SETTINGS ═══ */
function buildQ(gpuTier, isMobile, _slowNet) {
  const W = _W, H = _H;
  const _PX_BUDGET = isMobile ? 2.5e6 : 4e6;
  const _budgetDPR = Math.sqrt(_PX_BUDGET / (W * H));
  return {
    /* v2: budget severely cut for integrated GPU relief */
    maxDPR: isMobile ? Math.min(_dpr || 2, 1.25, _budgetDPR) : Math.min(_dpr || 2, gpuTier >= 3 ? 1.25 : gpuTier >= 2 ? 1.25 : 1.0, _budgetDPR),
    minDPR: .75,
    dustCount: _slowNet ? 400 : isMobile ? (gpuTier >= 3 ? 1500 : gpuTier >= 2 ? 1000 : 400) : gpuTier >= 3 ? 3000 : gpuTier >= 2 ? 2000 : 700,
    sparkleCount: _slowNet ? 80 : isMobile ? (gpuTier >= 3 ? 400 : gpuTier >= 2 ? 200 : 80) : gpuTier >= 3 ? 700 : gpuTier >= 2 ? 400 : 150,
    granuleCount: _slowNet ? 20 : isMobile ? (gpuTier >= 3 ? 80 : gpuTier >= 2 ? 50 : 20) : gpuTier >= 3 ? 250 : gpuTier >= 2 ? 140 : 35,
    sphereDetail: isMobile ? (gpuTier >= 3 ? [64, 32] : gpuTier >= 2 ? [48, 24] : [32, 16]) : gpuTier >= 3 ? [80, 40] : gpuTier >= 2 ? [64, 32] : [48, 24],
    granuleDetail: isMobile ? (gpuTier >= 3 ? [32, 24] : gpuTier >= 2 ? [24, 16] : [16, 12]) : gpuTier >= 3 ? [32, 24] : gpuTier >= 2 ? [24, 18] : [18, 14],
    antialias: false,
    fogDensity: gpuTier >= 2 ? .028 : .04,
  };
}

/* ═══ ADAPTIVE DPR ═══ */
let _adprDPR = 1.5;
const _PERF = { times: [], maxSamples: 90, cooldown: 3000, lastAdj: 0, targetHi: 55, targetLo: 30, stepDn: .2, stepUp: .1 };
function adaptDPR(renderer, now) {
  _PERF.times.push(now);
  if (_PERF.times.length > _PERF.maxSamples) _PERF.times.shift();
  if (_PERF.times.length < 30 || now - _PERF.lastAdj < _PERF.cooldown) return;
  const fps = (_PERF.times.length - 1) / ((_PERF.times[_PERF.times.length - 1] - _PERF.times[0]) / 1000);
  if (fps < _PERF.targetLo && _adprDPR > Q.minDPR) {
    _adprDPR = Math.max(Q.minDPR, _adprDPR - _PERF.stepDn);
    renderer.setPixelRatio(_adprDPR); renderer.setSize(_W, _H, false);
    _PERF.times = []; _PERF.lastAdj = now;
  } else if (fps > _PERF.targetHi && _adprDPR < Q.maxDPR) {
    _adprDPR = Math.min(Q.maxDPR, _adprDPR + _PERF.stepUp);
    renderer.setPixelRatio(_adprDPR); renderer.setSize(_W, _H, false);
    _PERF.times = []; _PERF.lastAdj = now;
  }
}

/* ═══ GRANULE SHADERS (GPU-DRIVEN) ═══ */

/* NEW vertex shader: all movement in GPU */
const _iVS = `
attribute float aOp;
attribute float aRough;
attribute vec3 aBasePos;
attribute float aPhase;
attribute float aFSpd;
attribute float aFAmp;
attribute float aRotSpd;
attribute float aScale;

uniform float uTime;
uniform vec2 uCursor;

varying vec3 vN, vV, vWP, vIC;
varying float vOp, vRough;

mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }
mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
mat3 rotZ(float a){ float c=cos(a),s=sin(a); return mat3(c,s,0, -s,c,0, 0,0,1); }

void main(){
  vOp = aOp;
  vRough = aRough;
  #ifdef USE_INSTANCING_COLOR
    vIC = instanceColor;
  #else
    vIC = vec3(.9, .3, .5);
  #endif

  /* ── Wander: organic floating motion via sin/cos ── */
  float t = uTime;
  float ph = aPhase;
  float spd = aFSpd;
  float amp = aFAmp;
  
  vec3 wander;
  wander.x = sin(t * spd + ph) * amp * 800.0
           + sin(t * spd * 0.37 + ph * 2.7) * amp * 200.0;
  wander.y = cos(t * spd * 0.72 + ph * 1.33) * amp * 600.0
           + cos(t * spd * 0.28 + ph * 3.1) * amp * 150.0;
  wander.z = sin(t * spd * 0.55 + ph * 2.1) * amp * 200.0;

  vec3 worldPos = aBasePos + wander;

  /* ── Cursor repulsion ── */
  vec2 delta = worldPos.xy - uCursor;
  float dist = length(delta);
  float pushR = 5.0;
  if(dist < pushR && dist > 0.01) {
    float t01 = 1.0 - dist / pushR;
    /* Smoothstep-like curve */
    float sm = t01 * t01 * t01 * (t01 * (t01 * 6.0 - 15.0) + 10.0);
    float pushStr = sm * 2.5;
    worldPos.xy += normalize(delta) * pushStr;
  }

  /* ── Rotation ── */
  float angle = t * aRotSpd;
  mat3 rot = rotY(angle) * rotX(angle * 0.8 + sin(t * spd * 0.3 + ph) * 0.15);

  /* ── Transform ── */
  vec3 localPos = rot * (position * aScale);
  vec4 wP = modelMatrix * vec4(localPos + worldPos, 1.0);
  vWP = wP.xyz;
  
  /* Normal transform with rotation */
  mat3 nM = mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * rot;
  vN = normalize(nM * normal);
  vV = normalize(cameraPosition - wP.xyz);
  
  gl_Position = projectionMatrix * viewMatrix * wP;
}`;

/* Fragment shader: UNCHANGED from original (same lighting, SSS, caustics) */
const _iFS = `varying vec3 vN,vV,vWP,vIC;varying float vOp,vRough;
uniform vec3 uPL1,uPL2,uPL3;
uniform float uTime;
float bp(vec3 L,vec3 N,vec3 V,float pw){return pow(max(dot(normalize(L+V),N),0.),pw);}
float lm(vec3 L,vec3 N){return max(dot(normalize(L),N),0.);}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){
  vec3 N=normalize(vN),V=normalize(vV);
  float NdV=max(dot(N,V),0.);
  float fr=pow(1.-NdV,3.5)*.75;
  vec3 d1=uPL1-vWP;float a1=1./(1.+dot(d1,d1)*.012);d1=normalize(d1);
  vec3 d2=uPL2-vWP;float a2=1./(1.+dot(d2,d2)*.018);d2=normalize(d2);
  vec3 d3=uPL3-vWP;float a3=1./(1.+dot(d3,d3)*.022);d3=normalize(d3);
  vec3 dW=normalize(uPL1-vWP);vec3 dO=normalize(uPL2-vWP);
  vec3 dT=normalize(vec3(0.,20.,10.)-vWP);
  vec3 diff=lm(d1,N)*a1*vec3(.91,.27,.50)*.35+lm(d2,N)*a2*vec3(.16,.96,.83)*.28+lm(d3,N)*a3*vec3(.78,.31,.94)*.24+lm(dW,N)*vec3(.85,.40,.70)*.20+lm(dO,N)*vec3(.16,.82,.65)*.16+lm(dT,N)*vec3(.85,.92,1.)*.14;
  float spw=200.+vRough*300.;
  vec3 spec=bp(d1,N,V,spw)*a1*vec3(.9,.5,.7)*2.4+bp(d2,N,V,spw*.8)*a2*vec3(.4,.9,.8)*1.5+bp(d3,N,V,spw*.7)*a3*vec3(.7,.4,.9)*1.2+bp(dW,N,V,spw*.6)*vec3(.8,.5,.7)*1.0+bp(dT,N,V,120.)*vec3(1.,.9,.95)*.6;
  vec3 sss=bp(d1,N,V,8.)*a1*vIC*.45+bp(d2,N,V,6.)*a2*vIC*.30+bp(dW,N,V,5.)*vIC*.20;
  vec3 Nr=normalize(N+vec3(.12,-.08,.15));
  vec3 glow=vIC*1.5;
  vec3 scat=bp(d1,Nr,V,40.)*a1*mix(vIC,vec3(.8,.5,.9),.4)*.55+bp(dW,Nr,V,28.)*glow*.35;
  float caus=sin(vWP.x*6.+uTime*.8)*sin(vWP.y*5.5+uTime*.6)*sin(vWP.z*4.5+uTime*.5);
  caus=caus*.5+.5;vec3 causC=glow*caus*fr*.15;
  float nz=vn(vWP.xy*12.+uTime*.3)*.07;
  vec3 rim=mix(vec3(.91,.27,.50),vec3(.78,.31,.94),clamp(dot(N,vec3(1,0,0))*.5+.5,0.,1.));
  vec3 col=vIC*(.12+nz)+diff+sss+scat+spec+rim*fr*.7+causC;
  float alpha=clamp(vOp+fr*.40+(spec.r+spec.g+spec.b)*.04,0.,1.);
  gl_FragColor=vec4(col,alpha);}`;

/* ═══ DUST SHADER (unchanged) ═══ */
const _dustVS = `attribute float aSz;attribute float aPh;attribute vec3 aCol;
varying vec3 vC;varying float vA;uniform float uT;
void main(){
  vC=aCol;
  vec3 p=position;
  float sp=.08+aPh*.04;
  p.x+=sin(uT*sp+aPh*6.28)*1.2;p.y+=cos(uT*sp*.7+aPh*3.14)*.9;p.z+=sin(uT*sp*.5+aPh*4.71)*.6;
  vec4 mv=modelViewMatrix*vec4(p,1.);
  float d=length(mv.xyz);vA=smoothstep(20.,3.,d)*.55;
  gl_PointSize=aSz*(300./d);gl_Position=projectionMatrix*mv;}`;
const _dustFS = `varying vec3 vC;varying float vA;
void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
  float a=smoothstep(.5,.1,d)*vA;gl_FragColor=vec4(vC,a);}`;

/* ═══ SPARKLE SHADER (unchanged) ═══ */
const _sparkVS = `attribute float aSz;attribute float aPh;
varying float vA;uniform float uT;
void main(){
  vec3 p=position;float sp=.06+aPh*.03;
  p.x+=sin(uT*sp+aPh*5.)*1.5;p.y+=cos(uT*sp*.8+aPh*2.5)*1.1;p.z+=sin(uT*sp*.4+aPh*7.)*.7;
  vec4 mv=modelViewMatrix*vec4(p,1.);float d=length(mv.xyz);
  float twinkle=sin(uT*3.+aPh*20.)*.5+.5;
  vA=smoothstep(18.,2.,d)*twinkle*.7;
  gl_PointSize=aSz*(250./d)*(.5+twinkle*.5);gl_Position=projectionMatrix*mv;}`;
const _sparkFS = `varying float vA;
void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
  float a=smoothstep(.5,.0,d)*vA;gl_FragColor=vec4(1.,.95,.9,a);}`;

/* ═══ ICOSPHERE SHADER (unchanged from original) ═══ */
const _icoVS = `varying vec3 vN,vWP;varying float vD,vCurDist;uniform float uT;uniform vec3 uCur;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}vec4 perm(vec4 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy)),x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g,l.zxy),i2=max(g,l.zxy);vec3 x1=x0-i1+C.xxx,x2=x0-i2+C.yyy,x3=x0-D.yyy;i=mod289(i);vec4 p=perm(perm(perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=1./7.;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z),y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy,y=y_*ns.x+ns.xxxx;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy),b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.,s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0));vec3 p0=vec3(b0.xz+b0.yw*sh.xz,h.x+h.y),p1=vec3(b0.wz+b0.yw*sh.yw,h.z+h.w),p2=vec3(b1.xy+b1.zw*sh.xz,h.x+h.y);p0=normalize(p0);p1=normalize(p1);p2=normalize(p2);vec4 norm=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w),vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w)));p0*=norm.x;p1*=norm.y;p2*=norm.z;vec3 p3=vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w)*norm.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
void main(){
  vec3 p=position;
  float n=snoise(p*1.5+uT*.15)*.12+snoise(p*3.+uT*.25)*.06;
  p+=normal*n;
  vec4 wP=modelMatrix*vec4(p,1.);vWP=wP.xyz;vN=normalize(normalMatrix*normal);
  vD=length(wP.xyz);vCurDist=length(wP.xy-uCur.xy);
  gl_Position=projectionMatrix*viewMatrix*wP;}`;
const _icoFS = `varying vec3 vN,vWP;varying float vD,vCurDist;uniform float uT;uniform vec3 uCur;
void main(){
  vec3 N=normalize(vN);float NdV=max(dot(N,normalize(-vWP)),0.);
  float edge=pow(1.-NdV,2.8);
  vec3 pk=vec3(.91,.27,.50),tl=vec3(.16,.96,.83),pu=vec3(.78,.31,.94);
  float band=sin(vWP.y*4.+uT*.6)*.5+.5;
  vec3 baseC=mix(pk,tl,band)*.35;
  float pulse=sin(uT*.8+vD*2.)*.5+.5;
  vec3 glowC=mix(pu,tl,pulse)*edge*.55;
  float curGlow=smoothstep(2.5,.3,vCurDist)*edge*.35;
  vec3 curC=mix(pk,pu,.5)*curGlow;
  vec3 col=baseC+glowC+curC;
  float a=edge*.45+curGlow*.3;
  gl_FragColor=vec4(col,a);}`;

/* ═══ ORBITAL PARTICLES SHADER (NEW — was JS-updated, now GPU) ═══ */
const _orbVS = `attribute float aSz;attribute float aPh;attribute vec3 aVel;
varying float vA;uniform float uT;
void main(){
  vec3 p=position;
  float t=uT;
  /* Orbital motion */
  p.x += sin(t*aVel.x + aPh)*0.3;
  p.y += cos(t*aVel.y + aPh*1.5)*0.3;
  p.z += sin(t*aVel.z + aPh*2.0)*0.2;
  /* Keep within bounds */
  float dist=length(p);
  if(dist>2.2) p *= 2.2/dist;
  vec4 mv=modelViewMatrix*vec4(p,1.);
  float d=length(mv.xyz);
  vA=smoothstep(15.,1.,d)*.6;
  gl_PointSize=aSz*(200./d);
  gl_Position=projectionMatrix*mv;}`;
const _orbFS = `varying float vA;
void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
  float a=smoothstep(.5,.05,d)*vA;gl_FragColor=vec4(.8,.6,.9,a);}`;

/* ═══ CONSTANTS ═══ */
const PKH = 0xe84580, TLH = 0x2af5d4, PUH = 0xc850f0;
const PK = [.91, .27, .50], TL = [.16, .96, .83], PU = [.78, .31, .94];
const COLORS = [
  { b: new THREE.Color(0xe84580), g: new THREE.Color(0xff6699) },
  { b: new THREE.Color(0x2af5d4), g: new THREE.Color(0x55ffee) },
  { b: new THREE.Color(0xc850f0), g: new THREE.Color(0xdd77ff) },
  { b: new THREE.Color(0xd43a6e), g: new THREE.Color(0xf05588) },
  { b: new THREE.Color(0x1ad4b8), g: new THREE.Color(0x44eedd) },
  { b: new THREE.Color(0xb040d8), g: new THREE.Color(0xcc66ee) },
  { b: new THREE.Color(0xe06090), g: new THREE.Color(0xf088aa) },
  { b: new THREE.Color(0x20e0c0), g: new THREE.Color(0x55ffdd) },
];
const WAYPOINTS_BASE = [[-50,-32],[-50,0],[-50,32],[50,-32],[50,0],[50,32],[0,-35],[0,35],[-32,-28],[32,-28],[-32,28],[32,28],[-44,-18],[44,-18],[-44,18],[44,18]];

/* ═══ STATE ═══ */
let _W = 1920, _H = 1080;
let R, S, cam, rayCam;
let ico, icoMat, dM, sM2;
let PL1, PL2, PL3, _iMat;
let _rollingFps = 60, _fc = 0;
const _t0 = performance.now();
let T = 0, _prevT = 0;
const ndc = { x: 0, y: 0 };
const lookT = { sx: 0, sy: 0 };
const icoTarget = { x: 0, y: 0 };
let isMobile = false, isTouchDevice = false, _mTouching = false;
let Q;

/* Cursor tracking */
const mPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const mw = new THREE.Vector3(), mwS = new THREE.Vector3(), mwP = new THREE.Vector3(), mwV = new THREE.Vector3();
const rcst = new THREE.Raycaster();

/* ═══ GRANULE GEOMETRY FACTORY ═══ */
function mkP(sx, sy, sz, irr) {
  const g = new THREE.SphereGeometry(1, Q.granuleDetail[0], Q.granuleDetail[1]);
  const pos = g.attributes.position; const sd = Math.random() * 100;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    x *= sx; y *= sy; z *= sz;
    if (irr > 0) {
      const a = Math.atan2(z, x), bump = Math.sin(a * 5 + sd) * Math.cos(y * 4 + sd * .7) * irr;
      const len = Math.sqrt(x * x + z * z);
      if (len > .01) { x += (x / len) * bump; z += (z / len) * bump; }
    }
    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

/* ═══ MAIN INIT ═══ */
function init(canvas, deviceInfo) {
  _W = deviceInfo.w; _H = deviceInfo.h;
  _dpr = deviceInfo.dpr || 2;
  isMobile = deviceInfo.isMobile;
  isTouchDevice = deviceInfo.isTouchDevice;
  _isLaptop = deviceInfo.isLaptop || false;
  const _slowNet = deviceInfo.slowNet;

  R = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'default' });
  const GPU_INFO = detectGPU(R.getContext());
  Q = buildQ(GPU_INFO.tier, isMobile, _slowNet);
  _adprDPR = Math.min(deviceInfo.dpr || 2, Q.maxDPR);
  R.setPixelRatio(_adprDPR);
  R.setSize(_W, _H, false);
  R.setClearColor(0x040710, 1);
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = .9;
  R.outputColorSpace = THREE.SRGBColorSpace;
  /* SINGLE SCENE — one render pass */
  R.autoClear = true;

  /* ── Scene + Camera ── */
  S = new THREE.Scene();
  S.fog = new THREE.FogExp2(0x040810, Q.fogDensity);
  cam = new THREE.PerspectiveCamera(isMobile ? 65 : 55, _W / _H, .1, 500);
  cam.position.set(0, 0, isMobile ? 14 : 12);
  rayCam = new THREE.PerspectiveCamera(isMobile ? 60 : 50, _W / _H, .1, 400);
  rayCam.position.set(0, 0, 15);

  /* ── Lights (all in one scene now) ── */
  S.add(new THREE.AmbientLight(0x080616, 2.5));
  const dirLights = [
    { c: 0xe84580, i: 1.2, p: [-5, 8, 10] },
    { c: 0x2af5d4, i: .8, p: [8, -3, 12] },
    { c: 0xc850f0, i: .6, p: [-3, -6, 8] },
  ];
  dirLights.forEach(d => { const l = new THREE.DirectionalLight(d.c, d.i); l.position.set(...d.p); S.add(l); });

  PL1 = new THREE.PointLight(0xe84580, 5, 45); PL1.position.set(0, 0, 13); S.add(PL1);
  PL2 = new THREE.PointLight(0x2af5d4, 3, 35); PL2.position.set(3, 3, 11); S.add(PL2);
  PL3 = new THREE.PointLight(0xc850f0, 2.2, 30); PL3.position.set(-3, -2, 12); S.add(PL3);

  /* ══════════════════════════════════════════ */
  /* ══ BACKGROUND: dust, sparkle, icosphere ══ */
  /* ══════════════════════════════════════════ */

  /* Dust */
  const DC = Q.dustCount;
  const dG = new THREE.BufferGeometry();
  const dP = new Float32Array(DC * 3), dC = new Float32Array(DC * 3), dSzA = new Float32Array(DC), dPhA = new Float32Array(DC);
  for (let i = 0; i < DC; i++) {
    const i3 = i * 3, r = Math.pow(Math.random(), .5) * 20, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
    dP[i3] = r * Math.sin(p) * Math.cos(t); dP[i3 + 1] = r * Math.sin(p) * Math.sin(t); dP[i3 + 2] = r * Math.cos(p);
    const c = Math.random();
    if (c < .06) { dC[i3] = PK[0]; dC[i3 + 1] = PK[1]; dC[i3 + 2] = PK[2]; }
    else if (c < .1) { dC[i3] = TL[0]; dC[i3 + 1] = TL[1]; dC[i3 + 2] = TL[2]; }
    else if (c < .14) { dC[i3] = PU[0]; dC[i3 + 1] = PU[1]; dC[i3 + 2] = PU[2]; }
    else { const b = .3 + Math.random() * .4; dC[i3] = b; dC[i3 + 1] = b * .98; dC[i3 + 2] = b * .92; }
    dSzA[i] = .5 + Math.random() * 2.5; dPhA[i] = Math.random();
  }
  dG.setAttribute('position', new THREE.BufferAttribute(dP, 3));
  dG.setAttribute('aCol', new THREE.BufferAttribute(dC, 3));
  dG.setAttribute('aSz', new THREE.BufferAttribute(dSzA, 1));
  dG.setAttribute('aPh', new THREE.BufferAttribute(dPhA, 1));
  dM = new THREE.ShaderMaterial({ vertexShader: _dustVS, fragmentShader: _dustFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });
  S.add(new THREE.Points(dG, dM));

  /* Sparkle */
  const SC = Q.sparkleCount;
  const sG = new THREE.BufferGeometry();
  const sP = new Float32Array(SC * 3), sSz = new Float32Array(SC), sPh = new Float32Array(SC);
  for (let i = 0; i < SC; i++) {
    const i3 = i * 3, r = Math.pow(Math.random(), .4) * 18, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
    sP[i3] = r * Math.sin(p) * Math.cos(t); sP[i3 + 1] = r * Math.sin(p) * Math.sin(t); sP[i3 + 2] = r * Math.cos(p);
    sSz[i] = .3 + Math.random() * 1.5; sPh[i] = Math.random();
  }
  sG.setAttribute('position', new THREE.BufferAttribute(sP, 3));
  sG.setAttribute('aSz', new THREE.BufferAttribute(sSz, 1));
  sG.setAttribute('aPh', new THREE.BufferAttribute(sPh, 1));
  sM2 = new THREE.ShaderMaterial({ vertexShader: _sparkVS, fragmentShader: _sparkFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });
  S.add(new THREE.Points(sG, sM2));

  /* Icosphere */
  icoMat = new THREE.ShaderMaterial({
    vertexShader: _icoVS, fragmentShader: _icoFS, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: { uT: { value: 0 }, uCur: { value: new THREE.Vector3() } }
  });
  ico = new THREE.Mesh(new THREE.SphereGeometry(1.8, Q.sphereDetail[0], Q.sphereDetail[1]), icoMat);
  S.add(ico);

  /* Orbital particles (NOW shader-animated) */
  const OC = 120;
  const oG = new THREE.BufferGeometry();
  const oP = new Float32Array(OC * 3), oSz = new Float32Array(OC), oPh = new Float32Array(OC), oVel = new Float32Array(OC * 3);
  for (let i = 0; i < OC; i++) {
    const i3 = i * 3, r = 1.6 + Math.random() * .5, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
    oP[i3] = r * Math.sin(p) * Math.cos(t); oP[i3 + 1] = r * Math.sin(p) * Math.sin(t); oP[i3 + 2] = r * Math.cos(p);
    oSz[i] = .8 + Math.random() * 2; oPh[i] = Math.random() * 6.28;
    oVel[i3] = .3 + Math.random() * .4; oVel[i3 + 1] = .2 + Math.random() * .3; oVel[i3 + 2] = .15 + Math.random() * .25;
  }
  oG.setAttribute('position', new THREE.BufferAttribute(oP, 3));
  oG.setAttribute('aSz', new THREE.BufferAttribute(oSz, 1));
  oG.setAttribute('aPh', new THREE.BufferAttribute(oPh, 1));
  oG.setAttribute('aVel', new THREE.BufferAttribute(oVel, 3));
  const orbMat = new THREE.ShaderMaterial({ vertexShader: _orbVS, fragmentShader: _orbFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });
  const orbPoints = new THREE.Points(oG, orbMat);
  S.add(orbPoints);

  /* ══════════════════════════════════════════ */
  /* ══ GRANULES: GPU-DRIVEN InstancedMesh   ══ */
  /* ══════════════════════════════════════════ */

  const _wpScale = Math.max(_W / 1920, _H / 1080);
  const WAYPOINTS = WAYPOINTS_BASE.map(p => [p[0] * _wpScale, p[1] * _wpScale]);

  const GEOS = [mkP(1, .55, .92, .015), mkP(.9, .52, .88, .02), mkP(1.08, .58, .98, .012), mkP(.95, .54, .9, .018), mkP(.85, .5, .84, .022), mkP(1.02, .56, .94, .016), mkP(.88, .53, .87, .025)];
  const GN = GEOS.length;
  const COUNT = Q.granuleCount;
  const _gSpX = isMobile ? 60 : 110 * _wpScale, _gSpY = isMobile ? 44 : 70 * _wpScale;
  const cols = Math.ceil(Math.sqrt(COUNT * 2.2)), rows = Math.ceil(COUNT / cols);

  /* Group granules by geometry type for instancing */
  const groups = Array.from({ length: GN }, () => ({ basePosArr: [], phaseArr: [], fSpdArr: [], fAmpArr: [], rotSpdArr: [], scaleArr: [], colArr: [], opArr: [], roughArr: [] }));

  for (let i = 0; i < COUNT; i++) {
    const geoIdx = i % GN;
    const cs = COLORS[Math.floor(Math.random() * COLORS.length)];
    const px = (i % cols / (cols - 1) - .5) * _gSpX + (Math.random() - .5) * 6;
    const py = (Math.floor(i / cols) / (rows - 1) - .5) * _gSpY + (Math.random() - .5) * 5;
    const pz = (Math.random() - .5) * 12;
    const sc = isMobile ? (.12 + Math.random() * .22) : (.14 + Math.random() * .28);
    const seed = Math.random();
    const gr = groups[geoIdx];
    gr.basePosArr.push(px, py, pz);
    gr.phaseArr.push(Math.random() * 6.28);
    gr.fSpdArr.push(.003 + Math.random() * .005);
    gr.fAmpArr.push(.02 + Math.random() * .03);
    gr.rotSpdArr.push((.00003 + Math.random() * .00005) * (Math.random() > .5 ? 1 : -1));
    gr.scaleArr.push(sc);
    gr.colArr.push(cs.b.r, cs.b.g, cs.b.b);
    gr.opArr.push(.18 + seed * .20);
    gr.roughArr.push(.3 + Math.random() * .5);
  }

  /* Create granule material (GPU-driven) */
  _iMat = new THREE.ShaderMaterial({
    vertexShader: _iVS, fragmentShader: _iFS, transparent: true, side: THREE.FrontSide, depthWrite: false,
    uniforms: {
      uPL1: { value: PL1.position }, uPL2: { value: PL2.position }, uPL3: { value: PL3.position },
      uTime: { value: 0 }, uCursor: { value: new THREE.Vector2(0, 0) }
    }
  });

  /* Build InstancedMeshes with GPU-driven attributes */
  for (let g = 0; g < GN; g++) {
    const gr = groups[g];
    const cnt = gr.phaseArr.length; if (!cnt) continue;
    const im = new THREE.InstancedMesh(GEOS[g], _iMat, cnt);

    /* Per-instance attributes (set ONCE, never updated) */
    const geo = im.geometry;
    geo.setAttribute('aBasePos', new THREE.InstancedBufferAttribute(new Float32Array(gr.basePosArr), 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(gr.phaseArr), 1));
    geo.setAttribute('aFSpd', new THREE.InstancedBufferAttribute(new Float32Array(gr.fSpdArr), 1));
    geo.setAttribute('aFAmp', new THREE.InstancedBufferAttribute(new Float32Array(gr.fAmpArr), 1));
    geo.setAttribute('aRotSpd', new THREE.InstancedBufferAttribute(new Float32Array(gr.rotSpdArr), 1));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(new Float32Array(gr.scaleArr), 1));
    geo.setAttribute('aOp', new THREE.InstancedBufferAttribute(new Float32Array(gr.opArr), 1));
    geo.setAttribute('aRough', new THREE.InstancedBufferAttribute(new Float32Array(gr.roughArr), 1));

    /* Instance colors */
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(gr.colArr), 3);

    /* Identity matrices (positions computed in shader, not via instanceMatrix) */
    const dm = new THREE.Object3D();
    for (let j = 0; j < cnt; j++) {
      dm.position.set(0, 0, 0);
      dm.quaternion.identity();
      dm.scale.setScalar(1);
      dm.updateMatrix();
      im.setMatrixAt(j, dm.matrix);
    }
    im.instanceMatrix.needsUpdate = true; /* once */
    im.frustumCulled = false;
    S.add(im);
  }

  /* ═══ START RENDER LOOP ═══ */
  loop();
}

/* ═══ RENDER LOOP — MINIMAL JS, GPU DOES THE WORK ═══ */
let _paused = false;
function loop() {
  requestAnimationFrame(loop);
  if (_paused) return; /* v2: пауза когда canvas не виден или вкладка в фоне */
  _fc++; T = (performance.now() - _t0) * .001;
  const _dt = T - _prevT; _prevT = T;
  if (_dt > 0) _rollingFps += ((1 / _dt) - _rollingFps) * .05;
  adaptDPR(R, performance.now());

  /* Touch device: sine drift when not touching */
  if (isTouchDevice && !_mTouching) {
    ndc.x = Math.sin(T * .3) * .35 + Math.sin(T * .17) * .15;
    ndc.y = Math.cos(T * .25) * .25 + Math.cos(T * .13) * .1;
  }

  /* Cursor → world coords */
  rayCam.updateMatrixWorld(true);
  rcst.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), rayCam);
  rcst.ray.intersectPlane(mPlane, mw);
  mwV.subVectors(mw, mwP); mwP.copy(mw);
  const _mSmooth = isTouchDevice ? .12 : .035;
  mwS.x += (mw.x - mwS.x) * _mSmooth; mwS.y += (mw.y - mwS.y) * _mSmooth;

  /* ── Update uniforms (THIS IS ALL THE JS DOES PER FRAME) ── */
  dM.uniforms.uT.value = T;
  sM2.uniforms.uT.value = T;
  icoMat.uniforms.uT.value = T;
  icoMat.uniforms.uCur.value.set(ndc.x * 1.0, ndc.y * 1.0, 0);
  _iMat.uniforms.uTime.value = T;
  _iMat.uniforms.uCursor.value.set(mwS.x, mwS.y);

  /* ── Camera follow cursor ── */
  lookT.sx += (ndc.x * .15 - lookT.sx) * .012; lookT.sy += (ndc.y * .08 - lookT.sy) * .012;
  cam.lookAt(lookT.sx, lookT.sy, 0);

  /* ── Icosphere gentle movement ── */
  if (!isMobile) { icoTarget.x += (ndc.x * .12 - icoTarget.x) * .008; icoTarget.y += (ndc.y * .08 - icoTarget.y) * .008; }
  else { icoTarget.x += (0 - icoTarget.x) * .01; icoTarget.y += (0 - icoTarget.y) * .01; }
  ico.position.x = icoTarget.x; ico.position.y = icoTarget.y;
  ico.rotation.y = T * .05 + ndc.x * .18; ico.rotation.x = T * .04 + ndc.y * .14;
  ico.scale.setScalar(1 + Math.sin(T * .35) * .045 + Math.sin(T * .12) * .02);

  /* ── Point lights follow cursor (smooth) ── */
  PL1.position.x += (mw.x * .85 - PL1.position.x) * .06; PL1.position.y += (mw.y * .85 - PL1.position.y) * .06;
  PL2.position.x += (mw.x * .55 - PL2.position.x) * .035; PL2.position.y += (mw.y * .55 - PL2.position.y) * .035;
  PL3.position.x += (mw.x * .4 + 3 - PL3.position.x) * .025; PL3.position.y += (mw.y * .4 - 2 - PL3.position.y) * .025;

  /* ── SINGLE RENDER PASS ── */
  R.render(S, cam);
}

/* ═══ WORKER MESSAGE HANDLER ═══ */
if (IS_WORKER) {
  self.onmessage = function(e) {
    const d = e.data;
    if (d.type === 'init') {
      _isLaptop = d.deviceInfo.isLaptop || false;
      init(d.canvas, d.deviceInfo);
      self.postMessage({ type: 'alive' });
    } else if (d.type === 'mouse') { ndc.x = d.x; ndc.y = d.y; }
    else if (d.type === 'touch') {
      if (d.touching) { _mTouching = true; ndc.x = d.x; ndc.y = d.y; }
      else { _mTouching = false; }
    }
    else if (d.type === 'resize') {
      _W = d.w; _H = d.h;
      cam.aspect = _W / _H; cam.updateProjectionMatrix();
      rayCam.aspect = _W / _H; rayCam.updateProjectionMatrix();
      R.setSize(_W, _H, false);
    }
    else if (d.type === 'pause') { _paused = true; }
    else if (d.type === 'resume') { _paused = false; _prevT = (performance.now() - _t0) * .001; }
  };
}

