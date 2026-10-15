// Ponte segura entre o processo principal e a página (contextIsolation ligado).
// A página só enxerga o que está aqui — nada de Node.js direto.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orfeoDesktop", {
  platform: process.platform,
  // Comandos vindos da bandeja e das teclas de mídia globais
  onCommand(callback) {
    ipcRenderer.on("player-command", (_e, cmd) => callback(cmd));
  },
});
