// Amigos: código de amigo fixo, pedidos de amizade, quem está online e o que está ouvindo,
// e convite para Jam com 1 clique.
//
// Cada Orfeo se registra no servidor do PeerJS como "orfeo-u-<SEU CÓDIGO>" e conversa direto
// (WebRTC) com os amigos — nenhum servidor nosso guarda lista de amigos ou mensagens.
//
// Segurança:
//  - Toda amizade tem uma CHAVE secreta (128 bits) criada no pedido e guardada pelos dois.
//    Só quem tem a chave é tratado como amigo — saber o seu código não basta para se passar
//    por um amigo seu.
//  - Quem não é amigo só pode mandar "pedido de amizade" (que você aceita ou recusa).
//  - Tudo que chega é validado (nomes, fotos, músicas) antes de aparecer na tela.
//
// Mensagens:
//   { type: "friend-request", code, key, name, photo }   pedido (repetido até ser entregue)
//   { type: "hello", code, key, name, photo, ...presença } amigo autenticado (também = aceite)
//   { type: "presence", track, playing, jam }             o que está tocando / Jam aberta
//   { type: "profile", name, photo }                       mudou nome/foto
//   { type: "friend-decline" } | { type: "unfriend" } | { type: "jam-invite", jam }
import { player, profile, history, Storage, Emitter } from "./platform.js";
import { jam } from "./jam.js";
import { ALPHABET, randomCode, randomKey, loadPeerJS, openPeer, str, cleanName, safePhoto, cleanTrack, cleanTags, cleanTopArtists } from "./net.js";

const PREFIX = "orfeo-u-";
const RETRY_MS = 30_000;     // tenta reconectar amigos / reenviar pedidos a cada 30 s
const MAX_FRIENDS = 50;
const MAX_INCOMING = 20;
const STORE_PHOTO_MAX = 150_000; // fotos de amigos guardadas para mostrar offline (GIFs grandes, não)

const isCode = (c) => typeof c === "string" && c.length === 8 && [...c].every((ch) => ALPHABET.includes(ch));
const isKey = (k) => typeof k === "string" && /^[0-9a-f]{32}$/.test(k);
export const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const parseCode = (raw) => String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");

class Friends extends Emitter {
  code = Storage.get("friends.code", null);
  list = Storage.get("friends.list", []);          // [{ code, key, name, photo }]
  outgoing = Storage.get("friends.outgoing", []);  // pedidos que você mandou: [{ code, key }]
  incoming = [];                                   // pedidos recebidos (aguardando você)
  share = Storage.get("friends.share", true);      // mostrar o que estou ouvindo
  status = "offline";                              // offline | connecting | online
  presence = new Map();                            // code → { online, name, photo, track, playing, jam }

  #peer = null;
  #conns = new Map();   // code → conexão autenticada com o amigo
  #dialing = new Set();
  #timer = 0;
  #debounce = 0;

