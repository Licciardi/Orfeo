// Conversa com o processador de áudio de cada deck (injetado pelo app desktop em cada player).
// No navegador comum ele não existe — aí `available` fica false e nada muda.
//
// Cada player manda UMA mensagem com uma porta privada (MessageChannel). Só aceitamos se vier
// da origem do YouTube E de um dos nossos dois iframes; o resto da conversa vai pela porta.
const IDS = ["yt-player", "yt-player-b"];
const YT_ORIGIN = "https://www.youtube.com";

class DeckFx {
  #ports = [null, null];
  sampleRate = 48000;
  fftSize = 4096;
  onFft = null; // (deck, bins: Uint8Array) — o visualizador escuta por aqui

  get available() { return this.#ports.some(Boolean); }
  has(deck) { return !!this.#ports[deck]; }

  // voice: 1 = normal, 0 = instrumental (sem a voz central); seconds: duração da rampa
  setVoice(deck, voice, seconds = 0) {
    this.#ports[deck]?.postMessage({ type: "voice", voice, seconds });
  }

  constructor() {
    addEventListener("message", (e) => {
      if (e.origin !== YT_ORIGIN) return;
      const d = e.data;
      if (!d || typeof d !== "object" || d.__orfeo !== "deckfx" || !e.ports?.[0]) return;
      const deck = IDS.findIndex((id) => document.getElementById(id)?.contentWindow === e.source);
      if (deck < 0) return;
      const port = e.ports[0];
      this.sampleRate = Number(d.sampleRate) || 48000;
      this.fftSize = Number(d.fftSize) || 4096;
      port.onmessage = (m) => {
        if (m.data?.type === "fft" && m.data.bins instanceof Uint8Array) this.onFft?.(deck, m.data.bins);
      };
      this.#ports[deck] = port;
    });
  }
}

export const deckFx = new DeckFx();
