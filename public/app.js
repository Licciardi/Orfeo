import { player, library, history, profile, Search, Lyrics, Storage } from "./platform.js";
import { viz } from "./visualizer.js";
import { jam } from "./jam.js";
import { deckFx } from "./deckfx.js";
import { friends, formatCode } from "./friends.js";
import { MixWaves } from "./mixwaves.js";
import { safeThumb } from "./net.js";

const ICON_JAM = `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2a5 5 0 0 1 5.5 4.8"/></svg>`;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const view = $("#view");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
}

// ---------- Componentes ----------
// Lista de faixas reutilizada em todas as views. `ctx.playlistId` habilita o "remover".
function trackList(tracks, ctx = {}) {
  if (!tracks.length) return `<p class="empty">${ctx.empty || "Nenhuma faixa aqui ainda."}</p>`;
  const cur = player.current?.id;
  return `<ol class="tracks">${tracks.map((t, i) => `
    <li class="track ${t.id === cur ? "is-current" : ""}" data-i="${i}">
      <span class="t-num">${i + 1}</span>
      <img referrerpolicy="no-referrer" src="${esc(t.thumb)}" data-vid="${esc(t.id)}" alt="" loading="lazy" />
      <div class="t-meta"><div class="t-title">${esc(t.title)}</div><div class="t-artist">${esc(t.artist)}</div></div>
      <span class="t-dur">${esc(t.duration || "")}</span>
      <div class="t-actions">
        <button class="icon-btn" data-act="like" title="Curtir">${library.isLiked(t.id) ? "♥" : "♡"}</button>
        <button class="icon-btn" data-act="queue" title="Adicionar à fila">⊕</button>
        <button class="icon-btn" data-act="add" title="Adicionar à playlist">＋</button>
        ${ctx.playlistId ? `<button class="icon-btn" data-act="remove" title="Remover">✕</button>` : ""}
      </div>
    </li>`).join("")}</ol>`;
}

function bindTrackList(root, tracks, ctx = {}) {
  root.querySelectorAll(".track").forEach((li) => {
    const i = +li.dataset.i, t = tracks[i];
    li.addEventListener("dblclick", () => player.playList(tracks, i));
    li.querySelector(".t-num").addEventListener("click", () => player.playList(tracks, i));
    li.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === "like") { library.toggleLike(t); b.textContent = library.isLiked(t.id) ? "♥" : "♡"; }
      if (act === "queue") { player.addToQueue(jam.active ? { ...t, addedBy: jam.myId } : t); toast("Adicionada à fila"); }
      if (act === "add") pickPlaylist(t, b);
      if (act === "remove") library.removeFromPlaylist(ctx.playlistId, t.id);
    }));
  });
}

// ---------- Cards 3D dos resultados da busca ----------
// Inspirado no "Pure CSS parallax card on :hover" (Ana Tudor): o card inclina em 3D na direção do
// mouse, o texto flutua à frente (parallax) e um brilho corre pela superfície. No original a
// inclinação vem de uma grade de "armadilhas" invisíveis em CSS; aqui os cards têm botões
// clicáveis, então a posição do mouse vira --di/--dj (de -1 a 1) por JS — mesmas fórmulas no CSS.
const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>`;

// Capa em resolução maior para o card (a lista usa miniaturas pequenas)
function cardCover(t) {
  const safe = safeThumb(t.thumb);
  if (!safe) return `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
  return safe.replace(/=w\d+-h\d+[^/]*$/, "=w544-h544-l90-rj").replace(/\/mqdefault\.jpg$/, "/hqdefault.jpg");
}

function trackCards(tracks, ctx = {}) {
  if (!tracks.length) return `<p class="empty">${ctx.empty || "Nada encontrado."}</p>`;
  const cur = player.current?.id;
  return `<div class="tcards">${tracks.map((t, i) => `
    <div class="tcard-scene">
      <article class="tcard ${t.id === cur ? "is-current" : ""}" data-i="${i}" data-id="${esc(t.id)}" tabindex="0"
        aria-label="${esc(t.title)} — ${esc(t.artist)}">
        <div class="tcard-face"><img class="tcard-img" referrerpolicy="no-referrer" src="${esc(cardCover(t))}" data-vid="${esc(t.id)}" alt="" loading="lazy" /></div>
        <span class="tcard-now"><span class="tcard-eq"><i></i><i></i><i></i></span>Tocando</span>
        <div class="tcard-actions">
          <button class="tcard-btn" data-act="like" title="Curtir">${library.isLiked(t.id) ? "♥" : "♡"}</button>
          <button class="tcard-btn" data-act="queue" title="Adicionar à fila">⊕</button>
          <button class="tcard-btn" data-act="add" title="Adicionar à playlist">＋</button>
        </div>
        <div class="tcard-text">
          <h3>${esc(t.title)}</h3>
          <p>${esc(t.artist)}${t.duration ? ` <span>• ${esc(t.duration)}</span>` : ""}</p>
        </div>
        <button class="tcard-play" data-act="play" title="Tocar" aria-label="Tocar ${esc(t.title)}">${ICON_PLAY}</button>
      </article>
    </div>`).join("")}</div>`;
}

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function bindTrackCards(root, tracks) {
  root.querySelectorAll(".tcard").forEach((card) => {
    const i = +card.dataset.i, t = tracks[i];
    const scene = card.parentElement;
    // Inclinação 3D: posição do mouse na cena → -1..1 nos dois eixos
    scene.addEventListener("pointermove", (e) => {
      if (reduceMotion.matches) return;
      const r = scene.getBoundingClientRect();
      card.style.setProperty("--di", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
      card.style.setProperty("--dj", (1 - ((e.clientY - r.top) / r.height) * 2).toFixed(3));
      card.classList.add("is-tilted");
    });
    scene.addEventListener("pointerleave", () => {
      card.style.setProperty("--di", 0);
      card.style.setProperty("--dj", 0);
      card.classList.remove("is-tilted");
    });
    // Clicar no card (fora dos botões) ou Enter: toca a partir dele
    card.addEventListener("click", (e) => { if (!e.target.closest("[data-act]")) player.playList(tracks, i); });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) player.playList(tracks, i); });
    card.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === "play") player.playList(tracks, i);
      if (act === "like") { library.toggleLike(t); b.textContent = library.isLiked(t.id) ? "♥" : "♡"; }
      if (act === "queue") { player.addToQueue(jam.active ? { ...t, addedBy: jam.myId } : t); toast("Adicionada à fila"); }
      if (act === "add") pickPlaylist(t, b);
    }));
  });
}

