// Camada "Platform": serviços independentes da UI, no mesmo espírito da separação
// observada no Spotify (PlayerAPI, PlaylistAPI, LibraryAPI, PlayHistoryAPI, LocalStorageAPI...).
// As views só falam com estes serviços e escutam eventos.

export class Emitter {
  #handlers = {};
  on(evt, fn) { (this.#handlers[evt] ??= new Set()).add(fn); return () => this.#handlers[evt].delete(fn); }
  emit(evt, data) { this.#handlers[evt]?.forEach((fn) => fn(data)); }
}

// ---------- LocalStorageAPI ----------
// O app se chamava "Sonora": dados antigos ("sonora:…") são lidos e passados para "orfeo:…"
// na primeira leitura, sem perder playlists, perfil, amigos etc.
const PREFIX = "orfeo:", LEGACY_PREFIX = "sonora:";
export const Storage = {
  get(key, fallback) {
    try {
      let v = localStorage.getItem(PREFIX + key);
      if (v === null) {
        v = localStorage.getItem(LEGACY_PREFIX + key);
        if (v !== null) { localStorage.setItem(PREFIX + key, v); localStorage.removeItem(LEGACY_PREFIX + key); }
      }
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  // Devolve false se não deu para salvar (ex.: armazenamento cheio)
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

// Modelo de faixa: { id (videoId do YouTube), title, artist, thumb }
export const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// ---------- LibraryAPI (curtidas) + PlaylistAPI ----------
class Library extends Emitter {
  liked = Storage.get("liked", []);
  playlists = Storage.get("playlists", []);

  #save() { Storage.set("liked", this.liked); Storage.set("playlists", this.playlists); this.emit("change"); }

  isLiked(id) { return this.liked.some((t) => t.id === id); }
  toggleLike(track) {
    this.liked = this.isLiked(track.id)
      ? this.liked.filter((t) => t.id !== track.id)
      : [track, ...this.liked];
    this.#save();
  }

  createPlaylist(name) {
    const pl = { id: crypto.randomUUID(), name, tracks: [], createdAt: Date.now() };
    this.playlists.push(pl);
    this.#save();
    return pl;
  }
  getPlaylist(id) { return this.playlists.find((p) => p.id === id); }
  renamePlaylist(id, name) { const p = this.getPlaylist(id); if (p) { p.name = name; this.#save(); } }
  deletePlaylist(id) { this.playlists = this.playlists.filter((p) => p.id !== id); this.#save(); }
  addToPlaylist(id, track) {
    const p = this.getPlaylist(id);
    if (p && !p.tracks.some((t) => t.id === track.id)) { p.tracks.push(track); this.#save(); }
  }
  removeFromPlaylist(id, trackId) {
    const p = this.getPlaylist(id);
    if (p) { p.tracks = p.tracks.filter((t) => t.id !== trackId); this.#save(); }
  }
}
export const library = new Library();

// ---------- PlayHistoryAPI ----------
class History extends Emitter {
  items = Storage.get("history", []);
  // Quantas vezes cada artista tocou (para "mais ouvidos" no perfil). Começa pelo histórico já existente.
  artistPlays = Storage.get("artistPlays", null) ??
    this.items.reduce((acc, t) => ((acc[t.artist] = (acc[t.artist] || 0) + 1), acc), {});
  totalPlays = Storage.get("totalPlays", this.items.length);

  push(track) {
    this.items = [track, ...this.items.filter((t) => t.id !== track.id)].slice(0, 50);
    this.artistPlays[track.artist] = (this.artistPlays[track.artist] || 0) + 1;
    this.totalPlays++;
    Storage.set("history", this.items);
    Storage.set("artistPlays", this.artistPlays);
    Storage.set("totalPlays", this.totalPlays);
    this.emit("change");
  }

  topArtists(n = 6) {
    return Object.entries(this.artistPlays)
      .filter(([name]) => name)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, plays]) => ({ name, plays, thumb: this.items.find((t) => t.artist === name)?.thumb }));
  }
}
export const history = new History();

// ---------- Perfil (nome, foto, cor do app) ----------
class Profile extends Emitter {
  name = Storage.get("profile.name", "");
  photo = Storage.get("profile.photo", "");    // data URL JPEG 256x256
  accent = Storage.get("profile.accent", "#ff4d6d");
  tags = Storage.get("profile.tags", []);          // [{ text, style }] — até 5, aparecem para os amigos

  setName(name) { this.name = name.trim().slice(0, 30); Storage.set("profile.name", this.name); this.emit("change"); }
  setPhoto(dataUrl) {
    if (!Storage.set("profile.photo", dataUrl)) throw new Error("Não coube no armazenamento do app. Tente uma imagem menor.");
    this.photo = dataUrl;
    this.emit("change");
  }
  setAccent(color) { this.accent = color; Storage.set("profile.accent", color); this.emit("change"); }
  setTags(tags) { this.tags = tags.slice(0, 5); Storage.set("profile.tags", this.tags); this.emit("change"); }

  get initials() {
    const letters = (this.name || "Você").split(/\s+/).map((w) => w.match(/\p{L}/u)?.[0]).filter(Boolean);
    return ((letters[0] || "V") + (letters.length > 1 ? letters.at(-1) : "")).toUpperCase();
  }

  // Fotos: recorta no centro (quadrado) e reduz para 256px → JPEG leve.
  // GIF: guarda o arquivo original para manter a animação (o círculo recorta na exibição).
  static GIF_MAX = 1024 * 1024; // 1 MB: cabe no armazenamento e viaja rápido na Jam

  async photoFromFile(file) {
    if (!file.type.startsWith("image/")) throw new Error("Escolha um arquivo de imagem.");
    if (file.type === "image/gif") {
      if (file.size > Profile.GIF_MAX) {
        throw new Error(`GIF muito grande (${(file.size / 1048576).toFixed(1)} MB). O máximo é 1 MB — dá para reduzir em sites como ezgif.com.`);
      }
      const head = new Uint8Array(await file.slice(0, 6).arrayBuffer());
      if (String.fromCharCode(...head) !== "GIF89a" && String.fromCharCode(...head) !== "GIF87a") {
        throw new Error("Esse arquivo não é um GIF válido.");
      }
      return await new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = () => fail(new Error("Não deu para ler o GIF."));
        r.readAsDataURL(file);
      });
    }
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height), size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    bmp.close();
    return c.toDataURL("image/jpeg", 0.85);
  }
}
export const profile = new Profile();

// ---------- Busca (sem chave: o server.js consulta o YouTube por dentro) ----------
export const Search = {
  // type: "songs" (YouTube Music) ou "videos" (YouTube normal)
  async query(q, type = "songs") {
    const res = await fetch(`/api/search?${new URLSearchParams({ q, type })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Falha na busca");
    return data.items;
  },

  // Aceita link do YouTube / YouTube Music ou o ID puro — funciona sem chave de API.
  parseVideoId(input) {
    const s = input.trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
      return u.searchParams.get("v") || u.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/)?.[1] || null;
    } catch { return null; }
  },

  async fromLink(input) {
    const id = this.parseVideoId(input);
    if (!id) return null;
    const track = { id, title: "Vídeo " + id, artist: "YouTube", thumb: thumbFor(id) };
    try {
      const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);
      const d = await r.json();
      if (d.title) { track.title = d.title; track.artist = (d.author_name || "YouTube").replace(/ - Topic$/, ""); }
    } catch {}
    return track;
  },
};


// ---------- Letras (o server.js consulta o LRCLIB) ----------
const toSeconds = (s) => (s ? s.split(":").reduce((acc, n) => acc * 60 + Number(n), 0) : 0);

export const Lyrics = {
  cache: new Map(), // videoId → letra (ou null quando não existe)

  // Devolve { lines: [{ t, text }] | null (sincronizada), plain: string | null, instrumental } ou null
  async get(track, knownDuration = 0) {
    if (this.cache.has(track.id)) return this.cache.get(track.id);
    const duration = toSeconds(track.duration) || Math.round(knownDuration) || "";
    const res = await fetch(`/api/lyrics?${new URLSearchParams({ title: track.title, artist: track.artist, duration })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Falha ao buscar a letra"); // erro não entra no cache: dá pra tentar de novo
    const l = data.lyrics;
    const result = l && { lines: l.synced ? parseLRC(l.synced) : null, plain: l.plain, instrumental: l.instrumental };
    this.cache.set(track.id, result);
    return result;
  },
};

// "[01:02.34] texto" → { t: 62.34, text: "texto" } (linhas vazias viram pausa instrumental "♪")
function parseLRC(lrc) {
  const lines = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) lines.push({ t: +m[1] * 60 + +m[2], text: text || "♪" });
  }
  return lines.sort((a, b) => a.t - b.t);
}

// ---------- PlayerAPI + fila ----------
// Usa o IFrame Player oficial do YouTube (o jeito permitido de tocar conteúdo do YouTube).
//
// Dois "decks" (dois players), como uma mesa de DJ: na troca de faixa o próximo deck entra
// enquanto o atual sai. O app não tem acesso ao áudio de dentro do iframe, então a mistura é
// feita controlando o volume de cada deck — é assim que o crossfade e o automix funcionam.
const MIX_MODES = ["off", "crossfade", "automix"];
const QUICK_FADE = 1.5; // troca manual (pular/escolher faixa) quando a transição está ligada
const PRELOAD = 1;      // segundos a mais de antecedência: o deck novo leva ~1 s para carregar e começar
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Curvas de volume (t de 0 a 1) → [ganho de quem sai, ganho de quem entra]
function mixCurve(t, style) {
  if (style === "automix") {
    // Estilo DJ: quem sai segura o volume no começo; quem entra cresce antes de o outro cair
    const tOut = clamp((t - 0.35) / 0.65, 0, 1), tIn = clamp(t / 0.7, 0, 1);
    return [Math.cos(tOut * Math.PI / 2), Math.sin(tIn * Math.PI / 2)];
  }
  // "Equal power": a soma soa com volume constante durante a mistura
  return [Math.cos(t * Math.PI / 2), Math.sin(t * Math.PI / 2)];
}

class Player extends Emitter {
  ready = false;
  queue = [];          // ordem de reprodução atual
  original = [];       // ordem antes do shuffle
  index = -1;
  shuffle = false;
  repeat = "off";      // off | all | one
  playing = false;
  volume = Storage.get("volume", 80);
  // Jam (convidado): quando definido, os comandos vão para o anfitrião em vez de agir aqui.
  // O anfitrião aplica e devolve o estado, que chega em applyRemoteState().
  remote = null;
  // Autoplay: quando a fila está acabando, emenda o "rádio" do YouTube Music da música atual
  autoplay = Storage.get("autoplay", true);
  #radioBusy = false;
  #radioSeed = null; // última música usada como base (evita buscar o mesmo rádio de novo)

  // Transições entre faixas
  mixMode = MIX_MODES.includes(Storage.get("mixMode")) ? Storage.get("mixMode") : "automix";
  mixSeconds = clamp(Number(Storage.get("mixSeconds", 6)) || 6, 1, 12);
  insight = null;    // () => análise do áudio (BPM, batidas, volume) — o app liga isso ao visualizador
  // Transição instrumental: tira a voz durante a mistura (só no app desktop, que processa o áudio)
  instrumental = Storage.get("instrumentalMix", true);
  voiceFx = null;    // (deck, voz 0..1, segundos) — o app liga isso ao processador de cada deck
  #decks = [];       // [{ yt, el, ready, videoId }]
  #active = 0;       // deck que "vale" (a faixa atual)
  #fade = null;      // { from, to, dur, style, start, timer, armTimer }
  #outro = { avg: 0, n: 0, low: 0 }; // energia da faixa atual (para achar o fim de verdade)
  #lastMix = null;   // como foi a última decisão do Automix (para conferir/diagnosticar)
  get lastMix() { return this.#lastMix; }

  get current() { return this.queue[this.index] ?? null; }
  get yt() { return this.#decks[this.#active]?.yt ?? null; }
  get mixing() { return !!this.#fade; }
  // Quanto falta da transição em andamento (a Jam manda isso para os convidados)
  get mixRemaining() {
    const f = this.#fade;
    if (!f) return 0;
    return f.start == null ? f.dur : Math.max(0, f.dur - (performance.now() - f.start) / 1000);
  }
  get mixStyle() { return this.#fade?.style ?? "equal"; }
  // Para desenhar a transição: qual deck sai, qual entra e o volume relativo de cada um agora
  get mixState() {
    const f = this.#fade;
    if (!f) return null;
    const t = f.start == null ? 0 : clamp((performance.now() - f.start) / (f.dur * 1000), 0, 1);
    const [gOut, gIn] = mixCurve(t, f.style);
    return { from: f.from, to: f.to, gOut, gIn, t };
  }

  #forward(action, args) {
    if (!this.remote) return false;
    this.remote(action, [...args]);
    return true;
  }

  init(ids = ["yt-player", "yt-player-b"], deckIds = ["deck-a", "deck-b"]) {
    const create = () => {
      ids.forEach((id, i) => {
        const deck = { yt: null, el: document.getElementById(deckIds[i]), ready: false, videoId: null };
        this.#decks[i] = deck;
        deck.yt = new YT.Player(id, {
          width: "100%", height: "100%",
          // Player "limpo": sem controles/teclado/tela cheia/anotações/legendas do YouTube
          // (os controles são os do Orfeo). Sugestões só do mesmo canal (rel: 0).
          playerVars: {
            playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0,
            iv_load_policy: 3, cc_load_policy: 0, modestbranding: 1,
            origin: location.origin,
          },
          events: {
            onReady: () => {
              deck.ready = true;
              deck.yt.setVolume(i === this.#active ? this.volume : 0);
              if (i === this.#active && !this.ready) { this.ready = true; this.emit("ready"); }
            },
            onStateChange: (e) => this.#onState(e.data, i),
            onError: () => this.#onError(i),
          },
        });
      });
      this.#showFront(this.#active, 0.3);
    };
    if (window.YT?.Player) create();
    else window.onYouTubeIframeAPIReady = create;
    setInterval(() => this.playing && this.emit("progress", this.progress()), 500);
    setInterval(() => this.#checkTransition(), 100);
  }

  #onState(state, deck) {
    // O deck que está entrando só começa a subir o volume quando de fato começa a tocar
    if (this.#fade && deck === this.#fade.to && state === YT.PlayerState.PLAYING) this.#startRamp();
    if (deck !== this.#active) return; // deck de saída: só o volume dele importa
    if (state === YT.PlayerState.PLAYING) this.playing = true;
    if (state === YT.PlayerState.PAUSED) this.playing = false;
    if (state === YT.PlayerState.ENDED) {
      this.playing = false;
      if (this.remote) return this.emit("state"); // na Jam, quem decide a próxima é o anfitrião
      if (this.repeat === "one") return this.#play();
      return this.#advance(0);
    }
    this.emit("state");
  }

  #onError(deck) {
    if (deck !== this.#active) return;
    this.#finishFade();
    if (this.remote) return this.emit("error", "Este vídeo não pode ser tocado aqui.");
    this.emit("error", "Este vídeo não pode ser tocado fora do YouTube. Pulando…");
    this.#advance(0);
  }

  // Toca a faixa atual (com ou sem transição)
  #play({ fade = 0, style = "equal" } = {}) {
    const t = this.current;
    if (!t || !this.ready) return;
    this.#switchTo(t, { fade, style });
    history.push(t);
    this.emit("track", t);
    this.emit("queue");
    this.#fillAutoplay();
  }

  // ---------- Decks e mistura ----------
  #manualFade() { return this.mixMode === "off" ? 0 : QUICK_FADE; }

  #switchTo(t, { fade = 0, style = "equal", startSeconds = 0, play = true } = {}) {
    if (!this.ready) return;
    this.#finishFade();
    this.#outro = { avg: 0, n: 0, low: 0 };
    const canFade = fade > 0 && play && this.playing && this.#decks.length === 2 && this.#decks.every((d) => d.ready);
    if (!canFade) {
      const deck = this.#decks[this.#active];
      if (play) deck.yt.loadVideoById({ videoId: t.id, startSeconds });
      else deck.yt.cueVideoById({ videoId: t.id, startSeconds });
      deck.videoId = t.id;
      deck.yt.setVolume(this.volume);
      return;
    }
    const from = this.#active, to = 1 - from, incoming = this.#decks[to];
    const voice = this.#useVoiceFx(fade);
    if (voice) this.voiceFx(to, 0, 0); // a música nova entra sem a voz
    incoming.yt.setVolume(0);
    incoming.yt.loadVideoById({ videoId: t.id, startSeconds });
    incoming.videoId = t.id;
    this.#active = to; // a partir daqui, "a faixa atual" é a que está entrando
    this.#fade = { from, to, dur: fade, style, start: null, timer: 0, armTimer: 0, voice, voiceTimer: 0 };
    // Se o deck novo demorar para começar (rede lenta), mistura assim mesmo
    this.#fade.armTimer = setTimeout(() => this.#startRamp(), 2500);
    this.emit("mix", true);
  }

  #startRamp() {
    const f = this.#fade;
    if (!f || f.start != null) return;
    clearTimeout(f.armTimer);
    f.start = performance.now();
    this.#showFront(f.to, f.dur); // o vídeo novo se dissolve por cima do antigo
    if (f.voice) {
      // Quem sai perde a voz no primeiro terço; os dois se misturam instrumentais;
      // a voz da música nova volta no último terço
      this.voiceFx(f.from, 0, f.dur * 0.35);
      f.voiceTimer = setTimeout(() => this.#fade === f && this.voiceFx(f.to, 1, f.dur * 0.3), f.dur * 700);
    }
    f.timer = setInterval(() => this.#rampStep(), 40);
    this.#rampStep();
  }

  #rampStep() {
    const f = this.#fade;
    if (!f) return;
    const t = clamp((performance.now() - f.start) / (f.dur * 1000), 0, 1);
    const [gOut, gIn] = mixCurve(t, f.style);
    this.#decks[f.from].yt.setVolume(Math.round(this.volume * gOut));
    this.#decks[f.to].yt.setVolume(Math.round(this.volume * gIn));
    if (t >= 1) this.#finishFade();
  }

  // Termina a transição na hora (fim natural, pausa, pulo, erro…)
  #finishFade() {
    const f = this.#fade;
    if (!f) return;
    clearInterval(f.timer);
    clearTimeout(f.armTimer);
    clearTimeout(f.voiceTimer);
    this.#fade = null;
    if (f.voice) {
      this.voiceFx(f.to, 1, 0.4);   // a música que fica volta com voz (se a mistura foi interrompida)
      this.voiceFx(f.from, 1, 0);   // e o deck que saiu fica pronto para a próxima vez
    }
    const out = this.#decks[f.from];
    out.yt.stopVideo?.();
    out.yt.setVolume(0);
    out.videoId = null;
    this.#decks[f.to].yt.setVolume(this.volume);
    this.#showFront(f.to, 0.3);
    this.emit("mix", false);
  }

  #showFront(i, seconds) {
    this.#decks.forEach((d, k) => {
      d.el?.style.setProperty("--fade", `${seconds}s`);
      d.el?.classList.toggle("is-front", k === i);
    });
  }

  // Decide quando começar a transição para a próxima faixa (roda a cada 100 ms)
  #checkTransition() {
    if (this.mixMode === "off" || this.remote || !this.playing || this.#fade || this.repeat === "one") return;
    if (this.#decks.length < 2 || !this.#decks.every((d) => d.ready)) return;
    const hasNext = this.index < this.queue.length - 1 || (this.repeat === "all" && this.queue.length > 1);
    if (!hasNext) return;
    const { current, duration } = this.progress();
    if (!duration || duration < 30 || current < 10) return;
    const remaining = duration - current;

    if (this.mixMode === "crossfade") {
      const fade = Math.min(this.mixSeconds, duration / 4);
      if (remaining <= fade + PRELOAD) this.#advance(fade, "equal");
      return;
    }

    // Automix: transição de 4 compassos (16 batidas) no BPM da música, entre 5 e 12 s
    const ins = this.#insight();
    const beat = ins?.bpm ? 60 / ins.bpm : 0;
    const fade = beat ? clamp(beat * 16, 5, 12) : 7;
    this.#trackOutro(ins, remaining);
    // Na hora certa — ou antes, se a música já entrou no outro/fade-out (energia caiu)
    const due = remaining <= fade + PRELOAD || (remaining < 30 && this.#outro.low >= 2);
    if (!due) return;
    // Começa em cima de uma batida: espera no máximo uma batida; sem folga, começa já
    if (beat && ins.sinceBeat != null && ins.sinceBeat > 0.12 && remaining > fade * 0.6) return;
    this.#lastMix = { fade, bpm: ins?.bpm || 0, sinceBeat: ins?.sinceBeat ?? null, remaining, outro: remaining > fade + PRELOAD };
    this.#advance(Math.min(fade, Math.max(remaining - PRELOAD, 3)), "automix");
  }

  // Energia média da faixa x energia agora: no final, se cair abaixo de 40% por 2 s, é o outro
  #trackOutro(ins, remaining) {
    const o = this.#outro;
    if (!ins) { o.low = 0; return; }
    const e = ins.loudness;
    if (remaining > 30) {
      if (o.n < 3000) { o.avg = (o.avg * o.n + e) / (o.n + 1); o.n++; }
      return;
    }
    if (o.n < 100) return; // pouca amostra: não arrisca
    o.low = e < o.avg * 0.4 ? o.low + 0.1 : Math.max(0, o.low - 0.2);
  }

  // Análise do áudio só vale se estiver fresca (o visualizador escuta o som do sistema)
  #insight() {
    const i = this.insight?.();
    return i && i.hasAudio && performance.now() - i.updatedAt < 600 ? i : null;
  }

  #useVoiceFx(fade) { return this.instrumental && !!this.voiceFx && fade >= 3; }

  setInstrumental(on) {
    this.instrumental = !!on;
    Storage.set("instrumentalMix", this.instrumental);
    this.emit("mixsettings");
  }

  setMixMode(mode) {
    if (!MIX_MODES.includes(mode)) return;
    this.mixMode = mode;
    Storage.set("mixMode", mode);
    if (mode === "off") this.#finishFade();
    this.emit("mixsettings");
  }

  setMixSeconds(s) {
    this.mixSeconds = clamp(Math.round(Number(s) || 6), 1, 12);
    Storage.set("mixSeconds", this.mixSeconds);
    this.emit("mixsettings");
  }

  // ---------- Autoplay ----------
  setAutoplay(on) {
    this.autoplay = !!on;
    Storage.set("autoplay", this.autoplay);
    if (!this.autoplay) {
      // Desligou: tira as automáticas que ainda não tocaram
      const keep = (t, i) => i <= this.index || !t.auto;
      this.queue = this.queue.filter(keep);
      this.original = this.original.filter((t) => !t.auto || this.queue.includes(t));
    } else {
      this.#radioSeed = null;
      this.#fillAutoplay();
    }
    this.emit("queue");
    this.emit("state");
  }

  // Busca músicas parecidas quando faltam menos de 3 na fila. Devolve quantas adicionou.
  async #fillAutoplay(force = false) {
    const seed = this.current;
    if (this.remote || !this.autoplay || this.repeat === "all" || !seed || this.#radioBusy) return 0;
    if (this.queue.length - this.index - 1 >= 3) return 0;
    if (!force && this.#radioSeed === seed.id) return 0;
    this.#radioBusy = true;
    this.#radioSeed = seed.id;
    try {
      const res = await fetch(`/api/radio?id=${encodeURIComponent(seed.id)}`);
      if (!res.ok) return 0;
      const { items = [] } = await res.json();
      // Nada repetido: nem o que já está na fila, nem o que tocou há pouco
      const seen = new Set([...this.queue.map((t) => t.id), ...history.items.slice(0, 30).map((t) => t.id)]);
      const fresh = items.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 10).map((t) => ({ ...t, auto: true }));
      if (!fresh.length || !this.autoplay || this.remote) return 0;
      this.queue.push(...fresh);
      this.original.push(...fresh);
      this.emit("queue");
      return fresh.length;
    } catch {
      return 0;
    } finally {
      this.#radioBusy = false;
    }
  }

  // ---------- Fila ----------
  // Toca uma lista começando em startIndex (como clicar numa faixa de uma playlist)
  playList(tracks, startIndex = 0) {
    if (this.#forward("playList", arguments)) return;
    this.original = [...tracks];
    this.queue = [...tracks];
    this.index = startIndex;
    if (this.shuffle) this.#shuffleRest();
    this.#play({ fade: this.#manualFade() });
  }

  addToQueue(track) {
    if (this.#forward("addToQueue", arguments)) return;
    if (this.index < 0) return this.playList([track]);
    this.queue.splice(this.index + 1, 0, track);
    this.original.push(track);
    this.emit("queue");
  }

  jumpTo(i) {
    if (this.#forward("jumpTo", arguments)) return;
    this.index = i;
    this.#play({ fade: this.#manualFade() });
  }

  // Remove uma faixa que ainda vai tocar (a atual não pode ser removida)
  removeFromQueue(i) {
    if (this.#forward("removeFromQueue", arguments)) return;
    if (i <= this.index || i >= this.queue.length) return;
    const [t] = this.queue.splice(i, 1);
    const j = this.original.findIndex((o) => o.id === t.id);
    if (j >= 0) this.original.splice(j, 1);
    this.emit("queue");
  }

  toggle() {
    if (this.#forward("toggle", arguments)) return;
    if (!this.current) return;
    this.#finishFade(); // pausar no meio da mistura: fica só a faixa nova
    this.playing ? this.yt.pauseVideo() : this.yt.playVideo();
  }

  next() {
    if (this.#forward("next", arguments)) return;
    this.#advance(this.#manualFade());
  }

  // Vai para a próxima faixa (fade = 0: troca seca)
  #advance(fade = 0, style = "equal") {
    if (this.index < this.queue.length - 1) { this.index++; return this.#play({ fade, style }); }
    if (this.repeat === "all" && this.queue.length) { this.index = 0; return this.#play({ fade, style }); }
    // Fim da fila: com autoplay, busca o rádio na hora (caso ainda não tenha emendado) e segue
    if (this.autoplay && this.current) {
      this.#fillAutoplay(true).then((added) => {
        if (added && this.index < this.queue.length - 1) { this.index++; this.#play({ fade, style }); }
        else this.emit("state");
      });
      return;
    }
    this.emit("state"); // fim da fila
  }

  prev() {
    if (this.#forward("prev", arguments)) return;
    // Igual aos players comuns: se já passou de 3s, volta ao início da faixa
    if (this.progress().current > 3 || this.index === 0) return this.seek(0);
    this.index--;
    this.#play({ fade: this.#manualFade() });
  }

  seek(seconds) {
    if (this.#forward("seek", arguments)) return;
    if (!this.ready) return;
    this.#finishFade();
    this.yt.seekTo(seconds, true);
    this.emit("seek");
  }

  setVolume(v) {
    this.volume = v;
    Storage.set("volume", v);
    if (this.ready && !this.#fade) this.yt.setVolume(v); // durante a mistura, a rampa cuida disso
  }

  toggleShuffle() {
    if (this.#forward("toggleShuffle", arguments)) return;
    this.shuffle = !this.shuffle;
    const cur = this.current;
    if (this.shuffle) this.#shuffleRest();
    else if (cur) { this.queue = [...this.original]; this.index = this.queue.findIndex((t) => t.id === cur.id); }
    this.emit("state"); this.emit("queue");
  }

  #shuffleRest() {
    const cur = this.queue[this.index];
    const rest = this.queue.filter((_, i) => i !== this.index);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.queue = cur ? [cur, ...rest] : rest;
    this.index = cur ? 0 : -1;
  }

  cycleRepeat() {
    if (this.#forward("cycleRepeat", arguments)) return;
    this.repeat = { off: "all", all: "one", one: "off" }[this.repeat];
    this.emit("state");
  }

  // Jam (convidado): espelha o estado do anfitrião — mesma fila, mesma faixa, mesmo segundo.
  // Só corrige a posição se a diferença passar de 1,2 s, para não ficar "engasgando".
  // Se o anfitrião está no meio de uma transição, o convidado faz a mesma mistura.
  applyRemoteState(s) {
    const loadedId = this.#decks[this.#active]?.videoId ?? null;
    this.queue = s.queue;
    this.original = [...s.queue];
    this.index = Math.min(Math.max(s.index, -1), s.queue.length - 1);
    this.shuffle = !!s.shuffle;
    this.repeat = ["off", "all", "one"].includes(s.repeat) ? s.repeat : "off";
    const t = this.current;
    if (this.ready) {
      const target = Math.max(0, +s.position || 0) + (s.playing ? 0.15 : 0); // ~latência da rede
      if (!t) {
        this.#finishFade();
        this.yt.stopVideo();
      } else if (t.id !== loadedId) {
        const fade = s.playing ? clamp(Number(s.fade) || 0, 0, 15) : 0;
        this.#switchTo(t, { fade, style: s.fadeStyle === "automix" ? "automix" : "equal", startSeconds: target, play: s.playing });
        history.push(t);
        this.emit("track", t);
      } else {
        if (!this.#fade && Math.abs((this.yt.getCurrentTime() || 0) - target) > 1.2) this.yt.seekTo(target, true);
        if (s.playing && !this.playing) this.yt.playVideo();
        if (!s.playing && this.playing) { this.#finishFade(); this.yt.pauseVideo(); }
      }
    }
    this.emit("queue");
    this.emit("state");
  }

  progress() {
    const yt = this.yt;
    if (!this.ready || !yt?.getDuration) return { current: 0, duration: 0 };
    return { current: yt.getCurrentTime() || 0, duration: yt.getDuration() || 0 };
  }
}
export const player = new Player();

