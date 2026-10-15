// Gera electron/icon.png (256x256) sem dependências: uma lira grega dourada (o instrumento de
// Orfeu) sobre um disco em degradê rosa → roxo, as cores do Orfeo.
// Uso: node electron/make-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 256, SUB = 4; // 4×4 amostras por pixel = bordas suaves

// ---------- Formas (distâncias em pixels) ----------
const bez = (p0, p1, p2, p3, n = 80) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
});
function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

// Braços da lira: sobem da base abrindo para fora e se curvam para dentro no alto,
// terminando em pontas que se abrem como chifres
const armL = bez([104, 192], [52, 176], [44, 98], [86, 66]).concat(bez([86, 66], [96, 58], [92, 46], [80, 44], 20));
const armR = armL.map(([x, y]) => [S - x, y]);
const lyre = [
  { pts: armL, w: 15 },
  { pts: armR, w: 15 },
  { pts: [[100, 196], [156, 196]], w: 16 },  // base
  { pts: [[74, 88], [182, 88]], w: 11 },     // travessa de cima
];
const strings = [110, 128, 146].map((x) => ({ pts: [[x, 92], [x, 190]], w: 4 }));

function sample(x, y) {
  const c = S / 2, d = Math.hypot(x - c, y - c);
  if (d > 122) return null; // fora do disco
  // fundo: degradê diagonal rosa → roxo, um pouco mais escuro nas bordas
  const t = (x + y) / (2 * S), edge = 1 - Math.max(0, (d - 90) / 32) * 0.25;
  let col = [(255 + (106 - 255) * t) * edge, (77 + (61 - 77) * t) * edge, (109 + (240 - 109) * t) * edge];
  // sombra suave da lira
  if (lyre.some((s) => distToPolyline(x - 3, y - 5, s.pts) < s.w / 2 + 2)) col = col.map((v) => v * 0.72);
  // cordas (creme) e corpo (ouro com degradê vertical)
  if (strings.some((s) => distToPolyline(x, y, s.pts) < s.w / 2)) col = [255, 240, 205];
  if (lyre.some((s) => distToPolyline(x, y, s.pts) < s.w / 2)) {
    const g = (y - 40) / 170;
    col = [255 - 18 * g, 214 - 70 * g, 92 - 50 * g];
  }
  return col;
}

// ---------- Rasteriza com supersampling ----------
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const c = sample(x + (sx + 0.5) / SUB, y + (sy + 0.5) / SUB);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    if (a) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a; }
    raw[o + 3] = Math.round((a / (SUB * SUB)) * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA

fs.writeFileSync(path.join(__dirname, "icon.png"), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log("icon.png gerado (lira)");