// Menu flutuante para escolher em qual playlist salvar
function pickPlaylist(track, anchor) {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = `<button data-new>＋ Nova playlist</button>` +
    library.playlists.map((p) => `<button data-id="${p.id}">${esc(p.name)}</button>`).join("");
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 220)}px`;
  menu.style.left = `${Math.min(r.left - 120, innerWidth - 220)}px`;
  document.body.append(menu);
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const pl = b.dataset.new !== undefined ? newPlaylist() : library.getPlaylist(b.dataset.id);
    if (pl) { library.addToPlaylist(pl.id, track); toast(`Adicionada a "${pl.name}"`); }
    menu.remove();
  });
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
}

function newPlaylist() {
  const name = prompt("Nome da playlist:", `Minha playlist #${library.playlists.length + 1}`);
  return name?.trim() ? library.createPlaylist(name.trim()) : null;
}

function card(href, img, title, sub) {
  return `<a class="card" href="${href}"><div class="card-img">${img}</div><div class="card-title">${esc(title)}</div><div class="card-sub">${esc(sub)}</div></a>`;
}
const cover = (pl) => pl.tracks[0] ? `<img referrerpolicy="no-referrer" src="${esc(pl.tracks[0].thumb)}" alt="" />` : `<span>♪</span>`;

// ---------- Views (rotas) ----------
const routes = {
  home() {
    const hour = new Date().getHours();
    const greet = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
    view.innerHTML = `
      <h1>${greet}${profile.name ? `, ${esc(profile.name.split(" ")[0])}` : ""}</h1>
      <section><h2>Tocadas recentemente</h2><div id="recent"></div></section>
      <section><h2>Suas playlists</h2><div class="grid">
        ${card("#/liked", "<span>♥</span>", "Músicas curtidas", `${library.liked.length} faixas`)}
        ${library.playlists.map((p) => card(`#/playlist/${p.id}`, cover(p), p.name, `${p.tracks.length} faixas`)).join("")}
      </div></section>`;
    const recent = $("#recent");
    const recentTracks = history.items.slice(0, 12);
    recent.innerHTML = trackCards(recentTracks, { empty: "Toque algo pela busca para começar." });
    bindTrackCards(recent, recentTracks);
  },

  search() {
    view.innerHTML = `
      <h1>Buscar</h1>
      <form id="search-form" class="search-bar">
        <input id="q" placeholder="Músicas, artistas… ou cole um link do YouTube / YouTube Music" autocomplete="off" />
        <button class="pill">Buscar</button>
      </form>
      <div class="chips" id="search-type">
        <button type="button" data-type="songs">Músicas</button>
        <button type="button" data-type="videos">Vídeos</button>
      </div>
      <div id="results"></div>`;
    const q = $("#q");
    let type = sessionStorage.getItem("searchType") || "songs";
    const chips = view.querySelectorAll("#search-type button");
    const markType = () => chips.forEach((b) => b.classList.toggle("active", b.dataset.type === type));
    markType();
    chips.forEach((b) => b.addEventListener("click", () => {
      type = b.dataset.type;
      sessionStorage.setItem("searchType", type);
      markType();
      if (q.value.trim()) $("#search-form").requestSubmit();
    }));
    q.value = sessionStorage.getItem("lastQuery") || "";
    q.focus();
    $("#search-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = q.value.trim();
      if (!text) return;
      sessionStorage.setItem("lastQuery", text);
      const out = $("#results");
      out.innerHTML = `<p class="empty">Buscando…</p>`;
      try {
        const link = /youtu\.?be/.test(text) ? await Search.fromLink(text) : null;
        const tracks = link ? [link] : await Search.query(text, type);
        out.innerHTML = trackCards(tracks, { empty: "Nada encontrado." });
        bindTrackCards(out, tracks);
      } catch (err) {
        out.innerHTML = `<p class="empty error">${esc(err.message)}</p>`;
      }
    });
    if (q.value) $("#search-form").requestSubmit();
  },

  library() {
    view.innerHTML = `
      <div class="row"><h1>Sua biblioteca</h1><button id="lib-new" class="pill">＋ Nova playlist</button></div>
      <div class="grid">
        ${card("#/liked", "<span>♥</span>", "Músicas curtidas", `${library.liked.length} faixas`)}
        ${library.playlists.map((p) => card(`#/playlist/${p.id}`, cover(p), p.name, `${p.tracks.length} faixas`)).join("")}
      </div>`;
    $("#lib-new").addEventListener("click", () => { const p = newPlaylist(); if (p) location.hash = `#/playlist/${p.id}`; });
  },

  liked() {
    collectionView({ title: "Músicas curtidas", kind: "Coleção", tracks: library.liked, coverHtml: "<span>♥</span>" });
  },

  playlist(id) {
    const pl = library.getPlaylist(id);
    if (!pl) { view.innerHTML = `<p class="empty">Playlist não encontrada.</p>`; return; }
    collectionView({ title: pl.name, kind: "Playlist", tracks: pl.tracks, coverHtml: cover(pl), playlistId: pl.id });
    $("#pl-rename").addEventListener("click", () => {
      const n = prompt("Novo nome:", pl.name);
      if (n?.trim()) library.renamePlaylist(pl.id, n.trim());
    });
    $("#pl-delete").addEventListener("click", () => {
      if (confirm(`Excluir "${pl.name}"?`)) { library.deletePlaylist(pl.id); location.hash = "#/library"; }
    });
  },

  profile() {
    const swatches = ["#ff4d6d", "#ff8a3d", "#f5c400", "#2ed47a", "#1ec8c8", "#3d8bff", "#8b5cf6", "#ec4899"];
    const top = history.topArtists();
    view.innerHTML = `
      <header class="profile-hero">
        <button id="avatar-btn" class="avatar avatar-xl" title="Trocar foto">
          ${avatarInner()}
          <span class="avatar-edit">
            <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
            Trocar foto
          </span>
        </button>
        <input id="avatar-file" type="file" accept="image/*" hidden />
        <div class="profile-meta">
          <div class="hero-kind">Perfil</div>
          <input id="profile-name" class="profile-name" maxlength="30" placeholder="Seu nome" value="${esc(profile.name)}" aria-label="Nome" />
          <div class="hero-sub">${library.playlists.length} playlists • ${library.liked.length} curtidas • ${history.totalPlays} músicas tocadas</div>
        </div>
      </header>

      <section class="profile-section">
        <h2>Personalizar</h2>
        <div class="setting">
          <div><div class="setting-title">Foto</div><div class="setting-sub">Clique na foto ou escolha um arquivo. Aceita GIF animado (até 1 MB).</div></div>
          <div class="setting-actions">
            <button id="photo-pick" class="pill ghost">Escolher foto</button>
            ${profile.photo ? `<button id="photo-remove" class="pill ghost">Remover</button>` : ""}
          </div>
        </div>
        <div class="setting">
          <div><div class="setting-title">Cor do app</div><div class="setting-sub">Muda a cor de destaque em todo o Orfeo.</div></div>
          <div class="swatches">
            ${swatches.map((c) => `<button class="swatch ${c === profile.accent ? "active" : ""}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join("")}
            <label class="swatch swatch-custom ${swatches.includes(profile.accent) ? "" : "active"}" title="Outra cor" style="--c:${esc(profile.accent)}">
              <input id="accent-custom" type="color" value="${esc(profile.accent)}" />
            </label>
          </div>
        </div>
      </section>

      <section class="profile-section">
        <h2>Reprodução</h2>
        <div class="setting setting-col">
          <div>
            <div class="setting-title">Transição entre músicas</div>
            <div class="setting-sub" id="mix-desc"></div>
          </div>
          <div class="segmented" id="mix-mode" role="radiogroup" aria-label="Transição entre músicas">
            <button data-mode="off" role="radio">Desligada</button>
            <button data-mode="crossfade" role="radio">Crossfade</button>
            <button data-mode="automix" role="radio">Automix</button>
          </div>
          <div class="mix-slider" id="mix-slider">
            <input type="range" id="mix-seconds" min="1" max="12" step="1" value="${player.mixSeconds}" aria-label="Duração do crossfade" />
            <span id="mix-seconds-val">${player.mixSeconds} s</span>
          </div>
          <label class="autoplay-row setting-toggle ${window.orfeoDesktop ? "" : "is-disabled"}">
            <span>
              <span class="autoplay-title">Transição instrumental</span>
              <span class="autoplay-sub">${window.orfeoDesktop
                ? "Tira a voz durante a mistura: as duas músicas se encontram só no instrumental."
                : "Disponível só no app desktop (ele processa o áudio de cada música)."}</span>
            </span>
            <span class="switch"><input type="checkbox" id="mix-instrumental" ${player.instrumental ? "checked" : ""} ${window.orfeoDesktop ? "" : "disabled"} /><span class="switch-track"></span></span>
          </label>
        </div>
      </section>

      <section class="profile-section">
        <h2>Mais ouvidos recentemente</h2>
        ${top.length ? `<div class="artists">${top.map((a) => `
          <div class="artist">
            <div class="artist-img">${a.thumb ? `<img referrerpolicy="no-referrer" src="${esc(a.thumb)}" alt="" loading="lazy" />` : "<span>♪</span>"}</div>
            <div class="artist-name">${esc(a.name)}</div>
            <div class="artist-sub">${a.plays} ${a.plays === 1 ? "vez" : "vezes"}</div>
          </div>`).join("")}</div>`
        : `<p class="empty">Ouça algumas músicas para ver seus artistas aqui.</p>`}
      </section>`;

    const file = $("#avatar-file");
    const pick = () => file.click();
    $("#avatar-btn").addEventListener("click", pick);
    $("#photo-pick").addEventListener("click", pick);
    file.addEventListener("change", async () => {
      if (!file.files[0]) return;
      try { profile.setPhoto(await profile.photoFromFile(file.files[0])); toast("Foto atualizada"); }
      catch (err) { toast(err.message || "Não deu para usar essa imagem"); }
    });
    $("#photo-remove")?.addEventListener("click", () => profile.setPhoto(""));

    const name = $("#profile-name");
    name.addEventListener("change", () => { profile.setName(name.value); toast("Nome salvo"); });
    name.addEventListener("keydown", (e) => e.key === "Enter" && name.blur());

    view.querySelectorAll(".swatch[data-color]").forEach((b) => b.addEventListener("click", () => profile.setAccent(b.dataset.color)));
    $("#accent-custom").addEventListener("input", (e) => applyAccent(e.target.value)); // pré-visualiza ao arrastar
    $("#accent-custom").addEventListener("change", (e) => profile.setAccent(e.target.value));

    // Transição entre músicas
    const renderMix = () => {
      view.querySelectorAll("#mix-mode button").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === player.mixMode);
        b.setAttribute("aria-checked", b.dataset.mode === player.mixMode);
      });
      $("#mix-slider").hidden = player.mixMode !== "crossfade";
      $("#mix-desc").textContent = mixDescription();
    };
    view.querySelectorAll("#mix-mode button").forEach((b) => b.addEventListener("click", () => {
      player.setMixMode(b.dataset.mode);
      renderMix();
      ensureAutomixEars();
    }));
    const secs = $("#mix-seconds");
    secs.addEventListener("input", () => { $("#mix-seconds-val").textContent = `${secs.value} s`; });
    secs.addEventListener("change", () => player.setMixSeconds(secs.value));
    $("#mix-instrumental").addEventListener("change", (e) => player.setInstrumental(e.target.checked));
    renderMix();
  },

  // Amigos + Jam no mesmo lugar: painel da Jam no topo, seu código e a lista de amigos embaixo
  friends() {
    view.innerHTML = `
      <h1>Amigos</h1>
      <section id="jam-section"></section>
      <div class="friends-top">
        <div class="friend-code-card">
          <div>
            <div class="setting-sub">Seu código de amigo</div>
            <div class="friend-code">${esc(formatCode(friends.code))}</div>
          </div>
          <button id="fc-copy" class="pill ghost">Copiar</button>
        </div>
        <form id="friend-add" class="jam-join friend-add">
          <input id="friend-code-input" maxlength="9" placeholder="Código do amigo" autocomplete="off" spellcheck="false" />
          <button class="pill">Adicionar</button>
        </form>
      </div>
      <div id="friends-body"></div>`;
    $("#fc-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(formatCode(friends.code)); toast("Código copiado"); }
      catch { toast(`Seu código: ${formatCode(friends.code)}`); }
    });
    $("#friend-add").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("#friend-code-input");
      try { await friends.add(input.value); input.value = ""; toast("Pedido enviado"); }
      catch (err) { toast(err.message); }
    });
    renderJamSection();
    renderFriendsBody();
  },

  // Endereço antigo da Jam: agora ela mora dentro de Amigos
  jam() { location.replace("#/friends"); },

  // Visualizador em Canvas. Fica na área central para o vídeo continuar visível à direita.
  visualizer() {
    view.classList.add("view--viz");
    const desktop = !!window.orfeoDesktop;
    view.innerHTML = `
      <canvas id="viz-canvas" class="viz-canvas"></canvas>
      <div class="segmented viz-style" id="viz-style" role="radiogroup" aria-label="Estilo do visualizador">
        <button data-style="ring" role="radio">Círculo</button>
        <button data-style="waves" role="radio">Ondas</button>
      </div>
      <div class="viz-info"><div id="viz-title" class="viz-title"></div><div id="viz-artist" class="viz-artist"></div></div>
      <div id="viz-cta" class="viz-cta" hidden>
        <button id="viz-enable" class="pill">Ativar visualizador</button>
        <p>${desktop
          ? "O Orfeo vai ouvir o som do computador para reagir às batidas."
          : "Na janela do Chrome, escolha <b>esta guia</b> e marque <b>“Compartilhar áudio da guia”</b>. O vídeo não é gravado: só o som é analisado."}</p>
      </div>`;
    viz.mount($("#viz-canvas"));
    const markStyle = () => view.querySelectorAll("#viz-style button").forEach((b) => {
      b.classList.toggle("active", b.dataset.style === viz.style);
      b.setAttribute("aria-checked", b.dataset.style === viz.style);
    });
    view.querySelectorAll("#viz-style button").forEach((b) => b.addEventListener("click", () => {
      viz.style = b.dataset.style;
      Storage.set("vizStyle", viz.style);
      markStyle();
    }));
    markStyle();
    updateVizInfo();
    const cta = $("#viz-cta");
    const refresh = () => (cta.hidden = viz.listening || deckFx.available);
    viz.onchange = refresh;
    refresh();
    const enable = () => viz.enableAudio().catch((err) => {
      if (err.name !== "NotAllowedError") toast(err.message);
    });
    $("#viz-enable").addEventListener("click", enable);
    // No app desktop os decks já mandam o som direto; a captura do sistema é só plano B
    if (desktop && !viz.listening && !deckFx.available) enable();
    return () => { viz.unmount(); viz.onchange = null; view.classList.remove("view--viz"); };
  },
};

// ---------- Transições (crossfade / automix) ----------
function mixDescription() {
  const desktop = !!window.orfeoDesktop;
  return {
    off: "Troca seca entre as músicas.",
    crossfade: "A próxima música entra enquanto a atual sai, pelo tempo que você escolher.",
    automix: "Escuta a música para achar o fim de verdade (outro, fade-out) e a batida, e mistura por 4 compassos no tempo certo." +
      (desktop ? "" : " No navegador, ligue o Visualizador para o modo inteligente; sem ele, a mistura é de 7 s."),
  }[player.mixMode];
}

// No app desktop o Automix liga a escuta do som sozinho (sem pergunta). Se o Chromium pedir
// um clique antes de capturar, tenta de novo na primeira interação.
function ensureAutomixEars() {
  // Com o processador dos decks, o Automix já escuta só o Orfeo: não precisa capturar o sistema
  if (!window.orfeoDesktop || player.mixMode !== "automix" || viz.hasAudio || deckFx.available) return;
  viz.enableAudio().catch(() => {
    addEventListener("pointerdown", () => viz.enableAudio().catch(() => {}), { once: true, capture: true });
  });
}

// ---------- Jam: indicador na barra + avisos ----------
// Iniciais só com letras ("Luigi (teste)" → "LT", não "L(")
function initialsOf(name) {
  const letters = String(name || "").split(/\s+/).map((w) => w.match(/\p{L}/u)?.[0]).filter(Boolean);
  return ((letters[0] || "?") + (letters.length > 1 ? letters.at(-1) : "")).toUpperCase();
}
// Avatar de quem está na Jam (foto/GIF validados pelo jam.js, ou iniciais)
function memberAvatar(m, cls = "avatar-md") {
  const inner = m?.photo ? `<img src="${esc(m.photo)}" alt="" />` : `<span class="avatar-initials">${esc(initialsOf(m?.name))}</span>`;
  return `<span class="avatar ${cls}" title="${esc(m?.name ?? "")}">${inner}</span>`;
}

function renderJamIndicator() {
  const btn = $("#btn-jam");
  const live = jam.status === "live";
  btn.classList.toggle("on", live);
  $("#jam-count").textContent = live && jam.members.length > 1 ? jam.members.length : "";
  btn.title = live ? `Jam ao vivo (${jam.members.length})` : "Amigos e Jam";
  // Fotos de quem está na Jam, sobrepostas, sempre visíveis na barra
  const stack = $("#jam-stack");
  const shown = live ? jam.members.slice(0, 4) : [];
  stack.innerHTML = shown.map((m) => memberAvatar(m, "avatar-xs")).join("") +
    (live && jam.members.length > 4 ? `<span class="avatar avatar-xs jam-more">+${jam.members.length - 4}</span>` : "");
  stack.hidden = !shown.length;
  stack.title = jam.members.map((m) => m.name).join(", ");
}
jam.on("change", () => {
  renderJamIndicator();
  renderQueue(); // atualiza as fotinhas de "quem adicionou"
  renderJamSection(); // o painel da Jam fica dentro de Amigos
});
jam.on("toast", toast);

// ---------- Painel da Jam (dentro de Amigos) ----------
function renderJamSection() {
  const box = document.getElementById("jam-section");
  if (!box) return;

  if (!jam.active) {
    box.innerHTML = `
      <div class="jam-panel">
        <div class="jam-panel-head">
          <div class="jam-card-icon">${ICON_JAM}</div>
          <div>
            <h2>Jam</h2>
            <p>Ouçam juntos: a mesma música, no mesmo segundo. Todo mundo pode pausar, pular e adicionar músicas.</p>
          </div>
        </div>
        <div class="jam-panel-actions">
          <button id="jam-host" class="pill">Iniciar Jam</button>
          <span class="jam-or">ou</span>
          <form id="jam-join" class="jam-join">
            <input id="jam-code" maxlength="7" placeholder="Código da Jam" autocomplete="off" spellcheck="false" />
            <button class="pill ghost">Entrar</button>
          </form>
        </div>
        ${profile.name ? "" : `<p class="jam-hint">Dica: coloque seu nome e foto no <a href="#/profile">perfil</a> para seus amigos saberem quem está na Jam.</p>`}
      </div>`;
    $("#jam-host").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await jam.host(); } catch (err) { toast(err.message); e.target.disabled = false; }
    });
    $("#jam-join").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await jam.join($("#jam-code").value); } catch (err) { toast(err.message); }
    });
    return;
  }

  if (jam.status === "connecting") {
    box.innerHTML = `<div class="jam-panel"><div class="jam-connecting"><span class="jam-spinner"></span>${jam.role === "host" ? "Criando a Jam…" : "Entrando na Jam…"}</div></div>`;
    return;
  }

  const isHost = jam.role === "host";
  box.innerHTML = `
    <div class="jam-panel is-live">
      <div class="jam-live-top">
        <div>
          <div class="jam-badge"><span class="jam-dot"></span> Jam ao vivo</div>
          <h2>${isHost ? "Sua Jam" : `Jam de ${esc(jam.hostName || "um amigo")}`}</h2>
          <p>${isHost
            ? "Chame um amigo pela lista abaixo, ou mande o código para ele entrar:"
            : "Você está ouvindo junto. Pausar, pular e adicionar músicas muda pra todo mundo."}</p>
        </div>
        <button id="jam-leave" class="pill ghost">${isHost ? "Encerrar Jam" : "Sair da Jam"}</button>
      </div>
      ${isHost ? `
        <div class="jam-code-row">
          <div class="jam-code">${esc(jam.code.slice(0, 3))}<span>${esc(jam.code.slice(3))}</span></div>
          <button id="jam-copy" class="pill ghost">Copiar código</button>
        </div>` : ""}
      <div class="jam-people">
        ${jam.members.map((m) => `
          <span class="jam-person">
            ${memberAvatar(m, "avatar-sm")}
            <span>${esc(m.name)}</span>
            ${m.host ? `<span class="jam-tag">anfitrião</span>` : ""}
          </span>`).join("")}
        ${isHost && jam.members.length === 1 ? `<span class="jam-waiting">Esperando alguém entrar…</span>` : ""}
      </div>
    </div>`;
  $("#jam-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(jam.code); toast("Código copiado"); }
    catch { toast(`Código: ${jam.code}`); }
  });
  $("#jam-leave").addEventListener("click", () => {
    if (!isHost || confirm("Encerrar a Jam para todo mundo?")) jam.leave();
  });
}

// ---------- Amigos ----------
// Lista (re-renderizada quando algo muda, sem mexer no campo de adicionar)
function renderFriendsBody() {
  const body = document.getElementById("friends-body");
  if (!body) return;
  const pres = (code) => friends.presence.get(code) || {};
  const rank = (f) => { const p = pres(f.code); return (p.online ? 0 : 2) + (p.online && p.track && p.playing ? -1 : 0); };
  const list = [...friends.list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const online = list.filter((f) => pres(f.code).online).length;

  const row = (f) => {
    const p = pres(f.code);
    const who = { name: p.name || f.name, photo: p.photo || f.photo };
    const inMyJam = p.jam && jam.status === "live" && p.jam === jam.code;
    let status = "Offline";
    if (p.online) {
      status = p.track ? `${p.playing ? "♪ Ouvindo" : "Pausado:"} ${esc(p.track.title)} <span>— ${esc(p.track.artist)}</span>` : "Online";
      if (p.jam) status += inMyJam ? " • na sua Jam" : " • numa Jam";
    }
    const action = !p.online ? ""
      : inMyJam ? `<span class="jam-tag">na Jam</span>`
      : p.jam ? `<button class="pill" data-join="${esc(p.jam)}" data-name="${esc(who.name)}">Entrar na Jam</button>`
      : `<button class="pill ghost" data-invite="${esc(f.code)}" data-name="${esc(who.name)}">Chamar para Jam</button>`;
    return `
      <li class="friend ${p.online ? "is-online" : ""}">
        <span class="friend-avatar">${memberAvatar(who, "avatar-md")}<span class="presence-dot"></span></span>
        <div class="friend-meta">
          <div class="friend-name">${esc(who.name)}</div>
          <div class="friend-status">${status}</div>
        </div>
        ${p.online && p.track ? `<img class="friend-track" referrerpolicy="no-referrer" src="${esc(p.track.thumb)}" data-vid="${esc(p.track.id)}" alt="" title="${esc(p.track.title)}" />` : ""}
        <div class="friend-actions">
          ${action}
          <button class="icon-btn" data-remove="${esc(f.code)}" data-name="${esc(who.name)}" title="Desfazer amizade">✕</button>
        </div>
      </li>`;
  };

  body.innerHTML = `
    ${friends.status !== "online" ? `<p class="friends-status"><span class="jam-spinner"></span> Conectando ao servidor de amigos…</p>` : ""}
    ${friends.incoming.length ? `
      <section class="profile-section">
        <h2>Pedidos de amizade</h2>
        <ul class="friends-list">${friends.incoming.map((r) => `
          <li class="friend">
            <span class="friend-avatar">${memberAvatar(r, "avatar-md")}</span>
            <div class="friend-meta"><div class="friend-name">${esc(r.name)}</div><div class="friend-status">${esc(formatCode(r.code))} quer ser seu amigo</div></div>
            <div class="friend-actions">
              <button class="pill" data-accept="${esc(r.code)}">Aceitar</button>
              <button class="pill ghost" data-decline="${esc(r.code)}">Recusar</button>
            </div>
          </li>`).join("")}</ul>
      </section>` : ""}
    <section class="profile-section">
      <h2>Seus amigos${list.length ? ` <span class="friends-count">${online} online</span>` : ""}</h2>
      ${list.length ? `<ul class="friends-list">${list.map(row).join("")}</ul>`
        : `<p class="empty">Mande seu código para um amigo, ou adicione o código dele aqui em cima.</p>`}
    </section>
    ${friends.outgoing.length ? `
      <section class="profile-section">
        <h2>Pedidos enviados</h2>
        <ul class="friends-list">${friends.outgoing.map((r) => `
          <li class="friend">
            <span class="friend-avatar"><span class="avatar avatar-md"><span class="avatar-initials">?</span></span></span>
            <div class="friend-meta"><div class="friend-name">${esc(formatCode(r.code))}</div><div class="friend-status">Esperando aceitar (o pedido chega quando ele estiver online)</div></div>
            <div class="friend-actions"><button class="pill ghost" data-cancel="${esc(r.code)}">Cancelar</button></div>
          </li>`).join("")}</ul>
      </section>` : ""}
    <label class="autoplay-row setting-toggle friends-share">
      <span>
        <span class="autoplay-title">Mostrar o que estou ouvindo</span>
        <span class="autoplay-sub">Seus amigos veem a música que está tocando e se você abriu uma Jam.</span>
      </span>
      <span class="switch"><input type="checkbox" id="friends-share" ${friends.share ? "checked" : ""} /><span class="switch-track"></span></span>
    </label>`;

  body.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", () => friends.accept(b.dataset.accept)));
  body.querySelectorAll("[data-decline]").forEach((b) => b.addEventListener("click", () => friends.decline(b.dataset.decline)));
  body.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => friends.cancelRequest(b.dataset.cancel)));
  body.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
    if (confirm(`Desfazer amizade com ${b.dataset.name}?`)) friends.remove(b.dataset.remove);
  }));
  body.querySelectorAll("[data-join]").forEach((b) => b.addEventListener("click", () => joinFriendJam(b.dataset.join, b.dataset.name)));
  body.querySelectorAll("[data-invite]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      if (!jam.active) await jam.host(); // ainda não tem Jam: cria uma na hora
      if (friends.invite(b.dataset.invite)) toast(`Convite enviado para ${b.dataset.name}`);
    } catch (err) { toast(err.message); }
    b.disabled = false;
  }));
  $("#friends-share").addEventListener("change", (e) => friends.setShare(e.target.checked));
}

async function joinFriendJam(code, name) {
  if (jam.active) {
    if (jam.code === code) return (location.hash = "#/friends");
    if (!confirm(`Sair da Jam atual e entrar na de ${name}?`)) return;
    jam.leave(true);
  }
  try { await jam.join(code); location.hash = "#/friends"; }
  catch (err) { toast(err.message); }
}

// Convite de amigo: cartão com botão "Entrar" (some sozinho em 30 s)
function showInvite({ name, photo, jam: code }) {
  document.querySelector(".invite-card")?.remove();
  const card = document.createElement("div");
  card.className = "invite-card";
  card.innerHTML = `
    ${memberAvatar({ name, photo }, "avatar-md")}
    <div class="invite-text"><b>${esc(name)}</b> te chamou para a Jam</div>
    <button class="pill" data-go>Entrar</button>
    <button class="icon-btn" data-close title="Fechar">✕</button>`;
  document.body.append(card);
  const close = () => card.remove();
  card.querySelector("[data-go]").addEventListener("click", () => { close(); joinFriendJam(code, name); });
  card.querySelector("[data-close]").addEventListener("click", close);
  setTimeout(close, 30_000);
}

function renderFriendsNav() {
  const n = friends.onlineCount;
  $("#friends-online").textContent = n ? n : "";
  if (friends.incoming.length) $("#friends-online").textContent = "•";
}

friends.on("change", () => { renderFriendsNav(); renderFriendsBody(); });
friends.on("toast", toast);
friends.on("invite", showInvite);
jam.on("change", () => renderFriendsBody());

// ---------- Perfil: avatar, chip do menu e cor de destaque ----------
function avatarInner() {
  return profile.photo
    ? `<img src="${profile.photo}" alt="" />`
    : `<span class="avatar-initials">${esc(profile.initials)}</span>`;
}

function renderProfileChip() {
  $("#profile-chip-avatar").innerHTML = avatarInner();
  $("#profile-chip-name").textContent = profile.name || "Seu perfil";
}

function applyAccent(color) {
  const root = document.documentElement.style;
  root.setProperty("--accent", color);
  root.setProperty("--accent-2", `color-mix(in srgb, ${color} 65%, #ffb36b)`); // par do degradê
}

profile.on("change", () => {
  applyAccent(profile.accent);
  renderProfileChip();
  // re-renderiza o perfil (foto/cor) sem atrapalhar quem está digitando o nome
  if (location.hash === "#/profile" && document.activeElement?.id !== "profile-name") render();
});

function updateVizInfo() {
  const t = player.current;
  const title = document.getElementById("viz-title");
  if (!title) return;
  title.textContent = t?.title ?? "Nada tocando";
  $("#viz-artist").textContent = t?.artist ?? "";
}

function collectionView({ title, kind, tracks, coverHtml, playlistId }) {
  view.innerHTML = `
    <header class="hero">
      <div class="hero-cover">${coverHtml}</div>
      <div><div class="hero-kind">${kind}</div><h1>${esc(title)}</h1><div class="hero-sub">${tracks.length} faixas</div></div>
    </header>
    <div class="row actions">
      <button id="pl-play" class="play-btn big" ${tracks.length ? "" : "disabled"}>▶</button>
      <button id="pl-shuffle" class="pill" ${tracks.length ? "" : "disabled"}>⤮ Aleatório</button>
      ${playlistId ? `<button id="pl-rename" class="pill ghost">Renomear</button><button id="pl-delete" class="pill ghost">Excluir</button>` : ""}
    </div>
    <div id="list">${trackList(tracks, { playlistId, empty: "Use a busca e o botão ＋ para adicionar faixas." })}</div>`;
  bindTrackList($("#list"), tracks, { playlistId });
  $("#pl-play").addEventListener("click", () => player.playList(tracks, 0));
  $("#pl-shuffle").addEventListener("click", () => {
    if (!player.shuffle) player.toggleShuffle();
    player.playList(tracks, Math.floor(Math.random() * tracks.length));
  });
}

// ---------- Router (hash) ----------
let cleanupRoute = null; // rotas podem devolver uma função de limpeza (ex.: parar o canvas)
function render() {
  cleanupRoute?.();
  cleanupRoute = null;
  const [, name = "", arg] = location.hash.replace(/^#/, "").split("/");
  const route = routes[name || "home"] ? name || "home" : "home";
  cleanupRoute = routes[route](arg) || null;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  $("#profile-chip").classList.toggle("active", route === "profile");
  document.querySelectorAll(".sidebar-playlists a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === location.hash));
  view.scrollTop = 0;
}
addEventListener("hashchange", render);

function renderSidebar() {
  $("#sidebar-playlists").innerHTML =
    `<li><a href="#/liked">♥ Músicas curtidas</a></li>` +
    library.playlists.map((p) => `<li><a href="#/playlist/${p.id}">${esc(p.name)}</a></li>`).join("");
}
$("#new-playlist").addEventListener("click", () => { const p = newPlaylist(); if (p) location.hash = `#/playlist/${p.id}`; });

// Re-renderiza a view atual quando os dados mudam (exceto a busca, para não perder resultados)
library.on("change", () => { renderSidebar(); if (!/^#\/(search|visualizer)/.test(location.hash)) render(); updateNowPlaying(); });
// Início: só redesenha se ainda não tinha nada tocado (senão o card clicado "pularia" para o
// primeiro lugar debaixo do mouse); a ordem nova aparece na próxima vez que abrir o Início
history.on("change", () => {
  if (["", "#/", "#"].includes(location.hash) && !document.querySelector("#recent .tcard")) render();
});

// ---------- Barra "tocando agora" ----------
const btnPlay = $("#btn-play"), seek = $("#seek");
let seeking = false;

function updateNowPlaying() {
  const t = player.current;
  $("#np-title").textContent = t?.title ?? "Nada tocando";
  $("#np-artist").textContent = t?.artist ?? "";
  $("#np-thumb").src = t?.thumb ?? "";
  $("#now-playing").classList.toggle("is-empty", !t);
  $("#np-like").classList.toggle("on", !!t && library.isLiked(t.id));
  btnPlay.classList.toggle("is-playing", player.playing);
  $("#btn-shuffle").classList.toggle("on", player.shuffle);
  const rep = $("#btn-repeat");
  rep.classList.toggle("on", player.repeat !== "off");
  rep.classList.toggle("repeat-one", player.repeat === "one");
  document.title = t ? `${t.title} • Orfeo` : "Orfeo";
  document.querySelectorAll(".track").forEach((li) => li.classList.remove("is-current"));
  document.querySelectorAll(".tcard").forEach((c) => c.classList.toggle("is-current", !!t && c.dataset.id === t.id));
}

// ---------- Cor da capa ----------
// Reduz a capa a 32x32, ignora pixels quase pretos/brancos/cinza e pega o tom (matiz) mais presente.
const coverColors = new Map(); // cache por URL
async function coverColor(url) {
  if (coverColors.has(url)) return coverColors.get(url);
  const img = new Image();
  img.src = `/api/thumb?url=${encodeURIComponent(url)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;

  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let all = { w: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const [h, s, l] = rgbToHsl(r, g, b);
    all.w++; all.r += r; all.g += g; all.b += b;
    if (l < 0.12 || l > 0.9 || s < 0.2) continue; // fundo preto/branco/cinza não conta
    const bk = buckets[Math.floor(h * 12) % 12], w = s * (1 - Math.abs(l - 0.5));
    bk.w += w; bk.r += r * w; bk.g += g * w; bk.b += b * w;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  const src = best.w > 1.5 ? best : all; // capa sem cor marcante → média geral
  let [h, s, l] = rgbToHsl(src.r / src.w, src.g / src.w, src.b / src.w);
  // Mantém o fundo escuro e elegante: nem neon, nem claro demais
  s = Math.min(s, 0.65);
  l = Math.min(Math.max(l, 0.22), 0.36);
  const color = `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  coverColors.set(url, color);
  return color;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

async function applyCoverColor(track) {
  const panel = $("#queue-panel");
  if (!track) return panel.style.removeProperty("--cover");
  try {
    const color = await coverColor(track.thumb);
    if (player.current?.id === track.id) { // ignora resposta atrasada
      panel.style.setProperty("--cover", color);
      viz.setBaseColor(color);
    }
  } catch {
    panel.style.removeProperty("--cover");
  }
}

// ---------- Painel direito: abas "A seguir" / "Letra" ----------
let panelTab = Storage.get("panelTab", "queue");

function setPanelTab(tab) {
  panelTab = tab;
  Storage.set("panelTab", tab);
  $("#queue-panel").dataset.tab = tab;
  document.querySelectorAll(".qp-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#btn-lyrics").classList.toggle("on", tab === "lyrics");
  if (tab === "lyrics") loadLyrics();
  syncLyrics(true);
}
document.querySelectorAll(".qp-tabs button").forEach((b) => b.addEventListener("click", () => setPanelTab(b.dataset.tab)));

// ---------- Letra ----------
const lyricsBox = $("#lyrics");
let lyr = { id: null, lines: null, active: -1 }; // letra carregada no painel
let userScrollUntil = 0;                          // pausa o auto-scroll quando a pessoa rola a letra

async function loadLyrics() {
  const t = player.current;
  if (lyr.id === (t?.id ?? null) && lyr.loaded) return; // já está na tela
  lyr = { id: t?.id ?? null, lines: null, active: -1, loaded: false };
  if (!t) return lyricsMsg("Toque uma música para ver a letra.");
  lyricsMsg("Buscando letra…");
  let data;
  try {
    data = await Lyrics.get(t, player.progress().duration);
  } catch {
    if (player.current?.id !== t.id) return;
    lyricsBox.innerHTML = `<div class="lyrics-msg">Não deu para carregar a letra agora.<br><button class="pill ghost" id="lyrics-retry">Tentar de novo</button></div>`;
    $("#lyrics-retry").addEventListener("click", () => { lyr.id = null; loadLyrics(); });
    return;
  }
  if (player.current?.id !== t.id) return; // a música mudou enquanto buscava
  lyr.loaded = true;

  if (data?.instrumental) return lyricsMsg("♪ Música instrumental");
  if (data?.lines?.length) {
    lyr.lines = data.lines;
    lyricsBox.innerHTML = data.lines.map((l, i) => `<p class="ly-line" data-i="${i}">${esc(l.text)}</p>`).join("") +
      `<p class="ly-source">Letra: LRCLIB</p>`;
    lyricsBox.querySelectorAll(".ly-line").forEach((p) =>
      p.addEventListener("click", () => { player.seek(lyr.lines[+p.dataset.i].t); userScrollUntil = 0; }));
    lyricsBox.scrollTop = 0;
    syncLyrics(true);
    return;
  }
  if (data?.plain) {
    lyricsBox.innerHTML = `<p class="ly-note">Letra sem sincronização</p><p class="ly-plain">${esc(data.plain)}</p><p class="ly-source">Letra: LRCLIB</p>`;
    lyricsBox.scrollTop = 0;
    return;
  }
  lyricsMsg("Letra não encontrada para esta música.");
}

function lyricsMsg(text) {
  lyricsBox.innerHTML = `<div class="lyrics-msg">${esc(text)}</div>`;
}

// Destaca a linha atual e centraliza (roda em todo frame enquanto a aba de letra está aberta)
function syncLyrics(force = false) {
  if (panelTab !== "lyrics" || !lyr.lines) return;
  const now = player.progress().current + 0.15; // leve antecipação: a linha acende junto com a voz
  let i = lyr.active;
  if (i < 0 || lyr.lines[i].t > now || (lyr.lines[i + 1] && lyr.lines[i + 1].t <= now)) {
    i = -1;
    for (let k = 0; k < lyr.lines.length && lyr.lines[k].t <= now; k++) i = k;
  }
  if (i === lyr.active && !force) return;
  lyr.active = i;
  lyricsBox.querySelectorAll(".ly-line").forEach((p, k) => {
    p.classList.toggle("active", k === i);
    p.classList.toggle("past", k < i);
  });
  const el = lyricsBox.querySelector(`.ly-line[data-i="${Math.max(i, 0)}"]`);
  if (el && Date.now() > userScrollUntil) {
    lyricsBox.scrollTo({ top: el.offsetTop - lyricsBox.clientHeight * 0.38, behavior: force ? "auto" : "smooth" });
  }
}
["wheel", "touchmove"].forEach((evt) => lyricsBox.addEventListener(evt, () => (userScrollUntil = Date.now() + 3500), { passive: true }));
(function lyricsLoop() { syncLyrics(); requestAnimationFrame(lyricsLoop); })();

// Painel direito: faixa atual + só as próximas da fila
function renderQueue() {
  const t = player.current;
  $("#queue-panel").classList.toggle("is-empty", !t);
  $("#qp-title").textContent = t?.title ?? "";
  $("#qp-artist").textContent = t?.artist ?? "";

  const upcoming = player.queue.map((track, i) => ({ track, i })).slice(player.index + 1);
  $("#qp-count").textContent = upcoming.length ? upcoming.length : "";
  const list = $("#queue-list");
  const firstAuto = upcoming.findIndex(({ track }) => track.auto);
  list.innerHTML = upcoming.map(({ track, i }, k) => {
    const by = jam.active && track.addedBy ? jam.member(track.addedBy) : null; // quem adicionou (na Jam)
    return `${k === firstAuto ? `<li class="q-divider">Tocando automaticamente</li>` : ""}
    <li data-i="${i}" class="${track.auto ? "is-auto" : ""}">
      <span class="q-thumb">
        <img referrerpolicy="no-referrer" src="${esc(track.thumb)}" data-vid="${esc(track.id)}" alt="" loading="lazy" />
        ${by ? `<span class="q-by" title="Adicionada por ${esc(by.name)}">${memberAvatar(by, "avatar-xxs")}</span>` : ""}
      </span>
      <div><div class="t-title">${esc(track.title)}</div><div class="t-artist">${esc(track.artist)}</div></div>
      <button class="q-remove" title="Remover da fila" aria-label="Remover da fila">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </li>`;
  }).join("") || `<p class="empty">${t ? (player.autoplay ? "Buscando músicas parecidas…" : "Nada na fila. Use ⊕ para adicionar.") : "A fila está vazia."}</p>`;
  renderAutoplayToggle();
  list.querySelectorAll("li[data-i]").forEach((li) => {
    li.addEventListener("click", () => player.jumpTo(+li.dataset.i));
    li.querySelector(".q-remove").addEventListener("click", (e) => { e.stopPropagation(); player.removeFromQueue(+li.dataset.i); });
  });
}

// Autoplay: liga/desliga na fila. Na Jam, quem manda é o anfitrião.
function renderAutoplayToggle() {
  const guest = jam.role === "guest";
  const toggle = $("#autoplay-toggle");
  toggle.checked = player.autoplay;
  toggle.disabled = guest;
  $("#autoplay-row").classList.toggle("is-disabled", guest);
  $("#autoplay-sub").textContent = guest
    ? "Na Jam, o autoplay é do anfitrião"
    : "Continua com músicas parecidas quando a fila acabar";
}
$("#autoplay-toggle").addEventListener("change", (e) => {
  player.setAutoplay(e.target.checked);
  toast(e.target.checked ? "Autoplay ligado" : "Autoplay desligado");
});

player.on("state", updateNowPlaying);
player.on("queue", renderQueue);
player.on("error", toast);
let lastTrack = null; // última faixa que o app viu tocar (na transição, é a que está saindo)
player.on("track", (t) => {
  lastTrack = t;
  setSeek(0);
  applyCoverColor(t);
  viz.setTrack(t);
  viz.resetTempo(); // BPM é da música nova
  if (panelTab === "lyrics") loadLyrics();
  updateVizInfo();
  updateNowPlaying();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: [{ src: t.thumb, sizes: "320x180" }] });
  }
});
player.on("progress", ({ current, duration }) => {
  $("#time-cur").textContent = fmt(current);
  $("#time-dur").textContent = fmt(duration);
  if (!seeking && duration) setSeek((current / duration) * 1000);
});
// --p pinta a parte já tocada da linha de progresso
function setSeek(v) { seek.value = v; seek.style.setProperty("--p", `${v / 10}%`); }

btnPlay.addEventListener("click", () => player.toggle());
$("#video-shield").addEventListener("click", () => player.toggle());
$("#btn-next").addEventListener("click", () => player.next());
$("#btn-prev").addEventListener("click", () => player.prev());
$("#btn-shuffle").addEventListener("click", () => player.toggleShuffle());
$("#btn-repeat").addEventListener("click", () => player.cycleRepeat());
$("#np-like").addEventListener("click", () => player.current && library.toggleLike(player.current));
$("#btn-lyrics").addEventListener("click", () => {
  const app = document.querySelector(".app");
  if (panelTab === "lyrics" && !app.classList.contains("queue-hidden")) return setPanelTab("queue");
  app.classList.remove("queue-hidden");
  setPanelTab("lyrics");
});
$("#btn-jam").addEventListener("click", () => (location.hash = "#/friends"));
$("#btn-viz").addEventListener("click", () => {
  location.hash = location.hash === "#/visualizer" ? "#/" : "#/visualizer";
});
$("#btn-queue").addEventListener("click", () => document.querySelector(".app").classList.toggle("queue-hidden"));
seek.addEventListener("input", () => { seeking = true; setSeek(seek.value); });
seek.addEventListener("change", () => { player.seek((seek.value / 1000) * player.progress().duration); seeking = false; });
const vol = $("#volume");
vol.value = player.volume;
let volBeforeMute = player.volume || 80;
function applyVolume(v) {
  player.setVolume(v);
  vol.value = v;
  $("#btn-mute").classList.toggle("muted", v === 0);
}
vol.addEventListener("input", () => applyVolume(+vol.value));
$("#btn-mute").addEventListener("click", () => {
  if (player.volume > 0) { volBeforeMute = player.volume; applyVolume(0); }
  else applyVolume(volBeforeMute || 80);
});
$("#btn-mute").classList.toggle("muted", player.volume === 0);

// Teclas de mídia do teclado/sistema
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => player.toggle());
  navigator.mediaSession.setActionHandler("pause", () => player.toggle());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
}
// Espaço = play/pause (fora de campos de texto)
addEventListener("keydown", (e) => {
  if (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); player.toggle(); }
});

// ---------- Integração desktop (Electron) ----------
if (window.orfeoDesktop) {
  document.body.classList.add("desktop");
  window.orfeoDesktop.onCommand((cmd) => ({ toggle: () => player.toggle(), next: () => player.next(), prev: () => player.prev() })[cmd]?.());
}

// Capa que não carrega → usa a miniatura padrão do vídeo
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.dataset.vid && !img.dataset.fallback) {
    img.dataset.fallback = "1";
    img.src = `https://i.ytimg.com/vi/${img.dataset.vid}/mqdefault.jpg`;
  }
}, true);

