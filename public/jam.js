// Jam: ouvir junto com amigos, cada um tocando o YouTube no próprio computador.
//
// Conexão direta entre os computadores (WebRTC) via PeerJS. O servidor público do PeerJS
// só serve para os dois se acharem pelo código; depois a conversa é direta (ou passa pelo
// TURN do PeerJS quando a rede não deixa conexão direta). Nenhum áudio trafega — só o estado:
//   anfitrião → convidados: { type: "state", queue, index, playing, position, shuffle, repeat }
//                           { type: "members", members }
//   convidado → anfitrião:  { type: "hello", name, photo }  { type: "cmd", action, args }
// O anfitrião é a fonte da verdade: comandos dos convidados são validados e aplicados nele.
import { player, profile, Storage, Emitter } from "./platform.js";
import { randomCode, randomKey, loadPeerJS, openPeer, friendlyError, str, cleanName, safePhoto, cleanTrack, cleanTracks, toInt } from "./net.js";
import { relay, inbox, keyFrom, sendSealed, openSealed, RelayLink } from "./relay.js";

// Plano B (retransmissor): quando a conexão direta não fecha, a Jam passa pelo servidor de mensagens,
// trancada com o segredo da Jam — que só circula pelos canais (já trancados) entre amigos.
const RELAY_PING_MS = 10_000, RELAY_TIMEOUT_MS = 35_000;
const isSecret = (k) => typeof k === "string" && /^[0-9a-f]{32}$/.test(k);

const PEER_PREFIX = "orfeo-jam-";
const MAX_GUESTS = 7;
const newCode = () => randomCode(6);
const friendly = (e) => friendlyError(e, "Não achei essa Jam. Confira o código (ou ela já terminou).");

class Jam extends Emitter {
  role = null;       // null | "host" | "guest"
  status = "";       // "" | "connecting" | "live"
  code = "";
  secret = "";       // segredo da Jam (para o retransmissor); só vai para amigos
  members = [];      // [{ id, name, photo, host }]

  #peer = null;
  #conns = new Map(); // anfitrião: peerId → conexão | convidado: "host" → conexão
  #offs = [];
  #heartbeat = 0;
  #debounce = 0;
  #relayTopics = [];   // caixas de entrada assinadas no retransmissor
  #relayGuests = new Map(); // anfitrião: id do convidado → ligação pelo retransmissor
  #relayTimer = 0;
  #myRelayId = "";

