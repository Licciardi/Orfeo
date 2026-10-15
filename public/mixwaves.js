// Ondas da transição: durante a mistura, desenha a "onda" de cada música — a que sai e a que
// entra — rolando da direita para a esquerda, cada uma na cor da sua capa, como num software de
// DJ. A altura vem do som real de cada deck (app desktop) vezes o volume dele na mistura; então
// dá para ver uma diminuindo enquanto a outra cresce, até se cruzarem.
const SAMPLES = 150; // ~2,5 s de história na tela

export class MixWaves {
  #canvas; #g; #raf = 0; #dpr = 1; #w = 0; #h = 0;
  #hist = [new Float32Array(SAMPLES), new Float32Array(SAMPLES)]; // [sai, entra]
  #colors = ["hsl(0 0% 80%)", "hsl(0 0% 80%)"];
  #source; // () => { gOut, gIn, levelOut, levelIn } | null

  constructor(canvas, source) {
    this.#canvas = canvas;
    this.#g = canvas.getContext("2d");
    this.#source = source;
    new ResizeObserver(() => this.#resize()).observe(canvas);
  }

  // Cores das capas ("hsl(H S% L%)" escuras, do painel) → versões vivas para as ondas
  setColors(outColor, inColor) {
    const vivid = (c) => {
      const h = parseFloat(String(c).replace(/^hsl\(/, ""));
      return Number.isNaN(h) ? "hsl(0 0% 85%)" : `hsl(${Math.round(h)} 85% 64%)`;
    };
    this.#colors = [vivid(outColor), vivid(inColor)];
  }

  start() {
    if (this.#raf) return;
    this.#hist.forEach((a) => a.fill(0));
    const loop = () => { this.#draw(); this.#raf = requestAnimationFrame(loop); };
    this.#raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #resize() {
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#w = this.#canvas.clientWidth;
    this.#h = this.#canvas.clientHeight;
    this.#canvas.width = Math.round(this.#w * this.#dpr);
    this.#canvas.height = Math.round(this.#h * this.#dpr);
  }

  #draw() {
    const s = this.#source();
    const t = performance.now() / 1000;
    // Sem som por deck (navegador comum): uma onda "de mentira", só para mostrar o cruzamento
    const fake = (k) => 0.45 + 0.25 * Math.sin(t * 7 + k * 2) * Math.sin(t * 2.3 + k);
    const levels = [
      (s?.levelOut ?? fake(0)) * (s?.gOut ?? 0),
      (s?.levelIn ?? fake(1)) * (s?.gIn ?? 0),
    ];
    this.#hist.forEach((a, k) => { a.copyWithin(0, 1); a[SAMPLES - 1] = Math.min(1, levels[k] * 1.25); });

    const g = this.#g, w = this.#w, h = this.#h, mid = h / 2;
    if (!w || !h) return;
    g.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter"; // onde as duas se sobrepõem, as cores se somam

    this.#hist.forEach((a, k) => {
      const color = this.#colors[k];
      g.beginPath();
      // Contorno de cima (esquerda → direita) e de baixo (direita → esquerda): onda espelhada
      for (let i = 0; i < SAMPLES; i++) {
        const x = (i / (SAMPLES - 1)) * w, y = mid - a[i] * (mid - 2);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      for (let i = SAMPLES - 1; i >= 0; i--) g.lineTo((i / (SAMPLES - 1)) * w, mid + a[i] * (mid - 2));
      g.closePath();
      const fill = g.createLinearGradient(0, 0, w, 0);
      fill.addColorStop(0, color.replace(")", " / 0)"));    // some na esquerda (passado)
      fill.addColorStop(0.35, color.replace(")", " / .45)"));
      fill.addColorStop(1, color.replace(")", " / .9)"));
      g.fillStyle = fill;
      g.shadowColor = color;
      g.shadowBlur = 8;
      g.fill();
    });

    g.globalCompositeOperation = "source-over";
    g.shadowBlur = 0;
    g.fillStyle = "#ffffff26";
    g.fillRect(0, mid - 0.5, w, 1); // linha do meio
  }
}
