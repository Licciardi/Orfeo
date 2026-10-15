// Barra de progresso em ondas de barras.
//
// Cada barra tem um "formato" fixo por música (parece a forma de onda da faixa) multiplicado pelo
// som do momento (espectro do visualizador: graves no centro, agudos nas pontas). A cada batida
// as barras dão um pulo e a cor muda. A parte já tocada fica colorida; o resto, apagado.
// Sem análise de áudio (navegador sem visualizador), as barras ondulam sozinhas enquanto toca.
const BAR = 3, GAP = 2;

export class ProgressWave {
  #canvas; #g; #dpr = 1; #w = 0; #h = 0; #raf = 0;
  #src;                 // () => { progress 0..1, playing, trackId, bars(n), beat: { at, hue, listening } }
  #shape = null; #shapeFor = "";
  #live = null;         // altura atual de cada barra (suavizada)
  #hue = 340; #lastBeat = 0; #pulse = 0; #last = 0;

  constructor(canvas, source) {
    this.#canvas = canvas;
    this.#g = canvas.getContext("2d");
    this.#src = source;
    new ResizeObserver(() => this.#resize()).observe(canvas);
    const loop = (now) => { this.#draw(now); this.#raf = requestAnimationFrame(loop); };
    this.#raf = requestAnimationFrame(loop);
  }

  #resize() {
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#w = this.#canvas.clientWidth;
    this.#h = this.#canvas.clientHeight;
    this.#canvas.width = Math.round(this.#w * this.#dpr);
    this.#canvas.height = Math.round(this.#h * this.#dpr);
    this.#shapeFor = ""; // recalcula o formato para a nova quantidade de barras
  }

  // Formato fixo por música: ruído suave a partir do ID (a mesma música sempre tem o mesmo desenho)
  #shapeOf(id, n) {
    if (this.#shapeFor === `${id}:${n}` && this.#shape) return this.#shape;
    let seed = 2166136261;
    for (const ch of String(id || "orfeo")) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
    const raw = Array.from({ length: n }, rnd);
    this.#shape = Float32Array.from(raw, (_, i) => {
      const a = raw[Math.max(0, i - 1)], b = raw[i], c = raw[Math.min(n - 1, i + 1)];
      return 0.35 + 0.65 * ((a + 2 * b + c) / 4);
    });
    this.#shapeFor = `${id}:${n}`;
    this.#live = new Float32Array(n);
    return this.#shape;
  }

  #draw(now) {
    const w = this.#w, h = this.#h, g = this.#g;
    if (!w || !h) return;
    const dt = Math.min(4, (now - (this.#last || now)) / 16.667);
    this.#last = now;
    const s = this.#src();
    const n = Math.max(8, Math.floor((w + GAP) / (BAR + GAP)));
    const shape = this.#shapeOf(s.trackId, n);
    const live = this.#live;

    // Batida nova → pulo nas barras + cor nova (a cor-alvo vem do visualizador)
    const beat = s.beat;
    if (beat.at && beat.at !== this.#lastBeat && s.playing) { this.#lastBeat = beat.at; this.#pulse = 1; }
    this.#pulse *= Math.pow(0.88, dt);
    let target = beat.hue;
    if (!beat.listening && s.playing) target = (this.#hue + 0.15 * dt) % 360; // sem áudio: cor vai girando devagar
    const dh = ((target - this.#hue + 540) % 360) - 180;
    this.#hue = (this.#hue + dh * (1 - Math.pow(0.85, dt)) + 360) % 360;

    // Altura de cada barra: som do momento (ou ondulação própria), com subida rápida e descida suave
    const spectrum = beat.listening ? s.bars(n) : null;
    const t = now / 1000;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (s.playing) {
        v = spectrum ? Math.min(1, spectrum[i] * 1.35)
          : 0.35 + 0.3 * Math.sin(t * 3.1 + i * 0.45) * Math.sin(t * 1.3 + i * 0.13);
      }
      const k = v > live[i] ? 1 - Math.pow(0.4, dt) : 1 - Math.pow(0.86, dt);
      live[i] += (v - live[i]) * k;
    }

    g.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const mid = h / 2, played = s.progress * w;
    const offset = (w - (n * (BAR + GAP) - GAP)) / 2; // centraliza as barras
    const hot = `hsl(${this.#hue} 95% ${62 + this.#pulse * 12}%)`;
    for (let i = 0; i < n; i++) {
      const x = offset + i * (BAR + GAP);
      const amp = shape[i] * (0.3 + 0.7 * live[i]) + this.#pulse * 0.18 * shape[i];
      const bh = Math.max(2, Math.min(h, amp * h));
      const isPlayed = x + BAR / 2 <= played;
      g.fillStyle = isPlayed ? hot : "rgb(255 255 255 / .16)";
      g.shadowColor = isPlayed ? hot : "transparent";
      g.shadowBlur = isPlayed ? 4 + this.#pulse * 8 : 0;
      g.beginPath();
      g.roundRect(x, mid - bh / 2, BAR, bh, 1.5);
      g.fill();
    }
    g.shadowBlur = 0;
  }
}
