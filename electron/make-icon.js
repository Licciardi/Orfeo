// Gera electron/icon.png (256x256) sem dependências: um disco em degradê com anel, no estilo do logo ◉.
// Uso: node electron/make-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 256, c = S / 2;
const raw = Buffer.alloc((S * 4 + 1) * S);
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const from = [0xff, 0x4d, 0x6d], to = [0x6a, 0x3d, 0xf0]; // mesmas cores do CSS

for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filtro "none"
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const t = (x + y) / (2 * S);
    let rgb = [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
    // anti-aliasing simples na borda externa
    let alpha = Math.max(0, Math.min(1, 120 - d));
    if (d < 44 || (d > 66 && d < 82)) rgb = [255, 255, 255]; // miolo + anel brancos
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = Math.round(alpha * 255);
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

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, "icon.png"), png);
console.log("icon.png gerado");
