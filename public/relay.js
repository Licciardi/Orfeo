// Retransmissor: o "plano B" de Amigos e da Jam quando a conexão direta entre dois PCs não fecha
// (roteador/operadora bloqueando ligação de fora, 4G/5G, CGNAT…).
//
// Os dois apps "ligam para fora" para um servidor público de mensagens (MQTT sobre WebSocket
// seguro) e trocam mensagens por ele. Antes de sair do PC, toda mensagem é TRANCADA com AES-GCM
// usando uma chave que só os dois conhecem (a chave da amizade, ou a da Jam). O servidor só vê
// pacotes trancados: não consegue ler nem inventar mensagens — sem a chave, elas são rejeitadas.
//
// Se um servidor cair, o app usa o próximo da lista.
const BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081",
];
const ROOT = "orfeo/v1/";
const MAX_CHARS = 200_000; // mensagens maiores perdem as fotos grandes (GIFs) no caminho
const MAX_AGE_MS = 5 * 60_000; // mensagens velhas (repetidas de propósito) são ignoradas

// ---------- Criptografia ----------
const enc = new TextEncoder(), dec = new TextDecoder();
function b64(bytes) { // em pedaços: mensagens grandes estourariam o limite de argumentos
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashHex(text, len = 32) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

const keyCache = new Map();
// Chave AES-256 derivada de um segredo + rótulo (cada uso tem a sua)
export async function keyFrom(label, secret) {
  const id = `${label}|${secret}`;
  if (!keyCache.has(id)) {
    const raw = await crypto.subtle.digest("SHA-256", enc.encode(`orfeo:${label}:${secret}`));
    keyCache.set(id, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keyCache.get(id);
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify({ ...obj, _t: Date.now() }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { iv: b64(iv), d: b64(ct) };
}

async function unseal(key, env) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.d));
    const obj = JSON.parse(dec.decode(pt));
    if (!obj || typeof obj !== "object" || Math.abs(Date.now() - Number(obj._t)) > MAX_AGE_MS) return null;
    delete obj._t;
    return obj;
  } catch { return null; } // chave errada ou pacote adulterado
}

// Mensagem grande demais? Tira as fotos pesadas (GIFs) em qualquer nível do objeto
function slim(obj) {
  if (JSON.stringify(obj).length <= MAX_CHARS) return obj;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = k === "photo" && typeof x === "string" && x.length > 60_000 ? "" : walk(x);
      return out;
    }
    return v;
  };
  return walk(obj);
}

// ---------- Conexão com os servidores ----------
let mqttLib = null;
class Relay {
  #client = null;
  #connecting = null;
  #subs = new Map(); // tópico → handler(string)
  #broker = 0;
  status = "off";    // off | connecting | on
  get server() { return this.#client?.connected ? BROKERS[this.#broker % BROKERS.length] : null; }

  async #lib() {
    if (!mqttLib) { const mod = await import("/vendor/mqtt.esm.js"); mqttLib = mod.default || mod; }
    return mqttLib;
  }

  ensure() {
    if (this.#client?.connected) return Promise.resolve();
    if (!this.#connecting) this.#connecting = this.#connect().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #connect() {
    const mqtt = await this.#lib();
    for (let tries = 0; tries < BROKERS.length; tries++) {
      const url = BROKERS[this.#broker % BROKERS.length];
      this.status = "connecting";
      const ok = await new Promise((resolve) => {
        const c = mqtt.connect(url, {
          clientId: `orfeo_${crypto.getRandomValues(new Uint32Array(2)).join("")}`,
          clean: true, connectTimeout: 8000, reconnectPeriod: 4000, keepalive: 30,
        });
        const fail = () => { try { c.end(true); } catch {} resolve(false); };
        const timer = setTimeout(fail, 9000);
        c.once("connect", () => {
          clearTimeout(timer);
          this.#client?.end(true);
          this.#client = c;
          c.on("message", (topic, payload) => this.#subs.get(topic)?.(payload.toString()));
          // reconectou (internet caiu e voltou): assina tudo de novo
          c.on("connect", () => { for (const t of this.#subs.keys()) c.subscribe(t); });
          for (const t of this.#subs.keys()) c.subscribe(t);
          resolve(true);
        });
        c.once("error", () => { clearTimeout(timer); fail(); });
      });
      if (ok) { this.status = "on"; return; }
      this.#broker++; // esse servidor não respondeu: tenta o próximo
    }
    this.status = "off";
    throw new Error("Nenhum retransmissor respondeu.");
  }

  async subscribe(topic, handler) {
    this.#subs.set(topic, handler);
    await this.ensure();
    this.#client.subscribe(topic);
  }

  unsubscribe(topic) {
    this.#subs.delete(topic);
    try { this.#client?.unsubscribe(topic); } catch {}
  }

  async publish(topic, text) {
    await this.ensure();
    this.#client.publish(topic, text);
  }
}
export const relay = new Relay();

// Endereço (tópico) de uma "caixa de entrada" — o segredo nunca aparece em claro no servidor
export async function inbox(kind, secret) { return ROOT + kind + "/" + (await hashHex(`${kind}:${secret}`)); }

// Envia um objeto trancado para uma caixa de entrada
export async function sendSealed(topic, key, from, obj) {
  const env = { f: from, ...(await seal(key, slim(obj))) };
  await relay.publish(topic, JSON.stringify(env));
}

// Abre um envelope recebido tentando as chaves possíveis (devolve { from, msg } ou null)
export async function openSealed(text, keysFor) {
  let env;
  try { env = JSON.parse(text); } catch { return null; }
  if (!env || typeof env.f !== "string" || typeof env.iv !== "string" || typeof env.d !== "string") return null;
  for (const key of await keysFor(env.f)) {
    const msg = await unseal(key, env);
    if (msg) return { from: env.f, msg };
  }
  return null;
}

// ---------- "Ligação" pelo retransmissor ----------
// Imita a conexão direta do PeerJS (open, peer, send, close, on("data"|"close"|"error")),
// então Amigos e Jam usam igual. Não existe "desligar" no servidor: quem usa considera a
// ligação caída se ficar muito tempo sem receber nada (lastSeen).
export class RelayLink {
  open = true;
  isRelay = true;
  lastSeen = Date.now();
  #handlers = {};
  #send;

  constructor(peer, send) { this.peer = peer; this.#send = send; }

  on(evt, fn) { (this.#handlers[evt] ??= []).push(fn); return this; }
  #emit(evt, data) { (this.#handlers[evt] || []).forEach((fn) => fn(data)); }

  send(obj) {
    if (!this.open) return;
    this.#send(obj).catch(() => this.#emit("error", new Error("Retransmissor indisponível")));
  }

  deliver(obj) { this.lastSeen = Date.now(); this.#emit("data", obj); }

  close() {
    if (!this.open) return;
    this.open = false;
    this.#emit("close");
  }
}
