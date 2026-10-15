// Peças compartilhadas da Jam e dos Amigos: conexão PeerJS e validação de dados de terceiros.
//
// Tudo que chega de outro computador é tratado como não confiável: só entra no app depois de
// passar por estas funções (tamanhos limitados, formatos conferidos, imagens só de hosts seguros).

export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I para não confundir
export const randomCode = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");
export const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- PeerJS ----------
export async function loadPeerJS() {
  if (window.Peer) return;
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "/vendor/peerjs.min.js"; // PeerJS 1.5.5 (MIT), copiado de node_modules
    s.onload = ok;
    s.onerror = () => fail(new Error("Não deu para carregar o módulo de conexão."));
    document.head.append(s);
  });
}

export function openPeer(id) {
  return new Promise((ok, fail) => {
    const peer = id ? new window.Peer(id, { debug: 0 }) : new window.Peer({ debug: 0 });
    peer.once("open", () => ok(peer));
    peer.once("error", (e) => { peer.destroy(); fail(e); });
  });
}

export function friendlyError(e, notFound = "Não achei esse código. Confira e tente de novo.") {
  const map = {
    "peer-unavailable": notFound,
    "unavailable-id": "Esse código já está em uso.",
    network: "Sem conexão com o servidor. Verifique a internet.",
    "server-error": "O servidor não respondeu. Tente de novo em instantes.",
    "socket-error": "Sem conexão com o servidor. Verifique a internet.",
    "browser-incompatible": "Este navegador não suporta conexões diretas.",
  };
  return Object.assign(new Error(map[e?.type] || e?.message || "Erro de conexão."), { type: e?.type });
}

// ---------- Validação ----------
export const str = (v, max) => String(v ?? "").slice(0, max);
export const cleanName = (v) => str(v, 30).trim() || "Convidado";
export const toInt = (v) => (Number.isInteger(v) ? v : -1);

const PHOTO_MAX_CHARS = 1_450_000; // ~1 MB em base64 (GIF animado)
export const safePhoto = (v) => (typeof v === "string" && v.length < PHOTO_MAX_CHARS && /^data:image\/(jpeg|png|webp|gif);base64,[\w+/=]+$/.test(v) ? v : "");

// Capas só de servidores de imagem do YouTube/Google: uma URL qualquer vinda de outra pessoa
// faria seu app carregar uma imagem de um site desconhecido (que veria seu IP).
const THUMB_HOSTS = /^(i\d?\.ytimg\.com|[\w-]+\.googleusercontent\.com|[\w-]+\.ggpht\.com)$/;
export function safeThumb(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && THUMB_HOSTS.test(u.hostname) ? u.href.slice(0, 500) : null;
  } catch { return null; }
}

export function cleanTrack(t) {
  if (!t || typeof t !== "object" || !/^[\w-]{11}$/.test(t.id)) return null;
  const thumb = safeThumb(t.thumb) || `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`;
  const track = { id: t.id, title: str(t.title, 200), artist: str(t.artist, 120), duration: str(t.duration, 10), thumb };
  if (typeof t.addedBy === "string" && t.addedBy) track.addedBy = str(t.addedBy, 80); // quem adicionou na Jam
  if (t.auto === true) track.auto = true; // veio do autoplay
  return track;
}
export const cleanTracks = (list) => (Array.isArray(list) ? list.slice(0, 500).map(cleanTrack).filter(Boolean) : []);
