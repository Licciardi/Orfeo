// Visualizador circular reativo ao áudio (Canvas 2D + Web Audio).
//
// O som toca dentro do iframe do YouTube, que a página não pode ler. Por isso o áudio é capturado:
//  - Electron: som do sistema (loopback), liberado pelo processo principal, sem prompt;
//  - Navegador: compartilhamento da própria guia com áudio (o Chrome pergunta uma vez).
//
// Pipeline por frame: FFT → 72 faixas em escala logarítmica (espelhadas = 144 barras)
// → suavização ataque/soltura → detecção de batida nos graves → cor/pulso/partículas.

const HALF = 72;             // barras por lado (o círculo é espelhado: graves no topo, agudos embaixo)
const MIN_F = 35, MAX_F = 14000;

export class Visualizer {
  hasAudio = false;
  onchange = null;           // avisado quando o áudio liga/desliga

  #actx = null; #analyser = null; #freq = null; #source = null; #stream = null; #bins = null;
  #canvas = null; #g = null; #raf = 0; #ro = null; #w = 0; #h = 0; #dpr = 1; #last = 0;
  #levels = new Float32Array(HALF);
  #hue = 210; #targetHue = 210;
  #bass = 0; #bassS = 0; #prevBass = 0; #bassHist = []; #lastBeat = 0; #beat = 0;
  #energy = 0; #rot = 0;
  // Para o Automix: batidas recentes (BPM) e volume geral, mesmo com a tela do visualizador fechada
  #beatTimes = []; #loud = 0; #lastA = 0; #updatedAt = 0;

