(function () {
  'use strict';

  if (window._gklLoaderStarted) return;
  window._gklLoaderStarted = true;

  var THREE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
  var WORKER_URL = 'https://plastformula.store/gkl-worker.js';
  var SCENE_URL = 'https://plastformula.store/gkl-scene.js';

  window._W3D = false;
  window._GKL_W = null;

  var orig = document.getElementById('bgC');
  if (!orig) {
    console.warn('[gkl-loader] bgC canvas not found');
    return;
  }

  var m = matchMedia('(pointer:coarse)').matches;
  var mob = ('ontouchstart' in window) && m && Math.min(screen.width, screen.height) < 768;
  var td = ('ontouchstart' in window) && !(matchMedia('(pointer:fine)').matches);
  var cn = navigator.connection || navigator.mozConnection;
  var slow = cn && (cn.effectiveType === '2g' || cn.effectiveType === 'slow-2g' || cn.saveData);
  var reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

  if (reduceMotion) {
    console.log('[gkl-loader] prefers-reduced-motion=reduce — 3D disabled');
    return;
  }

  var workerAlive = false;
  var w = null;
  var wc = null;

  /* v4: CorsWorker паттерн — скачиваем воркер через fetch (CORS *),
   * оборачиваем в Blob, Worker создаётся как same-origin blob:
   * Внутри воркера НЕТ cross-origin запросов — весь код локальный. */
  var INLINE_WORKER_CODE = "/* gkl-worker.js \u2014 Web Worker \u0434\u043b\u044f GPU-driven 3D \u0440\u0435\u043d\u0434\u0435\u0440\u0430\n * \u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a: plastformula.com / bitrix24\n * Grabs: importScripts(Three.js UMD) \u2192 init OffscreenCanvas \u2192 render loop\n * \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044f \u0433\u043b\u0430\u0432\u043d\u044b\u043c \u043f\u043e\u0442\u043e\u043a\u043e\u043c \u0447\u0435\u0440\u0435\u0437 new Worker('https://plastformula.store/gkl-worker.js')\n * v1.0.0 \u2014 2026-04-16\n */\n\n/* gkl-3d-worker-v2.js \u2014 GPU-driven 3D renderer\n * ALL granule movement computed in vertex shader (GPU).\n * JS sends only 3 values per frame: uTime, uCursorX, uCursorY.\n * Single scene, single render pass, DPR 1.5 max.\n *\n * BITRIX24: lives inside <script type=\"text/js-worker\"> in HTML block.\n * Main thread reads textContent \u2192 Blob \u2192 new Worker(blobURL).\n * Three.js loaded via importScripts (UMD build).\n */\n\nvar IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;\nif (IS_WORKER) importScripts('https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js');\n\n/* \u2550\u2550\u2550 GPU DETECTION \u2550\u2550\u2550 */\nlet _dpr = 2;\nlet _isLaptop = false;\n\nfunction detectGPU(gl) {\n  if (!gl) return { tier: 0, renderer: 'none', maxTex: 0 };\n  const dbg = gl.getExtension('WEBGL_debug_renderer_info');\n  const rnd = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';\n  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);\n  let tier = 2;\n  const r = rnd.toLowerCase();\n  if (/powervr|mali-[4t]|adreno\\s*[23]\\d{2}|intel.*(hd\\s*[2-5]|uhd\\s*[56][0-2])|swiftshader|llvmpipe|software/i.test(r)) tier = 1;\n  if (/nvidia|geforce|radeon|rx\\s*[5-9]|adreno\\s*[7-9]\\d{2}|mali-g[7-9]\\d{2}|apple\\s*(m[1-9]|a1[5-9]|gpu)|intel.*arc|xe/i.test(r)) tier = 3;\n  if (maxTex < 4096) tier = Math.min(tier, 1);\n  if (maxTex >= 16384 && tier < 3) tier = Math.min(tier + 1, 3);\n  gl.getExtension('WEBGL_lose_context')?.loseContext();\n  return { tier, renderer: rnd, maxTex };\n}\n\n/* \u2550\u2550\u2550 QUALITY SETTINGS \u2550\u2550\u2550 */\nfunction buildQ(gpuTier, isMobile, _slowNet) {\n  const W = _W, H = _H;\n  const _PX_BUDGET = isMobile ? 2.5e6 : 4e6;\n  const _budgetDPR = Math.sqrt(_PX_BUDGET / (W * H));\n  return {\n    /* v2: budget severely cut for integrated GPU relief */\n    maxDPR: isMobile ? Math.min(_dpr || 2, 1.25, _budgetDPR) : Math.min(_dpr || 2, gpuTier >= 3 ? 1.25 : gpuTier >= 2 ? 1.25 : 1.0, _budgetDPR),\n    minDPR: .75,\n    dustCount: _slowNet ? 400 : isMobile ? (gpuTier >= 3 ? 1500 : gpuTier >= 2 ? 1000 : 400) : gpuTier >= 3 ? 3000 : gpuTier >= 2 ? 2000 : 700,\n    sparkleCount: _slowNet ? 80 : isMobile ? (gpuTier >= 3 ? 400 : gpuTier >= 2 ? 200 : 80) : gpuTier >= 3 ? 700 : gpuTier >= 2 ? 400 : 150,\n    granuleCount: _slowNet ? 20 : isMobile ? (gpuTier >= 3 ? 80 : gpuTier >= 2 ? 50 : 20) : gpuTier >= 3 ? 250 : gpuTier >= 2 ? 140 : 35,\n    sphereDetail: isMobile ? (gpuTier >= 3 ? [64, 32] : gpuTier >= 2 ? [48, 24] : [32, 16]) : gpuTier >= 3 ? [80, 40] : gpuTier >= 2 ? [64, 32] : [48, 24],\n    granuleDetail: isMobile ? (gpuTier >= 3 ? [32, 24] : gpuTier >= 2 ? [24, 16] : [16, 12]) : gpuTier >= 3 ? [32, 24] : gpuTier >= 2 ? [24, 18] : [18, 14],\n    antialias: false,\n    fogDensity: gpuTier >= 2 ? .028 : .04,\n  };\n}\n\n/* \u2550\u2550\u2550 ADAPTIVE DPR \u2550\u2550\u2550 */\nlet _adprDPR = 1.5;\nconst _PERF = { times: [], maxSamples: 90, cooldown: 3000, lastAdj: 0, targetHi: 55, targetLo: 30, stepDn: .2, stepUp: .1 };\nfunction adaptDPR(renderer, now) {\n  _PERF.times.push(now);\n  if (_PERF.times.length > _PERF.maxSamples) _PERF.times.shift();\n  if (_PERF.times.length < 30 || now - _PERF.lastAdj < _PERF.cooldown) return;\n  const fps = (_PERF.times.length - 1) / ((_PERF.times[_PERF.times.length - 1] - _PERF.times[0]) / 1000);\n  if (fps < _PERF.targetLo && _adprDPR > Q.minDPR) {\n    _adprDPR = Math.max(Q.minDPR, _adprDPR - _PERF.stepDn);\n    renderer.setPixelRatio(_adprDPR); renderer.setSize(_W, _H, false);\n    _PERF.times = []; _PERF.lastAdj = now;\n  } else if (fps > _PERF.targetHi && _adprDPR < Q.maxDPR) {\n    _adprDPR = Math.min(Q.maxDPR, _adprDPR + _PERF.stepUp);\n    renderer.setPixelRatio(_adprDPR); renderer.setSize(_W, _H, false);\n    _PERF.times = []; _PERF.lastAdj = now;\n  }\n}\n\n/* \u2550\u2550\u2550 GRANULE SHADERS (GPU-DRIVEN) \u2550\u2550\u2550 */\n\n/* NEW vertex shader: all movement in GPU */\nconst _iVS = `\nattribute float aOp;\nattribute float aRough;\nattribute vec3 aBasePos;\nattribute float aPhase;\nattribute float aFSpd;\nattribute float aFAmp;\nattribute float aRotSpd;\nattribute float aScale;\n\nuniform float uTime;\nuniform vec2 uCursor;\n\nvarying vec3 vN, vV, vWP, vIC;\nvarying float vOp, vRough;\n\nmat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }\nmat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }\nmat3 rotZ(float a){ float c=cos(a),s=sin(a); return mat3(c,s,0, -s,c,0, 0,0,1); }\n\nvoid main(){\n  vOp = aOp;\n  vRough = aRough;\n  #ifdef USE_INSTANCING_COLOR\n    vIC = instanceColor;\n  #else\n    vIC = vec3(.9, .3, .5);\n  #endif\n\n  /* \u2500\u2500 Wander: organic floating motion via sin/cos \u2500\u2500 */\n  float t = uTime;\n  float ph = aPhase;\n  float spd = aFSpd;\n  float amp = aFAmp;\n  \n  vec3 wander;\n  wander.x = sin(t * spd + ph) * amp * 800.0\n           + sin(t * spd * 0.37 + ph * 2.7) * amp * 200.0;\n  wander.y = cos(t * spd * 0.72 + ph * 1.33) * amp * 600.0\n           + cos(t * spd * 0.28 + ph * 3.1) * amp * 150.0;\n  wander.z = sin(t * spd * 0.55 + ph * 2.1) * amp * 200.0;\n\n  vec3 worldPos = aBasePos + wander;\n\n  /* \u2500\u2500 Cursor repulsion \u2500\u2500 */\n  vec2 delta = worldPos.xy - uCursor;\n  float dist = length(delta);\n  float pushR = 5.0;\n  if(dist < pushR && dist > 0.01) {\n    float t01 = 1.0 - dist / pushR;\n    /* Smoothstep-like curve */\n    float sm = t01 * t01 * t01 * (t01 * (t01 * 6.0 - 15.0) + 10.0);\n    float pushStr = sm * 2.5;\n    worldPos.xy += normalize(delta) * pushStr;\n  }\n\n  /* \u2500\u2500 Rotation \u2500\u2500 */\n  float angle = t * aRotSpd;\n  mat3 rot = rotY(angle) * rotX(angle * 0.8 + sin(t * spd * 0.3 + ph) * 0.15);\n\n  /* \u2500\u2500 Transform \u2500\u2500 */\n  vec3 localPos = rot * (position * aScale);\n  vec4 wP = modelMatrix * vec4(localPos + worldPos, 1.0);\n  vWP = wP.xyz;\n  \n  /* Normal transform with rotation */\n  mat3 nM = mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * rot;\n  vN = normalize(nM * normal);\n  vV = normalize(cameraPosition - wP.xyz);\n  \n  gl_Position = projectionMatrix * viewMatrix * wP;\n}`;\n\n/* Fragment shader: UNCHANGED from original (same lighting, SSS, caustics) */\nconst _iFS = `varying vec3 vN,vV,vWP,vIC;varying float vOp,vRough;\nuniform vec3 uPL1,uPL2,uPL3;\nuniform float uTime;\nfloat bp(vec3 L,vec3 N,vec3 V,float pw){return pow(max(dot(normalize(L+V),N),0.),pw);}\nfloat lm(vec3 L,vec3 N){return max(dot(normalize(L),N),0.);}\nfloat hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);\n  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}\nvoid main(){\n  vec3 N=normalize(vN),V=normalize(vV);\n  float NdV=max(dot(N,V),0.);\n  float fr=pow(1.-NdV,3.5)*.75;\n  vec3 d1=uPL1-vWP;float a1=1./(1.+dot(d1,d1)*.012);d1=normalize(d1);\n  vec3 d2=uPL2-vWP;float a2=1./(1.+dot(d2,d2)*.018);d2=normalize(d2);\n  vec3 d3=uPL3-vWP;float a3=1./(1.+dot(d3,d3)*.022);d3=normalize(d3);\n  vec3 dW=normalize(uPL1-vWP);vec3 dO=normalize(uPL2-vWP);\n  vec3 dT=normalize(vec3(0.,20.,10.)-vWP);\n  vec3 diff=lm(d1,N)*a1*vec3(.91,.27,.50)*.35+lm(d2,N)*a2*vec3(.16,.96,.83)*.28+lm(d3,N)*a3*vec3(.78,.31,.94)*.24+lm(dW,N)*vec3(.85,.40,.70)*.20+lm(dO,N)*vec3(.16,.82,.65)*.16+lm(dT,N)*vec3(.85,.92,1.)*.14;\n  float spw=200.+vRough*300.;\n  vec3 spec=bp(d1,N,V,spw)*a1*vec3(.9,.5,.7)*2.4+bp(d2,N,V,spw*.8)*a2*vec3(.4,.9,.8)*1.5+bp(d3,N,V,spw*.7)*a3*vec3(.7,.4,.9)*1.2+bp(dW,N,V,spw*.6)*vec3(.8,.5,.7)*1.0+bp(dT,N,V,120.)*vec3(1.,.9,.95)*.6;\n  vec3 sss=bp(d1,N,V,8.)*a1*vIC*.45+bp(d2,N,V,6.)*a2*vIC*.30+bp(dW,N,V,5.)*vIC*.20;\n  vec3 Nr=normalize(N+vec3(.12,-.08,.15));\n  vec3 glow=vIC*1.5;\n  vec3 scat=bp(d1,Nr,V,40.)*a1*mix(vIC,vec3(.8,.5,.9),.4)*.55+bp(dW,Nr,V,28.)*glow*.35;\n  float caus=sin(vWP.x*6.+uTime*.8)*sin(vWP.y*5.5+uTime*.6)*sin(vWP.z*4.5+uTime*.5);\n  caus=caus*.5+.5;vec3 causC=glow*caus*fr*.15;\n  float nz=vn(vWP.xy*12.+uTime*.3)*.07;\n  vec3 rim=mix(vec3(.91,.27,.50),vec3(.78,.31,.94),clamp(dot(N,vec3(1,0,0))*.5+.5,0.,1.));\n  vec3 col=vIC*(.12+nz)+diff+sss+scat+spec+rim*fr*.7+causC;\n  float alpha=clamp(vOp+fr*.40+(spec.r+spec.g+spec.b)*.04,0.,1.);\n  gl_FragColor=vec4(col,alpha);}`;\n\n/* \u2550\u2550\u2550 DUST SHADER (unchanged) \u2550\u2550\u2550 */\nconst _dustVS = `attribute float aSz;attribute float aPh;attribute vec3 aCol;\nvarying vec3 vC;varying float vA;uniform float uT;\nvoid main(){\n  vC=aCol;\n  vec3 p=position;\n  float sp=.08+aPh*.04;\n  p.x+=sin(uT*sp+aPh*6.28)*1.2;p.y+=cos(uT*sp*.7+aPh*3.14)*.9;p.z+=sin(uT*sp*.5+aPh*4.71)*.6;\n  vec4 mv=modelViewMatrix*vec4(p,1.);\n  float d=length(mv.xyz);vA=smoothstep(20.,3.,d)*.55;\n  gl_PointSize=aSz*(300./d);gl_Position=projectionMatrix*mv;}`;\nconst _dustFS = `varying vec3 vC;varying float vA;\nvoid main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;\n  float a=smoothstep(.5,.1,d)*vA;gl_FragColor=vec4(vC,a);}`;\n\n/* \u2550\u2550\u2550 SPARKLE SHADER (unchanged) \u2550\u2550\u2550 */\nconst _sparkVS = `attribute float aSz;attribute float aPh;\nvarying float vA;uniform float uT;\nvoid main(){\n  vec3 p=position;float sp=.06+aPh*.03;\n  p.x+=sin(uT*sp+aPh*5.)*1.5;p.y+=cos(uT*sp*.8+aPh*2.5)*1.1;p.z+=sin(uT*sp*.4+aPh*7.)*.7;\n  vec4 mv=modelViewMatrix*vec4(p,1.);float d=length(mv.xyz);\n  float twinkle=sin(uT*3.+aPh*20.)*.5+.5;\n  vA=smoothstep(18.,2.,d)*twinkle*.7;\n  gl_PointSize=aSz*(250./d)*(.5+twinkle*.5);gl_Position=projectionMatrix*mv;}`;\nconst _sparkFS = `varying float vA;\nvoid main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;\n  float a=smoothstep(.5,.0,d)*vA;gl_FragColor=vec4(1.,.95,.9,a);}`;\n\n/* \u2550\u2550\u2550 ICOSPHERE SHADER (unchanged from original) \u2550\u2550\u2550 */\nconst _icoVS = `varying vec3 vN,vWP;varying float vD,vCurDist;uniform float uT;uniform vec3 uCur;\nvec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}vec4 perm(vec4 x){return mod289(((x*34.)+1.)*x);}\nfloat snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy)),x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g,l.zxy),i2=max(g,l.zxy);vec3 x1=x0-i1+C.xxx,x2=x0-i2+C.yyy,x3=x0-D.yyy;i=mod289(i);vec4 p=perm(perm(perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=1./7.;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z),y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy,y=y_*ns.x+ns.xxxx;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy),b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.,s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0));vec3 p0=vec3(b0.xz+b0.yw*sh.xz,h.x+h.y),p1=vec3(b0.wz+b0.yw*sh.yw,h.z+h.w),p2=vec3(b1.xy+b1.zw*sh.xz,h.x+h.y);p0=normalize(p0);p1=normalize(p1);p2=normalize(p2);vec4 norm=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w),vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w)));p0*=norm.x;p1*=norm.y;p2*=norm.z;vec3 p3=vec3(b1.zw+vec2(s1.z,s1.w)*sh.zw,h.w)*norm.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}\nvoid main(){\n  vec3 p=position;\n  float n=snoise(p*1.5+uT*.15)*.12+snoise(p*3.+uT*.25)*.06;\n  p+=normal*n;\n  vec4 wP=modelMatrix*vec4(p,1.);vWP=wP.xyz;vN=normalize(normalMatrix*normal);\n  vD=length(wP.xyz);vCurDist=length(wP.xy-uCur.xy);\n  gl_Position=projectionMatrix*viewMatrix*wP;}`;\nconst _icoFS = `varying vec3 vN,vWP;varying float vD,vCurDist;uniform float uT;uniform vec3 uCur;\nvoid main(){\n  vec3 N=normalize(vN);float NdV=max(dot(N,normalize(-vWP)),0.);\n  float edge=pow(1.-NdV,2.8);\n  vec3 pk=vec3(.91,.27,.50),tl=vec3(.16,.96,.83),pu=vec3(.78,.31,.94);\n  float band=sin(vWP.y*4.+uT*.6)*.5+.5;\n  vec3 baseC=mix(pk,tl,band)*.35;\n  float pulse=sin(uT*.8+vD*2.)*.5+.5;\n  vec3 glowC=mix(pu,tl,pulse)*edge*.55;\n  float curGlow=smoothstep(2.5,.3,vCurDist)*edge*.35;\n  vec3 curC=mix(pk,pu,.5)*curGlow;\n  vec3 col=baseC+glowC+curC;\n  float a=edge*.45+curGlow*.3;\n  gl_FragColor=vec4(col,a);}`;\n\n/* \u2550\u2550\u2550 ORBITAL PARTICLES SHADER (NEW \u2014 was JS-updated, now GPU) \u2550\u2550\u2550 */\nconst _orbVS = `attribute float aSz;attribute float aPh;attribute vec3 aVel;\nvarying float vA;uniform float uT;\nvoid main(){\n  vec3 p=position;\n  float t=uT;\n  /* Orbital motion */\n  p.x += sin(t*aVel.x + aPh)*0.3;\n  p.y += cos(t*aVel.y + aPh*1.5)*0.3;\n  p.z += sin(t*aVel.z + aPh*2.0)*0.2;\n  /* Keep within bounds */\n  float dist=length(p);\n  if(dist>2.2) p *= 2.2/dist;\n  vec4 mv=modelViewMatrix*vec4(p,1.);\n  float d=length(mv.xyz);\n  vA=smoothstep(15.,1.,d)*.6;\n  gl_PointSize=aSz*(200./d);\n  gl_Position=projectionMatrix*mv;}`;\nconst _orbFS = `varying float vA;\nvoid main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;\n  float a=smoothstep(.5,.05,d)*vA;gl_FragColor=vec4(.8,.6,.9,a);}`;\n\n/* \u2550\u2550\u2550 CONSTANTS \u2550\u2550\u2550 */\nconst PKH = 0xe84580, TLH = 0x2af5d4, PUH = 0xc850f0;\nconst PK = [.91, .27, .50], TL = [.16, .96, .83], PU = [.78, .31, .94];\nconst COLORS = [\n  { b: new THREE.Color(0xe84580), g: new THREE.Color(0xff6699) },\n  { b: new THREE.Color(0x2af5d4), g: new THREE.Color(0x55ffee) },\n  { b: new THREE.Color(0xc850f0), g: new THREE.Color(0xdd77ff) },\n  { b: new THREE.Color(0xd43a6e), g: new THREE.Color(0xf05588) },\n  { b: new THREE.Color(0x1ad4b8), g: new THREE.Color(0x44eedd) },\n  { b: new THREE.Color(0xb040d8), g: new THREE.Color(0xcc66ee) },\n  { b: new THREE.Color(0xe06090), g: new THREE.Color(0xf088aa) },\n  { b: new THREE.Color(0x20e0c0), g: new THREE.Color(0x55ffdd) },\n];\nconst WAYPOINTS_BASE = [[-50,-32],[-50,0],[-50,32],[50,-32],[50,0],[50,32],[0,-35],[0,35],[-32,-28],[32,-28],[-32,28],[32,28],[-44,-18],[44,-18],[-44,18],[44,18]];\n\n/* \u2550\u2550\u2550 STATE \u2550\u2550\u2550 */\nlet _W = 1920, _H = 1080;\nlet R, S, cam, rayCam;\nlet ico, icoMat, dM, sM2;\nlet PL1, PL2, PL3, _iMat;\nlet _rollingFps = 60, _fc = 0;\nconst _t0 = performance.now();\nlet T = 0, _prevT = 0;\nconst ndc = { x: 0, y: 0 };\nconst lookT = { sx: 0, sy: 0 };\nconst icoTarget = { x: 0, y: 0 };\nlet isMobile = false, isTouchDevice = false, _mTouching = false;\nlet Q;\n\n/* Cursor tracking */\nconst mPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);\nconst mw = new THREE.Vector3(), mwS = new THREE.Vector3(), mwP = new THREE.Vector3(), mwV = new THREE.Vector3();\nconst rcst = new THREE.Raycaster();\n\n/* \u2550\u2550\u2550 GRANULE GEOMETRY FACTORY \u2550\u2550\u2550 */\nfunction mkP(sx, sy, sz, irr) {\n  const g = new THREE.SphereGeometry(1, Q.granuleDetail[0], Q.granuleDetail[1]);\n  const pos = g.attributes.position; const sd = Math.random() * 100;\n  for (let i = 0; i < pos.count; i++) {\n    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);\n    x *= sx; y *= sy; z *= sz;\n    if (irr > 0) {\n      const a = Math.atan2(z, x), bump = Math.sin(a * 5 + sd) * Math.cos(y * 4 + sd * .7) * irr;\n      const len = Math.sqrt(x * x + z * z);\n      if (len > .01) { x += (x / len) * bump; z += (z / len) * bump; }\n    }\n    pos.setXYZ(i, x, y, z);\n  }\n  pos.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();\n  return g;\n}\n\n/* \u2550\u2550\u2550 MAIN INIT \u2550\u2550\u2550 */\nfunction init(canvas, deviceInfo) {\n  _W = deviceInfo.w; _H = deviceInfo.h;\n  _dpr = deviceInfo.dpr || 2;\n  isMobile = deviceInfo.isMobile;\n  isTouchDevice = deviceInfo.isTouchDevice;\n  _isLaptop = deviceInfo.isLaptop || false;\n  const _slowNet = deviceInfo.slowNet;\n\n  R = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'default' });\n  const GPU_INFO = detectGPU(R.getContext());\n  Q = buildQ(GPU_INFO.tier, isMobile, _slowNet);\n  _adprDPR = Math.min(deviceInfo.dpr || 2, Q.maxDPR);\n  R.setPixelRatio(_adprDPR);\n  R.setSize(_W, _H, false);\n  R.setClearColor(0x040710, 1);\n  R.toneMapping = THREE.ACESFilmicToneMapping;\n  R.toneMappingExposure = .9;\n  R.outputColorSpace = THREE.SRGBColorSpace;\n  /* SINGLE SCENE \u2014 one render pass */\n  R.autoClear = true;\n\n  /* \u2500\u2500 Scene + Camera \u2500\u2500 */\n  S = new THREE.Scene();\n  S.fog = new THREE.FogExp2(0x040810, Q.fogDensity);\n  cam = new THREE.PerspectiveCamera(isMobile ? 65 : 55, _W / _H, .1, 500);\n  cam.position.set(0, 0, isMobile ? 14 : 12);\n  rayCam = new THREE.PerspectiveCamera(isMobile ? 60 : 50, _W / _H, .1, 400);\n  rayCam.position.set(0, 0, 15);\n\n  /* \u2500\u2500 Lights (all in one scene now) \u2500\u2500 */\n  S.add(new THREE.AmbientLight(0x080616, 2.5));\n  const dirLights = [\n    { c: 0xe84580, i: 1.2, p: [-5, 8, 10] },\n    { c: 0x2af5d4, i: .8, p: [8, -3, 12] },\n    { c: 0xc850f0, i: .6, p: [-3, -6, 8] },\n  ];\n  dirLights.forEach(d => { const l = new THREE.DirectionalLight(d.c, d.i); l.position.set(...d.p); S.add(l); });\n\n  PL1 = new THREE.PointLight(0xe84580, 5, 45); PL1.position.set(0, 0, 13); S.add(PL1);\n  PL2 = new THREE.PointLight(0x2af5d4, 3, 35); PL2.position.set(3, 3, 11); S.add(PL2);\n  PL3 = new THREE.PointLight(0xc850f0, 2.2, 30); PL3.position.set(-3, -2, 12); S.add(PL3);\n\n  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */\n  /* \u2550\u2550 BACKGROUND: dust, sparkle, icosphere \u2550\u2550 */\n  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */\n\n  /* Dust */\n  const DC = Q.dustCount;\n  const dG = new THREE.BufferGeometry();\n  const dP = new Float32Array(DC * 3), dC = new Float32Array(DC * 3), dSzA = new Float32Array(DC), dPhA = new Float32Array(DC);\n  for (let i = 0; i < DC; i++) {\n    const i3 = i * 3, r = Math.pow(Math.random(), .5) * 20, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);\n    dP[i3] = r * Math.sin(p) * Math.cos(t); dP[i3 + 1] = r * Math.sin(p) * Math.sin(t); dP[i3 + 2] = r * Math.cos(p);\n    const c = Math.random();\n    if (c < .06) { dC[i3] = PK[0]; dC[i3 + 1] = PK[1]; dC[i3 + 2] = PK[2]; }\n    else if (c < .1) { dC[i3] = TL[0]; dC[i3 + 1] = TL[1]; dC[i3 + 2] = TL[2]; }\n    else if (c < .14) { dC[i3] = PU[0]; dC[i3 + 1] = PU[1]; dC[i3 + 2] = PU[2]; }\n    else { const b = .3 + Math.random() * .4; dC[i3] = b; dC[i3 + 1] = b * .98; dC[i3 + 2] = b * .92; }\n    dSzA[i] = .5 + Math.random() * 2.5; dPhA[i] = Math.random();\n  }\n  dG.setAttribute('position', new THREE.BufferAttribute(dP, 3));\n  dG.setAttribute('aCol', new THREE.BufferAttribute(dC, 3));\n  dG.setAttribute('aSz', new THREE.BufferAttribute(dSzA, 1));\n  dG.setAttribute('aPh', new THREE.BufferAttribute(dPhA, 1));\n  dM = new THREE.ShaderMaterial({ vertexShader: _dustVS, fragmentShader: _dustFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });\n  S.add(new THREE.Points(dG, dM));\n\n  /* Sparkle */\n  const SC = Q.sparkleCount;\n  const sG = new THREE.BufferGeometry();\n  const sP = new Float32Array(SC * 3), sSz = new Float32Array(SC), sPh = new Float32Array(SC);\n  for (let i = 0; i < SC; i++) {\n    const i3 = i * 3, r = Math.pow(Math.random(), .4) * 18, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);\n    sP[i3] = r * Math.sin(p) * Math.cos(t); sP[i3 + 1] = r * Math.sin(p) * Math.sin(t); sP[i3 + 2] = r * Math.cos(p);\n    sSz[i] = .3 + Math.random() * 1.5; sPh[i] = Math.random();\n  }\n  sG.setAttribute('position', new THREE.BufferAttribute(sP, 3));\n  sG.setAttribute('aSz', new THREE.BufferAttribute(sSz, 1));\n  sG.setAttribute('aPh', new THREE.BufferAttribute(sPh, 1));\n  sM2 = new THREE.ShaderMaterial({ vertexShader: _sparkVS, fragmentShader: _sparkFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });\n  S.add(new THREE.Points(sG, sM2));\n\n  /* Icosphere */\n  icoMat = new THREE.ShaderMaterial({\n    vertexShader: _icoVS, fragmentShader: _icoFS, transparent: true, side: THREE.DoubleSide, depthWrite: false,\n    uniforms: { uT: { value: 0 }, uCur: { value: new THREE.Vector3() } }\n  });\n  ico = new THREE.Mesh(new THREE.SphereGeometry(1.8, Q.sphereDetail[0], Q.sphereDetail[1]), icoMat);\n  S.add(ico);\n\n  /* Orbital particles (NOW shader-animated) */\n  const OC = 120;\n  const oG = new THREE.BufferGeometry();\n  const oP = new Float32Array(OC * 3), oSz = new Float32Array(OC), oPh = new Float32Array(OC), oVel = new Float32Array(OC * 3);\n  for (let i = 0; i < OC; i++) {\n    const i3 = i * 3, r = 1.6 + Math.random() * .5, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);\n    oP[i3] = r * Math.sin(p) * Math.cos(t); oP[i3 + 1] = r * Math.sin(p) * Math.sin(t); oP[i3 + 2] = r * Math.cos(p);\n    oSz[i] = .8 + Math.random() * 2; oPh[i] = Math.random() * 6.28;\n    oVel[i3] = .3 + Math.random() * .4; oVel[i3 + 1] = .2 + Math.random() * .3; oVel[i3 + 2] = .15 + Math.random() * .25;\n  }\n  oG.setAttribute('position', new THREE.BufferAttribute(oP, 3));\n  oG.setAttribute('aSz', new THREE.BufferAttribute(oSz, 1));\n  oG.setAttribute('aPh', new THREE.BufferAttribute(oPh, 1));\n  oG.setAttribute('aVel', new THREE.BufferAttribute(oVel, 3));\n  const orbMat = new THREE.ShaderMaterial({ vertexShader: _orbVS, fragmentShader: _orbFS, transparent: true, depthWrite: false, uniforms: { uT: { value: 0 } } });\n  const orbPoints = new THREE.Points(oG, orbMat);\n  S.add(orbPoints);\n\n  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */\n  /* \u2550\u2550 GRANULES: GPU-DRIVEN InstancedMesh   \u2550\u2550 */\n  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */\n\n  const _wpScale = Math.max(_W / 1920, _H / 1080);\n  const WAYPOINTS = WAYPOINTS_BASE.map(p => [p[0] * _wpScale, p[1] * _wpScale]);\n\n  const GEOS = [mkP(1, .55, .92, .015), mkP(.9, .52, .88, .02), mkP(1.08, .58, .98, .012), mkP(.95, .54, .9, .018), mkP(.85, .5, .84, .022), mkP(1.02, .56, .94, .016), mkP(.88, .53, .87, .025)];\n  const GN = GEOS.length;\n  const COUNT = Q.granuleCount;\n  const _gSpX = isMobile ? 60 : 110 * _wpScale, _gSpY = isMobile ? 44 : 70 * _wpScale;\n  const cols = Math.ceil(Math.sqrt(COUNT * 2.2)), rows = Math.ceil(COUNT / cols);\n\n  /* Group granules by geometry type for instancing */\n  const groups = Array.from({ length: GN }, () => ({ basePosArr: [], phaseArr: [], fSpdArr: [], fAmpArr: [], rotSpdArr: [], scaleArr: [], colArr: [], opArr: [], roughArr: [] }));\n\n  for (let i = 0; i < COUNT; i++) {\n    const geoIdx = i % GN;\n    const cs = COLORS[Math.floor(Math.random() * COLORS.length)];\n    const px = (i % cols / (cols - 1) - .5) * _gSpX + (Math.random() - .5) * 6;\n    const py = (Math.floor(i / cols) / (rows - 1) - .5) * _gSpY + (Math.random() - .5) * 5;\n    const pz = (Math.random() - .5) * 12;\n    const sc = isMobile ? (.12 + Math.random() * .22) : (.14 + Math.random() * .28);\n    const seed = Math.random();\n    const gr = groups[geoIdx];\n    gr.basePosArr.push(px, py, pz);\n    gr.phaseArr.push(Math.random() * 6.28);\n    gr.fSpdArr.push(.003 + Math.random() * .005);\n    gr.fAmpArr.push(.02 + Math.random() * .03);\n    gr.rotSpdArr.push((.00003 + Math.random() * .00005) * (Math.random() > .5 ? 1 : -1));\n    gr.scaleArr.push(sc);\n    gr.colArr.push(cs.b.r, cs.b.g, cs.b.b);\n    gr.opArr.push(.18 + seed * .20);\n    gr.roughArr.push(.3 + Math.random() * .5);\n  }\n\n  /* Create granule material (GPU-driven) */\n  _iMat = new THREE.ShaderMaterial({\n    vertexShader: _iVS, fragmentShader: _iFS, transparent: true, side: THREE.FrontSide, depthWrite: false,\n    uniforms: {\n      uPL1: { value: PL1.position }, uPL2: { value: PL2.position }, uPL3: { value: PL3.position },\n      uTime: { value: 0 }, uCursor: { value: new THREE.Vector2(0, 0) }\n    }\n  });\n\n  /* Build InstancedMeshes with GPU-driven attributes */\n  for (let g = 0; g < GN; g++) {\n    const gr = groups[g];\n    const cnt = gr.phaseArr.length; if (!cnt) continue;\n    const im = new THREE.InstancedMesh(GEOS[g], _iMat, cnt);\n\n    /* Per-instance attributes (set ONCE, never updated) */\n    const geo = im.geometry;\n    geo.setAttribute('aBasePos', new THREE.InstancedBufferAttribute(new Float32Array(gr.basePosArr), 3));\n    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(gr.phaseArr), 1));\n    geo.setAttribute('aFSpd', new THREE.InstancedBufferAttribute(new Float32Array(gr.fSpdArr), 1));\n    geo.setAttribute('aFAmp', new THREE.InstancedBufferAttribute(new Float32Array(gr.fAmpArr), 1));\n    geo.setAttribute('aRotSpd', new THREE.InstancedBufferAttribute(new Float32Array(gr.rotSpdArr), 1));\n    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(new Float32Array(gr.scaleArr), 1));\n    geo.setAttribute('aOp', new THREE.InstancedBufferAttribute(new Float32Array(gr.opArr), 1));\n    geo.setAttribute('aRough', new THREE.InstancedBufferAttribute(new Float32Array(gr.roughArr), 1));\n\n    /* Instance colors */\n    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(gr.colArr), 3);\n\n    /* Identity matrices (positions computed in shader, not via instanceMatrix) */\n    const dm = new THREE.Object3D();\n    for (let j = 0; j < cnt; j++) {\n      dm.position.set(0, 0, 0);\n      dm.quaternion.identity();\n      dm.scale.setScalar(1);\n      dm.updateMatrix();\n      im.setMatrixAt(j, dm.matrix);\n    }\n    im.instanceMatrix.needsUpdate = true; /* once */\n    im.frustumCulled = false;\n    S.add(im);\n  }\n\n  /* \u2550\u2550\u2550 START RENDER LOOP \u2550\u2550\u2550 */\n  loop();\n}\n\n/* \u2550\u2550\u2550 RENDER LOOP \u2014 MINIMAL JS, GPU DOES THE WORK \u2550\u2550\u2550 */\nlet _paused = false;\nfunction loop() {\n  requestAnimationFrame(loop);\n  if (_paused) return; /* v2: \u043f\u0430\u0443\u0437\u0430 \u043a\u043e\u0433\u0434\u0430 canvas \u043d\u0435 \u0432\u0438\u0434\u0435\u043d \u0438\u043b\u0438 \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u0432 \u0444\u043e\u043d\u0435 */\n  _fc++; T = (performance.now() - _t0) * .001;\n  const _dt = T - _prevT; _prevT = T;\n  if (_dt > 0) _rollingFps += ((1 / _dt) - _rollingFps) * .05;\n  adaptDPR(R, performance.now());\n\n  /* Touch device: sine drift when not touching */\n  if (isTouchDevice && !_mTouching) {\n    ndc.x = Math.sin(T * .3) * .35 + Math.sin(T * .17) * .15;\n    ndc.y = Math.cos(T * .25) * .25 + Math.cos(T * .13) * .1;\n  }\n\n  /* Cursor \u2192 world coords */\n  rayCam.updateMatrixWorld(true);\n  rcst.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), rayCam);\n  rcst.ray.intersectPlane(mPlane, mw);\n  mwV.subVectors(mw, mwP); mwP.copy(mw);\n  const _mSmooth = isTouchDevice ? .12 : .035;\n  mwS.x += (mw.x - mwS.x) * _mSmooth; mwS.y += (mw.y - mwS.y) * _mSmooth;\n\n  /* \u2500\u2500 Update uniforms (THIS IS ALL THE JS DOES PER FRAME) \u2500\u2500 */\n  dM.uniforms.uT.value = T;\n  sM2.uniforms.uT.value = T;\n  icoMat.uniforms.uT.value = T;\n  icoMat.uniforms.uCur.value.set(ndc.x * 1.0, ndc.y * 1.0, 0);\n  _iMat.uniforms.uTime.value = T;\n  _iMat.uniforms.uCursor.value.set(mwS.x, mwS.y);\n\n  /* \u2500\u2500 Camera follow cursor \u2500\u2500 */\n  lookT.sx += (ndc.x * .15 - lookT.sx) * .012; lookT.sy += (ndc.y * .08 - lookT.sy) * .012;\n  cam.lookAt(lookT.sx, lookT.sy, 0);\n\n  /* \u2500\u2500 Icosphere gentle movement \u2500\u2500 */\n  if (!isMobile) { icoTarget.x += (ndc.x * .12 - icoTarget.x) * .008; icoTarget.y += (ndc.y * .08 - icoTarget.y) * .008; }\n  else { icoTarget.x += (0 - icoTarget.x) * .01; icoTarget.y += (0 - icoTarget.y) * .01; }\n  ico.position.x = icoTarget.x; ico.position.y = icoTarget.y;\n  ico.rotation.y = T * .05 + ndc.x * .18; ico.rotation.x = T * .04 + ndc.y * .14;\n  ico.scale.setScalar(1 + Math.sin(T * .35) * .045 + Math.sin(T * .12) * .02);\n\n  /* \u2500\u2500 Point lights follow cursor (smooth) \u2500\u2500 */\n  PL1.position.x += (mw.x * .85 - PL1.position.x) * .06; PL1.position.y += (mw.y * .85 - PL1.position.y) * .06;\n  PL2.position.x += (mw.x * .55 - PL2.position.x) * .035; PL2.position.y += (mw.y * .55 - PL2.position.y) * .035;\n  PL3.position.x += (mw.x * .4 + 3 - PL3.position.x) * .025; PL3.position.y += (mw.y * .4 - 2 - PL3.position.y) * .025;\n\n  /* \u2500\u2500 SINGLE RENDER PASS \u2500\u2500 */\n  R.render(S, cam);\n}\n\n/* \u2550\u2550\u2550 WORKER MESSAGE HANDLER \u2550\u2550\u2550 */\nif (IS_WORKER) {\n  self.onmessage = function(e) {\n    const d = e.data;\n    if (d.type === 'init') {\n      _isLaptop = d.deviceInfo.isLaptop || false;\n      init(d.canvas, d.deviceInfo);\n      self.postMessage({ type: 'alive' });\n    } else if (d.type === 'mouse') { ndc.x = d.x; ndc.y = d.y; }\n    else if (d.type === 'touch') {\n      if (d.touching) { _mTouching = true; ndc.x = d.x; ndc.y = d.y; }\n      else { _mTouching = false; }\n    }\n    else if (d.type === 'resize') {\n      _W = d.w; _H = d.h;\n      cam.aspect = _W / _H; cam.updateProjectionMatrix();\n      rayCam.aspect = _W / _H; rayCam.updateProjectionMatrix();\n      R.setSize(_W, _H, false);\n    }\n    else if (d.type === 'pause') { _paused = true; }\n    else if (d.type === 'resume') { _paused = false; _prevT = (performance.now() - _t0) * .001; }\n  };\n}\n\n";

  function createInlineWorker() {
    if (typeof orig.transferControlToOffscreen !== 'function') {
      console.warn('[gkl-loader] ❌ OffscreenCanvas not supported');
      return Promise.reject(new Error('no-offscreen'));
    }
    if (location.protocol === 'file:') {
      console.warn('[gkl-loader] ❌ file:// protocol');
      return Promise.reject(new Error('file-protocol'));
    }
    try {
      var blob = new Blob([INLINE_WORKER_CODE], { type: 'application/javascript' });
      var blobUrl = URL.createObjectURL(blob);
      var worker = new Worker(blobUrl);
      URL.revokeObjectURL(blobUrl);
      console.log('[gkl-loader] inline worker created (same-origin blob)');
      return Promise.resolve(worker);
    } catch (e) {
      console.error('[gkl-loader] ❌ Worker create threw:', e.name, e.message);
      return Promise.reject(e);
    }
  }

  function startWorker() {
    createInlineWorker().then(function (worker) {
      w = worker;

      wc = document.createElement('canvas');
      wc.id = 'bgC2';
      wc.setAttribute('aria-hidden', 'true');
      wc.style.cssText = orig.style.cssText || 'position:fixed;inset:0;z-index:0;pointer-events:none;touch-action:none';
      orig.parentNode.insertBefore(wc, orig.nextSibling);

      var oc = wc.transferControlToOffscreen();

      w.postMessage({
        type: 'init',
        canvas: oc,
        deviceInfo: {
          w: innerWidth, h: innerHeight,
          isMobile: mob, isTouchDevice: td,
          dpr: devicePixelRatio, slowNet: !!slow,
          isLaptop: !!window._GKL_LT
        }
      }, [oc]);

      orig.style.display = 'none';
      window._W3D = true;
      window._GKL_W = w;

      w.onmessage = function (e) {
        if (e.data && e.data.type === 'alive') {
          workerAlive = true;
          console.log('[gkl-loader] ✓ Worker alive, main thread FREE, Three.js NOT loaded');
          setupVisibilityPause();
        }
      };
      w.onerror = function (err) {
        console.error('[gkl-loader] ❌ Worker runtime:', err.message || err.type || err);
        revertToMainThread();
      };

      setTimeout(function () {
        if (!workerAlive) {
          console.warn('[gkl-loader] ❌ Worker did not respond in 3s');
          revertToMainThread();
        }
      }, 3000);
    }).catch(function (err) {
      console.error('[gkl-loader] ❌ Worker create failed:', err.message);
      revertToMainThread();
    });
  }

  function setupVisibilityPause() {
    if (typeof IntersectionObserver !== 'function') return;
    var target = wc || orig;
    var paused = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (ent) {
        if (ent.isIntersecting && paused) {
          paused = false;
          if (w) w.postMessage({ type: 'resume' });
        } else if (!ent.isIntersecting && !paused) {
          paused = true;
          if (w) w.postMessage({ type: 'pause' });
        }
      });
    }, { threshold: 0, rootMargin: '200px 0px' });
    io.observe(target);

    document.addEventListener('visibilitychange', function () {
      if (!w) return;
      if (document.hidden) w.postMessage({ type: 'pause' });
      else if (!paused) w.postMessage({ type: 'resume' });
    });
  }

  var fallbackStarted = false;
  function revertToMainThread() {
    if (fallbackStarted) return;
    fallbackStarted = true;
    window._W3D = false;
    window._GKL_W = null;
    if (w) { try { w.terminate(); } catch (e) {} w = null; }
    if (orig) orig.style.display = '';
    var c2 = document.getElementById('bgC2');
    if (c2) c2.remove();
    startMainThreadScene();
  }

  function startMainThreadScene() {
    console.log('[gkl-loader] Starting main-thread WebGL (heavier)');
    var p1 = import(THREE_MODULE_URL);
    var p2 = loadSceneScript();
    Promise.all([p1, p2]).then(function (results) {
      var THREE = results[0];
      if (typeof window._gklScene !== 'function') {
        console.error('[gkl-loader] _gklScene missing');
        return;
      }
      try { window._gklScene(THREE); }
      catch (e) { console.error('[gkl-loader] Scene threw:', e); }
    }).catch(function (e) {
      console.error('[gkl-loader] Failed THREE/scene:', e.message);
    });
  }

  function loadSceneScript() {
    return new Promise(function (resolve, reject) {
      if (typeof window._gklScene === 'function') { resolve(); return; }
      var s = document.createElement('script');
      s.src = SCENE_URL;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load scene')); };
      document.head.appendChild(s);
    });
  }

  var mt = 0;
  addEventListener('mousemove', function (e) {
    if (!window._W3D || !w) return;
    var nx = (e.clientX / innerWidth) * 2 - 1;
    var ny = -(e.clientY / innerHeight) * 2 + 1;
    var n = performance.now();
    if (n - mt > 16) { mt = n; w.postMessage({ type: 'mouse', x: nx, y: ny }); }
  }, { passive: true });

  addEventListener('touchstart', function (e) {
    if (!window._W3D || !w) return;
    var t = e.touches[0];
    w.postMessage({ type: 'touch', touching: true, x: (t.clientX / innerWidth) * 2 - 1, y: -(t.clientY / innerHeight) * 2 + 1 });
  }, { passive: true });

  addEventListener('touchmove', function (e) {
    if (!window._W3D || !w) return;
    var t = e.touches[0];
    w.postMessage({ type: 'touch', touching: true, x: (t.clientX / innerWidth) * 2 - 1, y: -(t.clientY / innerHeight) * 2 + 1 });
  }, { passive: true });

  addEventListener('touchend', function () {
    if (!window._W3D || !w) return;
    w.postMessage({ type: 'touch', touching: false });
  }, { passive: true });

  var rt;
  addEventListener('resize', function () {
    if (!window._W3D || !w) return;
    clearTimeout(rt);
    rt = setTimeout(function () { w.postMessage({ type: 'resize', w: innerWidth, h: innerHeight }); }, 200);
  });

  (function gl() {
    requestAnimationFrame(gl);
    if (document.hidden || !window._W3D) return;
    var t = performance.now() * 0.001;
    ['gs1', 'gs2', 'gs3', 'gs4'].forEach(function (id, i) {
      var el = document.getElementById(id);
      if (el) {
        var sp = [0.3, 0.35, 0.22, 0.27][i];
        var sp2 = [0.25, 0.28, 0.3, 0.33][i];
        el.style.transform = 'translate(' + Math.sin(t * sp) * 30 + 'px,' + Math.cos(t * sp2) * 20 + 'px)';
      }
    });
  })();

  startWorker();
})();
