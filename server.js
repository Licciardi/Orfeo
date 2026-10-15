// Servidor estático mínimo (sem dependências). O player do YouTube não funciona via file://,
// por isso o app precisa ser servido por http://localhost — tanto no navegador quanto no Electron.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

// ---------- Busca sem chave de API (InnerTube, a API interna que o site do YouTube usa) ----------
// Não é oficial: se o YouTube mudar o formato, é aqui que se ajusta.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CLIENTS = {
  music: { host: "https://music.youtube.com", name: "WEB_REMIX", version: "1.20250929.03.00" },
  video: { host: "https://www.youtube.com", name: "WEB", version: "2.20250929.01.00" },
};
const SONGS_FILTER = "EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D"; // filtro "Músicas" do YT Music

// Pega a versão atual do cliente na página do YouTube (cacheada); se falhar, usa a fixa acima.
const versionCache = {};
async function clientVersion(kind) {
  const c = CLIENTS[kind];
  if (versionCache[kind]) return versionCache[kind];
  try {
    const html = await (await fetch(c.host, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR" } })).text();
    versionCache[kind] = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || c.version;
  } catch { versionCache[kind] = c.version; }
  return versionCache[kind];
}

async function innertube(kind, endpoint, body) {
  const c = CLIENTS[kind];
  const res = await fetch(`${c.host}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: c.host, Referer: c.host + "/" },
    body: JSON.stringify({
      context: { client: { clientName: c.name, clientVersion: await clientVersion(kind), hl: "pt", gl: "BR" } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`YouTube respondeu ${res.status}`);
  return res.json();
}

// Procura recursivamente todos os objetos com a chave `key` (mais robusto que caminhos fixos).
function findAll(node, key, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, key, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else findAll(v, key, out);
    }
  }
  return out;
}
const runsText = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";
const bestThumb = (list = []) => list[list.length - 1]?.url?.replace(/=w\d+-h\d+.*/, "=w226-h226-l90-rj");

function parseMusic(data) {
  return findAll(data, "musicResponsiveListItemRenderer").map((it) => {
    const id = it.playlistItemData?.videoId || findAll(it, "watchEndpoint")[0]?.videoId;
    const cols = (it.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
    // 2ª coluna: "Artista • Álbum • 3:45" — pega o que vem antes do primeiro " • "
    const second = cols[1] || [];
    const sep = second.findIndex((r) => r.text === " • ");
    const artist = (sep >= 0 ? second.slice(0, sep) : second).map((r) => r.text).join("");
    const duration = second.map((r) => r.text).find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t)) || "";
    return {
      id,
      title: cols[0]?.map((r) => r.text).join("") || "",
      artist,
      duration,
      thumb: bestThumb(it.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    };
  }).filter((t) => t.id && t.title);
}

function parseVideos(data) {
  return findAll(data, "videoRenderer").map((v) => ({
    id: v.videoId,
    title: runsText(v.title),
    artist: runsText(v.ownerText || v.longBylineText).replace(/ - Topic$/, ""),
    duration: runsText(v.lengthText),
    thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
  })).filter((t) => t.id && t.title && t.duration); // sem duração = live/playlist
}

// Autoplay: o "rádio" do YouTube Music a partir de uma música (mesma lista que o site usa
// quando a fila acaba). Devolve as faixas parecidas, sem a própria música.
async function radio(videoId) {
  const data = await innertube("music", "next", {
    videoId, playlistId: "RDAMVM" + videoId, isAudioOnly: true, enablePersistentPlaylistPanel: true,
  });
  return findAll(data, "playlistPanelVideoRenderer").map((v) => {
    const byline = v.longBylineText?.runs || [];
    const sep = byline.findIndex((r) => r.text === " • ");
    return {
      id: v.videoId,
      title: runsText(v.title),
      artist: (sep >= 0 ? byline.slice(0, sep) : byline).map((r) => r.text).join("") || runsText(v.shortBylineText),
      duration: runsText(v.lengthText),
      thumb: bestThumb(v.thumbnail?.thumbnails) || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    };
  }).filter((t) => t.id && t.title && t.id !== videoId);
}

async function search(q, type) {
  if (type === "videos") return parseVideos(await innertube("video", "search", { query: q }));
  const tracks = parseMusic(await innertube("music", "search", { query: q, params: SONGS_FILTER }));
  // Se o YT Music não devolver nada (ou mudar o formato), cai para a busca normal do YouTube
  return tracks.length ? tracks : parseVideos(await innertube("video", "search", { query: q }));
}

// Repassa a capa pela mesma origem do app, para o navegador deixar ler os pixels (cor da capa).
// Só hosts de imagem do YouTube/Google — não é um proxy aberto.
const THUMB_HOSTS = /^(i\d?\.ytimg\.com|[\w-]+\.googleusercontent\.com|[\w-]+\.ggpht\.com)$/;
async function thumb(res, raw) {
  let target;
  try { target = new URL(raw); } catch {}
  if (!target || target.protocol !== "https:" || !THUMB_HOSTS.test(target.hostname)) {
    return res.writeHead(400).end("URL de imagem não permitida");
  }
  const r = await fetch(target, { headers: { "User-Agent": UA } });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return res.writeHead(502).end();
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ---------- Letras (LRCLIB: base aberta, sem chave, com letras sincronizadas) ----------
const LRCLIB = "https://lrclib.net/api";
const LRC_HEADERS = { "User-Agent": "Orfeo/1.0 (player de musica pessoal)" };
const NOISE = /official|oficial|video|vídeo|clipe|clip|lyric|letra|audio|áudio|visualizer|remaster|hd|4k|mv|hq/i;

// "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" → "Never Gonna Give You Up"
function cleanTitle(title, artist) {
  let t = title.replace(/[([][^)\]]*[)\]]/g, (m) => (NOISE.test(m) ? "" : m));
  let a = artist;
  const parts = t.split(/\s+[-–—|]\s+/);
  if (parts.length > 1) {
    const first = parts[0].toLowerCase();
    if (first.includes(artist.toLowerCase()) || artist.toLowerCase().includes(first)) t = parts.slice(1).join(" - ");
    else { a = parts[0]; t = parts.slice(1).join(" - "); } // canal genérico: artista vem no título
  }
  t = t.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  // só o artista principal ("A, B", "A & B", "A e B", "A x B", "A feat. B") — palavras inteiras, senão "Daft" vira "Da"
  a = a.split(/\s*(?:,|&)\s*|\s+(?:e|x|feat\.?|ft\.?|part\.?)\s+/i)[0].trim();
  return { title: t, artist: a };
}

// O LRCLIB às vezes oscila (503/lentidão): tenta de novo uma vez antes de desistir
async function lrc(path, params, tries = 2) {
  try {
    const r = await fetch(`${LRCLIB}/${path}?${new URLSearchParams(params)}`, { headers: LRC_HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`LRCLIB respondeu ${r.status}`);
    return await r.json();
  } catch (err) {
    if (tries <= 1) throw err;
    await new Promise((ok) => setTimeout(ok, 600));
    return lrc(path, params, tries - 1);
  }
}

// Descarta entradas quebradas (ex.: "[00:00.00]probe"): precisa ter algumas linhas de verdade
const realLines = (txt) => (txt || "").split("\n").filter((l) => l.replace(/\[[^\]]*\]/g, "").trim().length > 1).length;
const usable = (d) => d && (d.instrumental || realLines(d.syncedLyrics) >= 4 || realLines(d.plainLyrics) >= 4);

async function lyrics(rawTitle, rawArtist, duration) {
  const { title, artist } = cleanTitle(rawTitle, rawArtist);
  const shape = (d) => d && { synced: d.syncedLyrics || null, plain: d.plainLyrics || null, instrumental: !!d.instrumental, match: `${d.artistName} — ${d.trackName}` };

  // 1) Busca exata (rápida) quando sabemos a duração
  if (duration) {
    const exact = await lrc("get", { track_name: title, artist_name: artist, duration: Math.round(duration) }).catch(() => null);
    if (usable(exact)) return shape(exact);
  }
  // 2) Busca aproximada: prefere sincronizada e com duração mais próxima
  let list = await lrc("search", { track_name: title, artist_name: artist });
  if (!list?.length) list = await lrc("search", { q: `${artist} ${title}` });
  if (!list?.length) return null;
  const norm = (x) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(); // sem acentos
  const sameArtist = (d) => norm(d.artistName || "").includes(norm(artist)); // ex.: "Legião Urbana" ⊇ "legiao urbana"
  const score = (d) => (sameArtist(d) ? 0 : 100) + (d.syncedLyrics ? 0 : 30) + (duration ? Math.abs(d.duration - duration) : 0);
  const best = list.filter(usable).sort((x, y) => score(x) - score(y))[0];
  if (!best) return null;
  // Duração muito diferente = outra versão: a letra serve, mas o tempo não bate → sem sincronização
  if (duration && Math.abs(best.duration - duration) > 20) return { ...shape(best), synced: null };
  return shape(best);
}

async function api(req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return send(400, { error: "Busca vazia" });
      return send(200, { items: await search(q, url.searchParams.get("type")) });
    }
    if (url.pathname === "/api/thumb") return thumb(res, url.searchParams.get("url"));
    if (url.pathname === "/api/radio") {
      const id = url.searchParams.get("id") || "";
      if (!/^[\w-]{11}$/.test(id)) return send(400, { error: "ID de vídeo inválido" });
      return send(200, { items: await radio(id) });
    }
    if (url.pathname === "/api/lyrics") {
      const p = url.searchParams;
      if (!p.get("title")) return send(400, { error: "Faltou o título" });
      return send(200, { lyrics: await lyrics(p.get("title"), p.get("artist") || "", +p.get("duration") || 0) });
    }
    send(404, { error: "Rota desconhecida" });
  } catch (err) {
    send(502, { error: "Falha na busca: " + err.message });
  }
}

// Só atende quem fala com ele pelo nome certo e, na /api/, só a própria página do Orfeo:
//  - Host diferente de localhost/127.0.0.1:PORTA → recusa (bloqueia "DNS rebinding", em que um site
//    malicioso faz o próprio domínio apontar para 127.0.0.1 para ler este servidor);
//  - /api/ chamada por outro site aberto no navegador (Origin ou Sec-Fetch-Site de fora) → recusa.
function isTrusted(req) {
  const port = req.socket.localPort;
  const host = (req.headers.host || "").toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return false;
  return true;
}
function isSameOriginApiCall(req) {
  const port = req.socket.localPort;
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return false;
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

function handler(req, res) {
  if (!isTrusted(req)) return res.writeHead(403).end("Forbidden");
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    if (!isSameOriginApiCall(req)) return res.writeHead(403).end("Forbidden");
    return api(req, res, url);
  }
  const urlPath = decodeURIComponent(url.pathname);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  // SPA: qualquer rota sem extensão cai no index.html
  if (!path.extname(file) || !fs.existsSync(file)) file = path.join(ROOT, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

// Sobe o servidor só em 127.0.0.1 e resolve com a porta real.
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer(process.env.PORT || 5173).then(({ port }) => console.log(`Orfeo rodando em http://localhost:${port}`));
}
