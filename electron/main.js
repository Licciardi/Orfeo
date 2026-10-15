// Processo principal do Electron: a "casca nativa" do Orfeo.
// Mesma ideia do Spotify desktop (Chromium embutido + interface web), só que com Electron.
const { app, BrowserWindow, shell, Menu, Tray, nativeImage, session, desktopCapturer, webFrameMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { startServer } = require("../server");
const { orfeoDeckFx } = require("./deck-fx");

// Porta fixa: o localStorage (playlists, curtidas, chave da API) é por origem,
// então mudar de porta "apagaria" a biblioteca. Só cai pra uma porta aleatória se estiver ocupada.
const PREFERRED_PORT = 47823;

let win = null;
let tray = null;
let quitting = false;
let appOrigin = ""; // ex.: http://localhost:47823 — definida quando o servidor sobe

// Player de música: permite tocar a próxima faixa sem exigir clique do usuário (autoplay).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// O app se chamava "Sonora" (pasta de dados %APPDATA%\Sonora). Na primeira vez como Orfeo,
// copia de lá o armazenamento do app (playlists, perfil, amigos…) e o tamanho da janela.
(function migrateFromSonora() {
  try {
    const oldDir = path.join(app.getPath("appData"), "Sonora");
    const newDir = app.getPath("userData");
    if (!fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, "Local Storage"))) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const item of ["Local Storage", "window-state.json"]) {
      const src = path.join(oldDir, item);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, item), { recursive: true });
    }
  } catch { /* sem migração: o app abre zerado, mas funciona */ }
})();

// Uma instância só: abrir de novo traz a janela existente para frente.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

// ---------- Tamanho/posição da janela lembrados entre execuções ----------
const stateFile = path.join(app.getPath("userData"), "window-state.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { width: 1280, height: 800 }; }
}
function saveState() {
  if (!win || win.isMinimized()) return;
  try { fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function createWindow() {
  let port;
  try { ({ port } = await startServer(PREFERRED_PORT)); }
  catch { ({ port } = await startServer(0)); }
  const appUrl = `http://localhost:${port}`;
  appOrigin = appUrl;

  const state = loadState();
  win = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 500,
    title: "Orfeo",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#0b0b0f",
    show: false,
    // Barra de título escura integrada (botões nativos do Windows por cima do app)
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b0b0f", symbolColor: "#f2f2f5", height: 36 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // continua tocando com a janela minimizada
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("resize", saveState);
  win.on("move", saveState);

  // Fechar no X manda pra bandeja (a música continua); "Sair" na bandeja encerra de verdade.
  win.on("close", (e) => {
    saveState();
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  // Links externos abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(appUrl)) { e.preventDefault(); shell.openExternal(url); }
  });

  // Processador de áudio de cada deck: injetado só nos players do YouTube que são filhos
  // diretos da página do Orfeo (voz na transição + análise sem pegar o som do Discord).
  win.webContents.on("did-frame-finish-load", (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame || !frame.parent || frame.parent.parent) return; // só filhos diretos da página
    const origin = (u) => { try { return new URL(u).origin; } catch { return ""; } };
    if (origin(frame.parent.url) !== appOrigin || origin(frame.url) !== "https://www.youtube.com") return;
    frame.executeJavaScript(`(${orfeoDeckFx.toString()})(${JSON.stringify(appOrigin)})`, true).catch(() => {});
  });

  Menu.setApplicationMenu(null);
  await win.loadURL(appUrl);
}

// ---------- Bandeja do sistema ----------
function sendCommand(cmd) { win?.webContents.send("player-command", cmd); }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
  tray.setToolTip("Orfeo");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Mostrar Orfeo", click: showWindow },
    { type: "separator" },
    { label: "Tocar / Pausar", click: () => sendCommand("toggle") },
    { label: "Próxima", click: () => sendCommand("next") },
    { label: "Anterior", click: () => sendCommand("prev") },
    { type: "separator" },
    { label: "Sair", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId("com.orfeo.player");
  // Visualizador: a página pede getDisplayMedia e recebe o som do sistema (loopback), sem prompt.
  // O vídeo da tela é descartado pela página; só o áudio é analisado.
  // Só a página principal do Orfeo pode pedir — iframes (ex.: o player do YouTube) e
  // qualquer outra origem são recusados.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const origin = (() => { try { return new URL(request.securityOrigin).origin; } catch { return ""; } })();
    const fromApp = !!win && request.frame === win.webContents.mainFrame && origin === appOrigin;
    if (!fromApp) return callback({});
    desktopCapturer.getSources({ types: ["screen"] })
      .then((sources) => callback({ video: sources[0], audio: "loopback" }))
      .catch(() => callback({}));
  });
  await createWindow();
  createTray();
  // Teclas de mídia: o Chromium já integra a Media Session (app.js) com os controles de mídia do Windows.
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