  constructor() {
    // A análise roda sozinha (~60x/s); o canvas só desenha o resultado quando está aberto
    setInterval(() => this.#tickAnalysis(), 16);
  }

  #tickAnalysis() {
    const ext = this.#extFresh();
    // Avisa quando passa a ouvir / deixa de ouvir (ex.: o deck começou ou parou de tocar)
    if (this.listening !== this.#wasListening) { this.#wasListening = this.listening; this.onchange?.(); }
    if (!this.#analyser && !this.#canvas && !ext) return;
    const now = performance.now();
    const dt = Math.min(4, (now - (this.#lastA || now - 16.667)) / 16.667);
    this.#lastA = now;
    this.#analyse(now, dt);
    if (this.#analyser || ext) this.#updatedAt = now;
  }

  // ---------- Espectro vindo direto dos decks (app desktop) ----------
  // Cada player do YouTube manda o próprio espectro: o visualizador e o Automix escutam só o
  // Orfeo, sem capturar o som do computador (vozes do Discord não entram na análise).
  #ext = [null, null];   // { bins, at } por deck
  #extF = null;          // espectro combinado dos decks
  #extHz = 0;
  #wasListening = false;

  feedDeck(deck, bins, sampleRate, fftSize) {
    this.#ext[deck] = { bins, at: performance.now() };
    const hz = sampleRate / fftSize;
    if (hz !== this.#extHz) { this.#extHz = hz; if (!this.#analyser) this.#setupBins(hz); }
  }

  #extFresh() {
    const now = performance.now();
    return this.#ext.some((e) => e && now - e.at < 250);
  }

  get listening() { return this.hasAudio || this.#extFresh(); }

  // Nível de UM deck (0..1, mistura de volume geral e grave) — usado nas ondas da transição.
  // null quando esse deck não está mandando som (ex.: navegador comum).
  deckLevel(deck) {
    const e = this.#ext[deck];
    if (!e || performance.now() - e.at > 250) return null;
    const b = e.bins, top = Math.min(b.length, this.#loudBins);
    let loud = 0, bass = 0;
    for (let i = 1; i < top; i++) loud += b[i];
    const [b0, b1] = this.#bassBins;
    for (let i = b0; i < b1; i++) bass += b[i];
    return Math.min(1, 0.55 * (loud / (top * 255)) * 2.2 + 0.45 * (bass / ((b1 - b0) * 255)));
  }

  // Pega o espectro do momento: decks (preferência) ou captura do som (fallback)
  #readSpectrum() {
    if (this.#extFresh()) {
      const now = performance.now();
      const fresh = this.#ext.filter((e) => e && now - e.at < 250);
      const n = fresh[0].bins.length;
      if (!this.#extF || this.#extF.length !== n) this.#extF = new Uint8Array(n);
      const f = this.#extF;
      f.set(fresh[0].bins);
      for (let k = 1; k < fresh.length; k++) {   // na transição os dois decks tocam: junta pelo máximo
        const b = fresh[k].bins;
        for (let i = 0; i < n; i++) if (b[i] > f[i]) f[i] = b[i];
      }
      if (this.#analyser && this.#extHz) this.#setupBins(this.#extHz);
      return f;
    }
    if (this.#analyser) {
      if (this.#extHz) this.#setupBins(this.#actx.sampleRate / this.#analyser.fftSize);
      this.#analyser.getByteFrequencyData(this.#freq);
      return this.#freq;
    }
    return null;
  }
  #particles = [];
  #cover = null; #coverUrl = "";

  // ---------- Áudio ----------
  async enableAudio() {
    if (this.hasAudio) return;
    const desktop = !!window.orfeoDesktop;
    const stream = await navigator.mediaDevices.getDisplayMedia(desktop
      ? { video: true, audio: true }
      : {
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
          preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude", systemAudio: "include",
        });
    stream.getVideoTracks().forEach((t) => t.stop()); // só o som interessa
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error("Nenhum áudio foi compartilhado. Marque “Compartilhar áudio da guia”.");
    tracks[0].addEventListener("ended", () => this.disableAudio());
    this.#stream = new MediaStream(tracks);
    this.#connect(this.#ctx().createMediaStreamSource(this.#stream));
  }

  disableAudio() {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#source?.disconnect();
    this.#stream = this.#source = this.#analyser = null;
    this.hasAudio = false;
    this.onchange?.();
  }

  #ctx() {
    this.#actx ??= new AudioContext();
    this.#actx.resume();
    return this.#actx;
  }

  #connect(source) {
    const an = this.#ctx().createAnalyser();
    an.fftSize = 4096;               // ~11.7 Hz por bin a 48 kHz: resolução boa nos graves
    an.smoothingTimeConstant = 0.5;
    an.minDecibels = -85;
    an.maxDecibels = -22;
    source.connect(an);              // não vai pro alto-falante: só análise
    this.#source = source;
    this.#analyser = an;
    this.#freq = new Uint8Array(an.frequencyBinCount);
    this.#setupBins(this.#actx.sampleRate / an.fftSize);
    this.hasAudio = true;
    this.onchange?.();
  }

  // Faixas de frequência das barras (escala logarítmica), dos graves e do volume geral
  #setupBins(hz) {
    if (this.#binsHz === hz) return;
    this.#binsHz = hz;
    this.#bins = Array.from({ length: HALF }, (_, i) => {
      const f0 = MIN_F * (MAX_F / MIN_F) ** (i / HALF);
      const f1 = MIN_F * (MAX_F / MIN_F) ** ((i + 1) / HALF);
      const b0 = Math.floor(f0 / hz);
      return [b0, Math.max(b0 + 1, Math.ceil(f1 / hz))];
    });
    this.#bassBins = [Math.floor(40 / hz), Math.ceil(140 / hz)];
    this.#loudBins = Math.ceil(8000 / hz);
  }
  #binsHz = 0;
  #bassBins = [3, 12];
  #loudBins = 680;

  // Sinal sintético (bumbo 124 BPM + chimbal + acordes) para testar sem compartilhar áudio.
  // Não toca no alto-falante. Uso no console: (await import("/visualizer.js")).viz._demo()
  _demo() {
    const ctx = this.#ctx(), bus = ctx.createGain();
    const spb = 60 / 124;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
    noise.getChannelData(0).forEach((_, i, d) => (d[i] = Math.random() * 2 - 1));
    const schedule = (t0) => {
      for (let n = 0; n < 16; n++) {
        const t = t0 + n * spb / 2;
        if (n % 2 === 0) { // bumbo
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
          g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          o.connect(g).connect(bus); o.start(t); o.stop(t + 0.4);
        }
        const h = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), hg = ctx.createGain(); // chimbal
        h.buffer = noise; hp.type = "highpass"; hp.frequency.value = 7000;
        hg.gain.setValueAtTime(0.25, t); hg.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        h.connect(hp).connect(hg).connect(bus); h.start(t);
      }
      [220, 277, 330, 440, 660].forEach((f, i) => { // acorde
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sawtooth"; o.frequency.value = f * (1 + (Math.floor(t0 / (spb * 8)) % 2) * 0.12);
        g.gain.setValueAtTime(0.05, t0); g.gain.linearRampToValueAtTime(0.0001, t0 + spb * 8);
        o.connect(g).connect(bus); o.start(t0); o.stop(t0 + spb * 8);
      });
    };
    let next = ctx.currentTime + 0.05;
    schedule(next);
    this._demoTimer = setInterval(() => { next += spb * 8; schedule(next); }, spb * 8 * 1000);
    this.#connect(bus);
  }

  // ---------- Faixa atual ----------
  setTrack(track) {
    const url = track?.thumb ? `/api/thumb?url=${encodeURIComponent(track.thumb)}` : "";
    if (url === this.#coverUrl) return;
    this.#coverUrl = url;
    this.#cover = null;
    if (!url) return;
    const img = new Image();
    img.onload = () => { if (this.#coverUrl === url) this.#cover = img; };
    img.src = url;
  }

  // Cor base vinda da capa ("hsl(H S% L%)"): a cor parte dela e as batidas giram a partir daí
  setBaseColor(hsl) {
    const h = parseFloat(String(hsl).replace(/^hsl\(/, ""));
    if (!Number.isNaN(h)) this.#targetHue = h;
  }

  // ---------- Canvas ----------
  mount(canvas) {
    this.unmount();
    this.#canvas = canvas;
    this.#g = canvas.getContext("2d");
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(canvas);
    this.#resize();
    this.#last = performance.now();
    const loop = (now) => { this.#frame(now); this.#raf = requestAnimationFrame(loop); };
    this.#raf = requestAnimationFrame(loop);
  }

  unmount() {
    cancelAnimationFrame(this.#raf);
    this.#ro?.disconnect();
    this.#canvas = this.#g = this.#ro = null;
  }

  #resize() {
    const c = this.#canvas;
    if (!c) return;
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#w = c.clientWidth;
    this.#h = c.clientHeight;
    c.width = Math.round(this.#w * this.#dpr);
    c.height = Math.round(this.#h * this.#dpr);
  }

  // ---------- Análise ----------
  #analyse(now, dt) {
    const L = this.#levels;
    let bass = 0;
    const f = this.#readSpectrum();
    if (f) {
      for (let i = 0; i < HALF; i++) {
        const [b0, b1] = this.#bins[i];
        let m = 0;
        for (let b = b0; b < b1 && b < f.length; b++) if (f[b] > m) m = f[b];
        // agudos têm menos energia: compensa um pouco; a curva deixa o silêncio baixo e os picos "socando"
        let v = Math.min(1, (m / 255) * (0.8 + 0.55 * (i / HALF)));
        v = Math.pow(v, 1.7) * 1.1;
        this.#smooth(i, v, dt);
      }
      const [b0, b1] = this.#bassBins;
      for (let b = b0; b < b1; b++) bass += f[b];
      bass /= (b1 - b0) * 255;
      // Volume geral (até ~8 kHz), suavizado em ~0,5 s: base para achar o "outro" da música
      const top = Math.min(f.length, this.#loudBins);
      let sum = 0;
      for (let b = 1; b < top; b++) sum += f[b];
      this.#loud += (sum / (top * 255) - this.#loud) * (1 - Math.pow(0.97, dt));
    } else {
      // Sem áudio: respiração suave para o anel não ficar morto
      const t = now / 1000;
      for (let i = 0; i < HALF; i++) {
        this.#smooth(i, 0.05 + 0.05 * (Math.sin(t * 1.4 + i * 0.32) * 0.5 + 0.5) + 0.03 * Math.sin(t * 0.6 + i * 0.09), dt);
      }
    }

    // Detecção de batida: graves bem acima da média recente, subindo, com intervalo mínimo
    const hist = this.#bassHist;
    hist.push(bass);
    if (hist.length > 45) hist.shift();
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (bass > avg * 1.15 + 0.03 && bass > 0.28 && bass > this.#prevBass && now - this.#lastBeat > 250) {
      this.#onBeat(bass);
      this.#lastBeat = now;
      this.#beatTimes.push(now);
      if (this.#beatTimes.length > 24) this.#beatTimes.shift();
    }
    this.#prevBass = bass;
    this.#bass = bass;
    this.#bassS += (bass - this.#bassS) * (1 - Math.pow(0.6, dt));
    this.#energy = L.reduce((a, b) => a + b, 0) / HALF;
  }

  #smooth(i, v, dt) {
    const L = this.#levels;
    // ataque rápido, soltura lenta (independente do FPS)
    const k = v > L[i] ? 1 - Math.pow(0.35, dt) : 1 - Math.pow(0.88, dt);
    L[i] += (v - L[i]) * k;
  }

  #onBeat(strength) {
    this.#beat = 1;
    this.#targetHue = (this.#targetHue + 35 + Math.random() * 70) % 360;
    const n = 8 + Math.round(strength * 16);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5 * (0.6 + strength);
      this.#particles.push({ a, r: 0, v: s, life: 1, size: 0.8 + Math.random() * 2.2, hue: (Math.random() - 0.5) * 50 });
    }
    if (this.#particles.length > 220) this.#particles.splice(0, this.#particles.length - 220);
  }

  // ---------- Desenho ----------
  style = "ring"; // "ring" (círculo de barras) | "waves" (ondas)

  // Estilo "Ondas": 5 camadas de ondas atravessando a tela. Cada camada segue uma faixa do
  // espectro (dos graves aos agudos); o desenho fino de cada onda acompanha as frequências
  // (graves no meio, agudos nas pontas) e a batida engorda as ondas, acende o brilho e troca a cor.
  #drawWaves(g, w, h, hue, beat, now) {
    const L = this.#levels, t = now / 1000, cy = h / 2, layers = 5, limit = h * 0.4;
    g.save();
    g.globalCompositeOperation = "lighter";
    g.lineJoin = "round";
    for (let j = layers - 1; j >= 0; j--) {
      const start = Math.floor((j / layers) * HALF * 0.85);
      let e = 0;
      for (let k = start; k < start + 10; k++) e += L[Math.min(HALF - 1, k)];
      e /= 10;
      const amp = h * (0.05 + e * 0.45 + beat * 0.07) * (1 - j * 0.07);
      const cycles = 1.1 + j * 0.55, speed = (0.35 + j * 0.17) * (j % 2 ? -1 : 1), phase = t * speed + j * 1.3;
      const hj = (hue + j * 24) % 360;

      g.beginPath();
      for (let x = 0; x <= w + 6; x += 6) {
        const u = Math.min(1, x / w);
        const env = Math.pow(Math.sin(Math.PI * u), 0.7);             // afina nas bordas
        const idx = Math.min(HALF - 1, Math.floor(Math.abs(u - 0.5) * 2 * HALF * 0.9));
        const detail = 0.55 + L[idx] * 0.9;                            // espectro desenhado na onda
        const off = Math.sin(u * Math.PI * 2 * cycles + phase) * amp * env * detail
          + Math.sin(u * Math.PI * 2 * cycles * 2.3 - phase * 1.7) * amp * 0.22 * env;
        const y = cy + limit * Math.tanh(off / limit); // limite suave: nas batidas fortes "achata", não sai da tela
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.lineWidth = Math.max(1, 2.4 - j * 0.3);
      g.strokeStyle = `hsl(${hj} 95% ${66 + beat * 14}% / ${0.9 - j * 0.12})`;
      g.shadowColor = `hsl(${hj} 100% 60%)`;
      g.shadowBlur = 10 + beat * 20;
      g.stroke();

      // Preenchimento suave até a linha do meio, para dar volume
      g.lineTo(w, cy);
      g.lineTo(0, cy);
      g.closePath();
      const fill = g.createLinearGradient(0, cy - amp, 0, cy + amp);
      const a = Math.max(0.02, 0.11 - j * 0.018);
      fill.addColorStop(0, `hsl(${hj} 90% 60% / ${a})`);
      fill.addColorStop(0.5, `hsl(${hj} 90% 60% / 0)`);
      fill.addColorStop(1, `hsl(${hj} 90% 60% / ${a})`);
      g.shadowBlur = 0;
      g.fillStyle = fill;
      g.fill();
    }
    g.restore();
  }

  #frame(now) {
    const g = this.#g;
    if (!g || !this.#w) return;
    const dt = Math.min(4, (now - this.#last) / 16.667); // 1 = um frame a 60 fps
    this.#last = now;

    this.#beat *= Math.pow(0.9, dt);
    const dh = ((this.#targetHue - this.#hue + 540) % 360) - 180;
    this.#hue = (this.#hue + dh * (1 - Math.pow(0.93, dt)) + 360) % 360;
    this.#rot += (0.0015 + this.#energy * 0.006) * dt;

    const w = this.#w, h = this.#h, cx = w / 2, cy = h / 2, hue = this.#hue, beat = this.#beat, bassS = this.#bassS;
    const base = Math.min(w, h);
    const R = base * 0.15 * (1 + bassS * 0.12 + beat * 0.04);
    const maxLen = base * 0.32;

    g.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.shadowBlur = 0;

    // Fundo: brilho radial na cor atual, pulsando com os graves
    const bg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(cx, cy));
    bg.addColorStop(0, `hsl(${hue} 65% ${9 + bassS * 12 + beat * 6}%)`);
    bg.addColorStop(0.5, `hsl(${hue} 55% 4%)`);
    bg.addColorStop(1, "#020203");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    if (this.style === "waves") return this.#drawWaves(g, w, h, hue, beat, now);

    g.save();
    g.translate(cx, cy);
    g.rotate(this.#rot);

    // Barras (um único path → um único stroke com brilho)
    const lw = Math.max(2, ((Math.PI * R) / HALF) * 0.55);
    const r0 = R + lw * 1.8;
    const grad = g.createRadialGradient(0, 0, r0, 0, 0, r0 + maxLen);
    grad.addColorStop(0, `hsl(${hue} 100% ${86 + beat * 10}%)`);
    grad.addColorStop(0.45, `hsl(${(hue + 25) % 360} 95% 66%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360} 95% 56%)`);
    g.beginPath();
    for (let k = 0; k < HALF; k++) {
      const len = lw * 0.15 + this.#levels[k] * maxLen;
      const off = ((k + 0.5) / HALF) * Math.PI;
      for (const a of [-Math.PI / 2 + off, -Math.PI / 2 - off]) {
        const c = Math.cos(a), s = Math.sin(a);
        g.moveTo(c * r0, s * r0);
        g.lineTo(c * (r0 + len), s * (r0 + len));
      }
    }
    g.lineCap = "round";
    g.lineWidth = lw;
    g.strokeStyle = grad;
    g.shadowColor = `hsl(${hue} 100% 60%)`;
    g.shadowBlur = 8 + beat * 22 + bassS * 10;
    g.stroke();

    // Disco central com a capa girando (tipo vinil)
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = "#000";
    g.shadowBlur = 25 + beat * 35;
    g.fill();
    g.shadowBlur = 0;
    if (this.#cover) {
      g.save();
      g.clip();
      const img = this.#cover, side = Math.min(img.width, img.height);
      g.globalAlpha = 0.9;
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, -R, -R, R * 2, R * 2);
      g.globalAlpha = 1;
      const vig = g.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,.55)");
      g.fillStyle = vig;
      g.fillRect(-R, -R, R * 2, R * 2);
      g.restore();
    }
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.lineWidth = 1.5;
    g.strokeStyle = `hsl(${hue} 100% 80% / ${0.35 + beat * 0.6})`;
    g.stroke();
    g.restore();

    // Partículas das batidas
    g.globalCompositeOperation = "lighter";
    const ps = this.#particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.r += p.v * dt;
      p.v *= Math.pow(0.975, dt);
      p.life -= 0.016 * dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      const rr = r0 + 6 + p.r, a = p.a + this.#rot;
      g.beginPath();
      g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, p.size, 0, Math.PI * 2);
      g.fillStyle = `hsl(${(hue + p.hue + 360) % 360} 100% 70% / ${p.life})`;
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
  }

  // ---------- Para o Automix ----------
  // BPM a partir dos intervalos entre batidas (mediana; só responde se o ritmo for consistente)
  get bpm() {
    const b = this.#beatTimes;
    if (b.length < 7 || performance.now() - b.at(-1) > 4000) return 0;
    const iv = [];
    for (let i = 1; i < b.length; i++) {
      const d = (b[i] - b[i - 1]) / 1000;
      if (d > 0.25 && d < 1.6) iv.push(d);
    }
    if (iv.length < 6) return 0;
    iv.sort((x, y) => x - y);
    const med = iv[iv.length >> 1];
    const steady = iv.filter((d) => Math.abs(d / med - Math.round(d / med)) < 0.12).length / iv.length;
    if (steady < 0.6) return 0;
    let bpm = 60 / med;
    while (bpm < 80) bpm *= 2;
    while (bpm > 170) bpm /= 2;
    return Math.round(bpm);
  }

  get insight() {
    const now = performance.now();
    return {
      hasAudio: this.listening,
      bpm: this.bpm,
      sinceBeat: this.#lastBeat && now - this.#lastBeat < 4000 ? (now - this.#lastBeat) / 1000 : null,
      loudness: this.#loud,
      updatedAt: this.#updatedAt,
    };
  }

  // Música nova: esquece as batidas da anterior
  resetTempo() { this.#beatTimes = []; }

  // Para a barra de progresso em ondas: n barras (0..1) espelhadas — graves no centro,
  // agudos nas pontas — tiradas do mesmo espectro suavizado do visualizador
  bars(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = Math.abs((i / Math.max(1, n - 1)) * 2 - 1);
      out[i] = this.#levels[Math.min(HALF - 1, Math.round(t * (HALF - 1) * 0.85))];
    }
    return out;
  }

  // Última batida (horário) e a cor-alvo, que pula a cada batida e parte da cor da capa
  get beatInfo() { return { at: this.#lastBeat, hue: this.#targetHue, listening: this.listening }; }

  // Para diagnóstico/testes
  get stats() {
    return { bpm: this.bpm, loud: +this.#loud.toFixed(3), hasAudio: this.hasAudio, listening: this.listening, fromDecks: this.#extFresh(), bass: +this.#bass.toFixed(3), energy: +this.#energy.toFixed(3), hue: Math.round(this.#hue), beat: +this.#beat.toFixed(2), particles: this.#particles.length };
  }
}

export const viz = new Visualizer();