// ---------- Boot ----------
applyAccent(profile.accent);
renderProfileChip();
renderJamIndicator();
renderFriendsNav();
friends.start(); // fica online para os amigos (servidor de encontros do PeerJS)
viz.style = Storage.get("vizStyle", "ring") === "waves" ? "waves" : "ring";
player.insight = () => viz.insight; // o Automix "escuta" a música pelo analisador do visualizador
// App desktop: cada deck manda o próprio espectro e aceita o "botão de voz"
deckFx.onFft = (deck, bins) => viz.feedDeck(deck, bins, deckFx.sampleRate, deckFx.fftSize);
player.voiceFx = (deck, voice, seconds) => deckFx.setVoice(deck, voice, seconds);
// Ondas da transição no painel direito
const mixWaves = new MixWaves($("#mix-waves"), () => {
  const m = player.mixState;
  return m && { gOut: m.gOut, gIn: m.gIn, levelOut: viz.deckLevel(m.from), levelIn: viz.deckLevel(m.to) };
});
let mixHideTimer = 0;
player.on("mix", async (on) => {
  const strip = $("#mix-strip");
  clearTimeout(mixHideTimer);
  if (!on) {
    strip.classList.remove("is-on");
    mixHideTimer = setTimeout(() => mixWaves.stop(), 500); // espera a faixa recolher
    return;
  }
  // A transição começa antes do aviso de "faixa nova": quem entra já é a atual do player,
  // quem sai ainda é a última que o app viu tocar
  const out = lastTrack, inc = player.current;
  strip.classList.add("is-on"); // abre na hora; as cores das capas chegam logo depois
  mixWaves.setColors(null, null);
  mixWaves.start();
  const color = async (t) => (t ? coverColor(t.thumb).catch(() => null) : null);
  const [cOut, cIn] = await Promise.all([color(out), color(inc)]);
  if (!player.mixing) return; // a mistura acabou enquanto pegava as cores
  mixWaves.setColors(cOut, cIn);
  $("#mix-dot-out").style.background = mixWavesColor(cOut);
  $("#mix-dot-in").style.background = mixWavesColor(cIn);
});
function mixWavesColor(c) {
  const h = parseFloat(String(c).replace(/^hsl\(/, ""));
  return Number.isNaN(h) ? "#ccc" : `hsl(${Math.round(h)} 85% 64%)`;
}
player.init();
// Plano B: se o processador dos decks não aparecer (ex.: navegador), usa a captura do som
setTimeout(ensureAutomixEars, 8000);
setPanelTab(panelTab);
renderSidebar();
renderQueue();
updateNowPlaying();
render();