  constructor() {
    super();
    profile.on("change", () => this.#onProfileChange());
  }

  get active() { return !!this.role; }
  get hostName() { return this.members.find((m) => m.host)?.name ?? ""; }
  get myId() { return this.#myRelayId || (this.#peer?.id ?? ""); }
  member(id) { return this.members.find((m) => m.id === id); }

  #me() { return { name: cleanName(profile.name || "Convidado"), photo: safePhoto(profile.photo) }; }

  // ---------- Anfitrião ----------
  async host() {
    if (this.active) return;
    this.#set("host", "connecting");
    try {
      await loadPeerJS();
      for (let attempt = 0; ; attempt++) {
        const code = newCode();
        try { this.#peer = await openPeer(PEER_PREFIX + code); this.code = code; break; }
        catch (e) { if (e.type !== "unavailable-id" || attempt >= 2) throw friendly(e); }
      }
    } catch (e) {
      this.leave(true);
      throw e.type ? e : friendly(e);
    }
    this.members = [{ id: this.#peer.id, ...this.#me(), host: true }];
    this.#peer.on("connection", (conn) => this.#acceptGuest(conn));
    this.#peer.on("disconnected", () => this.#peer && !this.#peer.destroyed && this.#peer.reconnect());
    this.#peer.on("error", (e) => e.type !== "peer-unavailable" && this.emit("toast", friendly(e).message));
    // Qualquer mudança no player do anfitrião vai para todo mundo
    this.#offs = ["track", "state", "queue", "seek"].map((evt) => player.on(evt, () => this.#scheduleBroadcast()));
    this.#heartbeat = setInterval(() => player.playing && this.#broadcast(), 2000); // corrige atrasos
    this.secret = randomKey();
    this.#hostRelay().catch(() => {}); // sem retransmissor: a Jam segue só com conexões diretas
    this.#set("host", "live");
  }

  // Convidados que não conseguem ligação direta chegam por aqui
  async #hostRelay() {
    const secret = this.secret, key = await keyFrom("jam", secret);
    const topic = await inbox("jh", secret);
    this.#relayTopics.push(topic);
    await relay.subscribe(topic, async (text) => {
      if (this.secret !== secret) return;
      const got = await openSealed(text, async (from) => (/^[0-9a-f]{16}$/.test(from) ? [key] : []));
      if (!got) return;
      const id = "relay:" + got.from;
      let link = this.#relayGuests.get(id);
      if (!link?.open) {
        const guestTopic = await inbox("jg", `${secret}:${got.from}`);
        link = new RelayLink(id, (obj) => sendSealed(guestTopic, key, "host", obj));
        this.#relayGuests.set(id, link);
        link.on("close", () => this.#relayGuests.delete(id));
        this.#acceptGuest(link);
      }
      link.deliver(got.msg);
    });
    // "ainda estou aqui" para quem está pelo retransmissor; quem sumir sai da Jam
    this.#relayTimer = setInterval(() => {
      for (const link of [...this.#relayGuests.values()]) {
        if (Date.now() - link.lastSeen > RELAY_TIMEOUT_MS) link.close();
        else this.#send(link, { type: "ping" });
      }
    }, RELAY_PING_MS);
  }

  #acceptGuest(conn) {
    conn.on("data", (msg) => this.#onGuestMessage(conn, msg));
    conn.on("close", () => this.#dropGuest(conn.peer));
    conn.on("error", () => this.#dropGuest(conn.peer));
  }

  #dropGuest(id) {
    if (!this.#conns.has(id)) return;
    this.#conns.delete(id);
    const m = this.members.find((x) => x.id === id);
    this.members = this.members.filter((x) => x.id !== id);
    if (m) this.emit("toast", `${m.name} saiu da Jam`);
    this.#sendMembers();
    this.emit("change");
  }

  #onGuestMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello" && !this.#conns.has(conn.peer)) {
      if (this.#conns.size >= MAX_GUESTS) {
        this.#send(conn, { type: "full" });
        setTimeout(() => conn.close(), 500);
        return;
      }
      this.#conns.set(conn.peer, conn);
      const member = { id: conn.peer, name: cleanName(msg.name), photo: safePhoto(msg.photo), host: false };
      this.members.push(member);
      this.emit("toast", `${member.name} entrou na Jam`);
      this.#sendMembers();
      this.#send(conn, this.#state());
      this.emit("change");
    }
    if (msg.type === "profile" && this.#conns.has(conn.peer)) {
      const m = this.member(conn.peer);
      if (m) { m.name = cleanName(msg.name); m.photo = safePhoto(msg.photo); this.#sendMembers(); this.emit("change"); }
    }
    // convidado pelo retransmissor pediu tudo de novo (a primeira resposta pode ter se perdido)
    if (msg.type === "bye" && conn.isRelay) return conn.close(); // convidado saiu (pelo retransmissor)
    if (msg.type === "resync" && this.#conns.has(conn.peer)) {
      this.#send(conn, { type: "members", members: this.members });
      this.#send(conn, this.#state());
    }
    if (msg.type === "cmd" && this.#conns.has(conn.peer)) {
      // "quem adicionou" é sempre quem mandou o comando: ninguém se passa por outra pessoa
      this.#runCommand(msg.action, msg.args, this.member(conn.peer)?.name, conn.peer);
    }
  }

  // Só ações conhecidas, com argumentos validados
  #runCommand(action, args, who, senderId) {
    if (!Array.isArray(args)) return;
    switch (action) {
      case "toggle": case "next": case "prev": case "toggleShuffle": case "cycleRepeat":
        return player[action]();
      case "seek":
        return player.seek(Math.max(0, Number(args[0]) || 0));
      case "jumpTo": case "removeFromQueue": {
        const i = toInt(args[0]);
        if (i >= 0 && i < player.queue.length) player[action](i);
        return;
      }
      case "addToQueue": {
        const t = cleanTrack(args[0]);
        if (!t) return;
        player.addToQueue({ ...t, addedBy: senderId });
        this.emit("toast", `${who || "Alguém"} adicionou “${t.title}”`);
        this.#scheduleBroadcast();
        return;
      }
      case "playList": {
        const tracks = cleanTracks(args[0]);
        const i = toInt(args[1]);
        if (tracks.length && i >= 0 && i < tracks.length) player.playList(tracks, i);
        return;
      }
    }
  }

  #state() {
    return {
      type: "state", queue: player.queue, index: player.index, playing: player.playing,
      position: player.progress().current, shuffle: player.shuffle, repeat: player.repeat,
      fade: +player.mixRemaining.toFixed(2), fadeStyle: player.mixStyle, // transição em andamento
    };
  }
  #scheduleBroadcast() {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => this.#broadcast(), 120); // junta rajadas de eventos
  }
  #broadcast() {
    const s = this.#state();
    for (const c of this.#conns.values()) this.#send(c, s);
  }
  #sendMembers() {
    for (const c of this.#conns.values()) this.#send(c, { type: "members", members: this.members });
  }
  #send(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch {}
  }

  // ---------- Convidado ----------
  async join(rawCode, secret = "") {
    if (this.active) return;
    const code = String(rawCode).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) throw new Error("O código tem 6 letras/números.");
    this.code = code;
    this.secret = isSecret(secret) ? secret : "";
    this.#set("guest", "connecting");
    let conn;
    try {
      conn = await this.#joinDirect(code);
    } catch (e) {
      // "não achei essa Jam" é definitivo; qualquer outra falha tenta o retransmissor
      if (e.type === "peer-unavailable" || !this.secret) { this.leave(true); throw e.type || e.message ? e : friendly(e); }
      try { conn = await this.#joinRelay(); }
      catch (err) { this.leave(true); throw err; }
    }
    this.#conns.set("host", conn);
    conn.on("data", (msg) => this.#onHostMessage(msg));
    conn.on("close", () => {
      if (this.role !== "guest") return;
      this.emit("toast", "A Jam terminou");
      this.leave(true);
    });
    this.#send(conn, conn.isRelay ? { type: "resync" } : { type: "hello", ...this.#me() });
    player.remote = (action, args) => this.#send(conn, { type: "cmd", action, args });
    this.#set("guest", "live");
  }

  async #joinDirect(code) {
    if (Storage.get("debug.forceRelay", false)) throw new Error("forçando retransmissor (teste)");
    await loadPeerJS();
    this.#peer = await openPeer();
    const conn = this.#peer.connect(PEER_PREFIX + code, { reliable: true });
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("A Jam não respondeu. Confira o código e tente de novo.")), 15000);
      conn.on("open", () => { clearTimeout(timer); ok(); });
      this.#peer.on("error", (e) => { clearTimeout(timer); fail(friendly(e)); });
    });
    return conn;
  }

  // Entra pela caixa de entrada da Jam no retransmissor e espera o anfitrião responder
  async #joinRelay() {
    const secret = this.secret, key = await keyFrom("jam", secret);
    const id = randomKey().slice(0, 16);
    const hostTopic = await inbox("jh", secret), myTopic = await inbox("jg", `${secret}:${id}`);
    const link = new RelayLink("relay-host", (obj) => sendSealed(hostTopic, key, id, obj));
    this.#relayTopics.push(myTopic);
    await relay.subscribe(myTopic, async (text) => {
      const got = await openSealed(text, async (from) => (from === "host" ? [key] : []));
      if (got) link.deliver(got.msg);
    });
    const answered = new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("A Jam não respondeu (nem pelo retransmissor).")), 12_000);
      link.on("data", () => { clearTimeout(timer); ok(); });
    });
    link.send({ type: "hello", ...this.#me() });
    await answered;
    this.#myRelayId = "relay:" + id;
    // "ainda estou aqui"; se o anfitrião sumir, a Jam acabou
    this.#relayTimer = setInterval(() => {
      if (Date.now() - link.lastSeen > RELAY_TIMEOUT_MS) link.close();
      else link.send({ type: "ping" });
    }, RELAY_PING_MS);
    return link;
  }

  #onHostMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state") {
      player.applyRemoteState({
        queue: cleanTracks(msg.queue), index: toInt(msg.index), playing: !!msg.playing,
        position: Number(msg.position) || 0, shuffle: !!msg.shuffle, repeat: msg.repeat,
        fade: Math.min(Math.max(Number(msg.fade) || 0, 0), 15), fadeStyle: msg.fadeStyle === "automix" ? "automix" : "equal",
      });
    }
    if (msg.type === "members" && Array.isArray(msg.members)) {
      this.members = msg.members.slice(0, MAX_GUESTS + 1).map((m) => ({
        id: str(m?.id, 80), name: cleanName(m?.name), photo: safePhoto(m?.photo), host: !!m?.host,
      }));
      this.emit("change");
    }
    if (msg.type === "bye") { // anfitrião encerrou (pelo retransmissor não existe "desligar")
      this.emit("toast", "A Jam terminou");
      return this.leave(true);
    }
    if (msg.type === "full") {
      this.emit("toast", "Essa Jam está cheia.");
      this.leave(true);
    }
  }

  // ---------- Sair / encerrar ----------
  // Nome/foto mudaram no perfil durante a Jam → atualiza para todo mundo
  #onProfileChange() {
    if (this.status !== "live") return;
    if (this.role === "guest") return this.#send(this.#conns.get("host"), { type: "profile", ...this.#me() });
    const me = this.member(this.myId);
    if (me) { Object.assign(me, this.#me()); this.#sendMembers(); this.emit("change"); }
  }

  leave(silent = false) {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#debounce);
    this.#offs.forEach((off) => off());
    this.#offs = [];
    for (const c of this.#conns.values()) {
      if (c.isRelay) this.#send(c, { type: "bye" }); // avisa na hora quem está pelo retransmissor
      try { c.close(); } catch {}
    }
    this.#conns.clear();
    this.#peer?.destroy();
    this.#peer = null;
    clearInterval(this.#relayTimer);
    this.#relayTopics.forEach((t) => relay.unsubscribe(t));
    this.#relayTopics = [];
    this.#relayGuests.clear();
    this.#myRelayId = "";
    this.secret = "";
    player.remote = null;
    const wasHost = this.role === "host";
    this.role = null; this.status = ""; this.code = ""; this.members = [];
    if (!silent) this.emit("toast", wasHost ? "Jam encerrada" : "Você saiu da Jam");
    this.emit("change");
  }

  #set(role, status) {
    this.role = role;
    this.status = status;
    this.emit("change");
  }
}

export const jam = new Jam();