  constructor() {
    super();
    if (!isCode(this.code)) { this.code = randomCode(8); Storage.set("friends.code", this.code); }
    // Mudou a música / play-pause / Jam → avisa os amigos (agrupando rajadas de eventos)
    const push = () => { clearTimeout(this.#debounce); this.#debounce = setTimeout(() => this.#sendAll({ type: "presence", ...this.#presence() }), 400); };
    player.on("track", push);
    player.on("state", push);
    jam.on("change", push);
    profile.on("change", () => this.#sendAll({ type: "profile", ...this.#me() }));
  }

  get onlineCount() { return [...this.presence.values()].filter((p) => p.online).length; }

  // ---------- Conexão com o servidor de encontros ----------
  async start() {
    if (this.#peer) return;
    this.#setStatus("connecting");
    try {
      await loadPeerJS();
      this.#peer = await openPeer(PREFIX + this.code);
    } catch (e) {
      this.#peer = null;
      this.#setStatus("offline");
      // "unavailable-id": o Orfeo já está aberto em outro lugar com este código — tenta de novo depois
      setTimeout(() => this.start(), e?.type === "unavailable-id" ? 60_000 : RETRY_MS);
      return;
    }
    this.#peer.on("connection", (conn) => this.#wire(conn));
    this.#peer.on("disconnected", () => { if (this.#peer && !this.#peer.destroyed) this.#peer.reconnect(); });
    this.#peer.on("error", () => {}); // "amigo offline" chega aqui: é normal, a lista mostra
    this.#setStatus("online");
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#tick(), RETRY_MS);
    this.#tick();
  }

  // Liga para quem precisa: amigos ainda não conectados e pedidos ainda não respondidos.
  // Entre dois amigos, só o de código "menor" liga — evita conexões duplicadas.
  #tick() {
    if (!this.#peer || this.#peer.disconnected) return;
    for (const f of this.list) if (!this.#conns.has(f.code) && this.code < f.code) this.#dial(f.code, { type: "hello", key: f.key });
    for (const r of this.outgoing) if (!this.#conns.has(r.code)) this.#dial(r.code, { type: "friend-request", key: r.key });
  }

  #dial(code, first) {
    if (this.#dialing.has(code)) return;
    this.#dialing.add(code);
    const conn = this.#peer.connect(PREFIX + code, { reliable: true });
    // Pedido de amizade: mostra na tela se chegou ou não (antes ficava "esperando" sem dar pista)
    const mark = (state) => {
      const req = first.type === "friend-request" && this.outgoing.find((r) => r.code === code);
      if (!req || req.state === state || (req.state === "delivered" && state === "unreachable")) return;
      req.state = state;
      this.#save();
      this.emit("change");
    };
    const giveUp = setTimeout(() => {
      this.#dialing.delete(code);
      try { conn.close(); } catch {}
      mark("unreachable"); // app do amigo não respondeu: fechado, offline ou versão antiga
    }, 12_000);
    conn.on("open", () => {
      clearTimeout(giveUp);
      this.#dialing.delete(code);
      this.#wire(conn);
      this.#send(conn, { ...first, code: this.code, ...this.#me(), ...(first.type === "hello" ? this.#presence() : {}), type: first.type });
      mark("delivered");
    });
    conn.on("error", () => { clearTimeout(giveUp); this.#dialing.delete(code); mark("unreachable"); });
  }

  #wire(conn) {
    conn.on("data", (msg) => this.#onMessage(conn, msg));
    const drop = () => {
      const code = this.#codeOf(conn);
      if (code && this.#conns.get(code) === conn) {
        this.#conns.delete(code);
        const p = this.presence.get(code);
        if (p) { p.online = false; p.track = null; p.playing = false; p.jam = null; }
        this.emit("change");
      }
      // Pedidos recebidos continuam na tela mesmo se a conexão cair (quem pediu reenvia a cada 30 s)
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  // Quem está do outro lado é quem registrou o ID "orfeo-u-<código>" no servidor
  #codeOf(conn) {
    const c = String(conn.peer || "");
    return c.startsWith(PREFIX) ? c.slice(PREFIX.length) : null;
  }

  // ---------- Mensagens ----------
  #onMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    const code = this.#codeOf(conn);
    if (!isCode(code) || code === this.code || (msg.code !== undefined && msg.code !== code)) return;
    const friend = this.list.find((f) => f.code === code);
    const authed = friend && this.#conns.get(code) === conn;

    switch (msg.type) {
      case "hello": {
        if (!isKey(msg.key)) return;
        let f = friend && friend.key === msg.key ? friend : null;
        // "hello" com a chave do nosso pedido = o amigo aceitou
        const req = this.outgoing.find((r) => r.code === code && r.key === msg.key);
        if (!f && req) {
          f = { code, key: msg.key, name: cleanName(msg.name), photo: "" };
          this.list.push(f);
          this.outgoing = this.outgoing.filter((r) => r !== req);
          this.#save();
          this.emit("toast", `${f.name} aceitou seu pedido de amizade`);
        }
        if (!f) return; // chave errada: não é amigo (ou alguém tentando se passar por um)
        const already = this.#conns.get(code);
        if (already && already !== conn) { try { already.close(); } catch {} }
        const firstTime = !already || already !== conn;
        this.#conns.set(code, conn);
        this.#updateFriend(f, msg);
        this.#applyPresence(code, msg);
        // Responde o "hello" para o outro lado também nos reconhecer
        if (firstTime && !msg.reply) this.#send(conn, { type: "hello", reply: true, code: this.code, key: f.key, ...this.#me(), ...this.#presence() });
        this.emit("change");
        return;
      }
      case "friend-request": {
        if (!isKey(msg.key)) return;
        // Já somos amigos com essa chave (o aceite ainda não tinha chegado): só confirma
        if (friend && friend.key === msg.key) {
          this.#conns.set(code, conn);
          this.#send(conn, { type: "hello", code: this.code, key: friend.key, ...this.#me(), ...this.#presence() });
          this.#applyPresence(code, msg);
          this.emit("change");
          return;
        }
        // Os dois se adicionaram ao mesmo tempo: aceita, usando a mesma chave dos dois lados
        const mine = this.outgoing.find((r) => r.code === code);
        if (mine) {
          const key = mine.key < msg.key ? mine.key : msg.key;
          this.outgoing = this.outgoing.filter((r) => r !== mine);
          return this.#becomeFriends(conn, code, key, msg);
        }
        const existing = this.incoming.find((r) => r.code === code);
        if (existing) { existing.conn = conn; existing.key = msg.key; return; }
        if (this.incoming.length >= MAX_INCOMING) return;
        const name = cleanName(msg.name);
        this.incoming.push({ code, key: msg.key, name, photo: safePhoto(msg.photo), conn });
        this.emit("toast", `${name} quer ser seu amigo`);
        this.emit("change");
        return;
      }
      case "friend-decline": {
        const before = this.outgoing.length;
        this.outgoing = this.outgoing.filter((r) => r.code !== code);
        if (this.outgoing.length !== before) { this.#save(); this.emit("change"); }
        return;
      }
    }

    if (!authed) return; // daqui pra baixo: só amigos autenticados
    switch (msg.type) {
      case "presence": this.#applyPresence(code, msg); this.emit("change"); return;
      case "profile": this.#updateFriend(friend, msg); this.#applyPresence(code, msg); this.emit("change"); return;
      case "unfriend": this.#forget(code); this.emit("change"); return;
      case "jam-invite": {
        const jamCode = str(msg.jam, 6).toUpperCase();
        if (/^[A-Z0-9]{6}$/.test(jamCode)) this.emit("invite", { name: friend.name, photo: this.presence.get(code)?.photo || friend.photo, jam: jamCode });
        return;
      }
    }
  }

  #becomeFriends(conn, code, key, msg) {
    if (this.list.length >= MAX_FRIENDS) return;
    const f = { code, key, name: cleanName(msg.name), photo: "" };
    this.list = this.list.filter((x) => x.code !== code);
    this.list.push(f);
    this.#updateFriend(f, msg);
    this.#save();
    this.#conns.set(code, conn);
    this.#send(conn, { type: "hello", code: this.code, key, ...this.#me(), ...this.#presence() });
    this.#applyPresence(code, msg);
    this.emit("change");
  }

  #updateFriend(f, msg) {
    f.name = cleanName(msg.name);
    const photo = safePhoto(msg.photo);
    f.photo = photo.length < STORE_PHOTO_MAX ? photo : ""; // o resto fica só na memória
    if ("tags" in msg) f.tags = cleanTags(msg.tags);     // guardados para ver o perfil mesmo offline
    if ("top" in msg) f.top = cleanTopArtists(msg.top);
    this.#save();
  }

  #applyPresence(code, msg) {
    const p = this.presence.get(code) || {};
    p.online = true;
    if ("name" in msg) p.name = cleanName(msg.name);
    if ("photo" in msg) p.photo = safePhoto(msg.photo);
    if ("track" in msg) p.track = cleanTrack(msg.track);
    if ("playing" in msg) p.playing = !!msg.playing;
    if ("jam" in msg) p.jam = /^[A-Z0-9]{6}$/.test(String(msg.jam)) ? String(msg.jam) : null;
    if ("tags" in msg) p.tags = cleanTags(msg.tags);
    if ("top" in msg) p.top = cleanTopArtists(msg.top);
    this.presence.set(code, p);
  }

  // ---------- O que mando para os amigos ----------
  // Perfil que os amigos veem: nome, foto, tags e artistas mais ouvidos
  #me() {
    return {
      name: cleanName(profile.name || "Amigo"),
      photo: safePhoto(profile.photo),
      tags: cleanTags(profile.tags),
      top: cleanTopArtists(history.topArtists(5)),
    };
  }

  #presence() {
    const t = this.share ? player.current : null;
    return { // sem "type": quem chama decide (hello ou presence)
      track: t ? { id: t.id, title: t.title, artist: t.artist, thumb: t.thumb } : null,
      playing: !!t && player.playing,
      jam: jam.status === "live" ? jam.code : null,
    };
  }

  #send(conn, msg) { try { if (conn?.open) conn.send(msg); } catch {} }
  #sendAll(msg) { for (const c of this.#conns.values()) this.#send(c, msg); }

  // ---------- Ações da tela ----------
  async add(raw) {
    const code = parseCode(raw);
    if (!isCode(code)) throw new Error("O código de amigo tem 8 letras/números (ex.: ABCD-EFGH).");
    if (code === this.code) throw new Error("Esse é o seu próprio código 🙂");
    if (this.list.some((f) => f.code === code)) throw new Error("Vocês já são amigos.");
    if (this.list.length >= MAX_FRIENDS) throw new Error("Limite de amigos atingido.");
    // Se essa pessoa já me mandou pedido, adicionar = aceitar
    const theirs = this.incoming.find((r) => r.code === code);
    if (theirs) return this.accept(code);
    if (!this.outgoing.some((r) => r.code === code)) this.outgoing.push({ code, key: randomKey() });
    this.#save();
    this.emit("change");
    if (!this.#peer) await this.start();
    this.#tick();
  }

  accept(code) {
    const r = this.incoming.find((x) => x.code === code);
    if (!r) return;
    this.incoming = this.incoming.filter((x) => x !== r);
    if (r.conn?.open) this.#becomeFriends(r.conn, code, r.key, r);
    else { // a conexão caiu: guarda a amizade; quando ele reconectar, o "hello" completa
      this.list.push({ code, key: r.key, name: r.name, photo: r.photo.length < STORE_PHOTO_MAX ? r.photo : "" });
      this.#save();
      this.emit("change");
    }
  }

  decline(code) {
    const r = this.incoming.find((x) => x.code === code);
    if (!r) return;
    this.#send(r.conn, { type: "friend-decline" });
    this.incoming = this.incoming.filter((x) => x !== r);
    this.emit("change");
  }

  cancelRequest(code) {
    this.outgoing = this.outgoing.filter((r) => r.code !== code);
    this.#save();
    this.emit("change");
  }

  remove(code) {
    const c = this.#conns.get(code);
    this.#send(c, { type: "unfriend" });
    setTimeout(() => { try { c?.close(); } catch {} }, 300);
    this.#forget(code);
    this.emit("change");
  }

  #forget(code) {
    this.list = this.list.filter((f) => f.code !== code);
    this.presence.delete(code);
    this.#conns.delete(code);
    this.#save();
  }

  invite(code) {
    const c = this.#conns.get(code);
    if (!c || jam.status !== "live") return false;
    this.#send(c, { type: "jam-invite", jam: jam.code });
    return true;
  }

  setShare(on) {
    this.share = !!on;
    Storage.set("friends.share", this.share);
    this.#sendAll({ type: "presence", ...this.#presence() });
    this.emit("change");
  }

  #save() {
    Storage.set("friends.list", this.list);
    Storage.set("friends.outgoing", this.outgoing);
  }

  #setStatus(s) { this.status = s; this.emit("change"); }
}

export const friends = new Friends();
