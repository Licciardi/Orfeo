// Processador de áudio injetado em cada player do YouTube (só no app desktop).
//
// O processo principal roda este script DENTRO do iframe do YouTube (youtube.com/embed). Ele liga
// o <video> do player a um grafo Web Audio próprio e faz duas coisas:
//   1. "Botão de voz": tira a voz central (truque mid/side de karaokê) — usado nas transições.
//   2. Análise: manda o espectro DESTE player para o app (visualizador e Automix escutam só o
//      Orfeo, não o som do computador — então chamadas do Discord não atrapalham).
//
// A conversa com o app usa um MessageChannel privado: a porta é entregue uma única vez ao
// app (origem verificada) e todo o resto passa por ela, longe dos listeners do YouTube.
// Se o áudio não puder ser processado, nada é alterado (o som do player segue normal).

function orfeoDeckFx(appOrigin) {
  if (window.__orfeoDeckFx) return;

  const FFT = 4096, SEND_BINS = 1280; // até ~15 kHz a 48 kHz (o visualizador usa até 14 kHz)
  let ctx = null, video = null, dry = null, wet = null, comp = null, analyser = null, port = null;
  // Só leitura, para diagnóstico: nível atual da voz (1 = normal, 0 = instrumental)
  window.__orfeoDeckFx = Object.freeze({ get voice() { return dry ? +dry.gain.value.toFixed(2) : null; }, get active() { return !!ctx; } });

  async function build(v) {
    const c = new AudioContext({ latencyHint: "playback" });
    try { await c.resume(); } catch {}
    if (c.state !== "running") { c.close(); return false; } // sem áudio rodando: não mexe no player
    const g = (val) => { const n = c.createGain(); n.gain.value = val; return n; };
    const src = c.createMediaElementSource(v);

    // Mid/side: a voz principal fica no centro (mid). No modo instrumental, o mid só passa
    // abaixo de 160 Hz (bumbo/baixo) e acima de 6,5 kHz (pratos); o meio, onde está a voz, sai.
    const split = c.createChannelSplitter(2), merge = c.createChannelMerger(2);
    const mid = g(1), side = g(1);
    const toMidL = g(0.5), toMidR = g(0.5), toSideL = g(0.5), toSideR = g(-0.5);
    src.connect(split);
    split.connect(toMidL, 0); split.connect(toMidR, 1); split.connect(toSideL, 0); split.connect(toSideR, 1);
    toMidL.connect(mid); toMidR.connect(mid); toSideL.connect(side); toSideR.connect(side);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 160;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 6500;
    dry = g(1); wet = g(0);
    const midOut = g(1);
    mid.connect(dry); mid.connect(lp); mid.connect(hp); lp.connect(wet); hp.connect(wet);
    dry.connect(midOut); wet.connect(midOut);
    const sideInv = g(-1); side.connect(sideInv);
    const outL = g(1), outR = g(1);
    midOut.connect(outL); side.connect(outL); midOut.connect(outR); sideInv.connect(outR);
    outL.connect(merge, 0, 0); outR.connect(merge, 0, 1);
    merge.connect(c.destination);

    // Análise do sinal original, compensando o volume do player (resultado não depende do
    // volume nem do crossfade)
    comp = g(1);
    analyser = c.createAnalyser();
    analyser.fftSize = FFT; analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -85; analyser.maxDecibels = -22;
    src.connect(comp); comp.connect(analyser);

    // O som agora passa pelo processador: se o sistema o pausar (troca de fone, por exemplo),
    // retoma na hora para a música nunca ficar muda
    c.onstatechange = () => { if (c.state === "suspended") c.resume().catch(() => {}); };
    v.addEventListener("play", () => { if (c.state !== "running") c.resume().catch(() => {}); });

    ctx = c; video = v;
    return true;
  }

  // Ajusta o "botão de voz": 1 = normal, 0 = instrumental, em `seconds` segundos
  function setVoice(voice, seconds) {
    if (!ctx) return;
    const t = ctx.currentTime, v = Math.min(1, Math.max(0, Number(voice) || 0)), s = Math.min(20, Math.max(0, Number(seconds) || 0));
    for (const [param, target] of [[dry.gain, v], [wet.gain, 1 - v]]) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      if (s > 0) param.linearRampToValueAtTime(target, t + s); else param.setValueAtTime(target, t);
    }
  }

  function connectToApp() {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === "voice") setVoice(d.voice, d.seconds);
    };
    window.parent.postMessage({ __orfeo: "deckfx", sampleRate: ctx.sampleRate, fftSize: FFT }, appOrigin, [channel.port2]);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    setInterval(() => {
      if (!video || video.paused) return;
      comp.gain.value = video.volume > 0.02 ? Math.min(1 / video.volume, 10) : 0;
      analyser.getByteFrequencyData(bins);
      port.postMessage({ type: "fft", bins: bins.slice(0, SEND_BINS) });
    }, 20);
  }

  // O <video> do YouTube aparece logo depois do carregamento do player
  const timer = setInterval(async () => {
    const v = document.querySelector("video");
    if (!v || ctx) return;
    clearInterval(timer);
    try { if (await build(v)) connectToApp(); } catch { /* deixa o player como está */ }
  }, 300);
}

module.exports = { orfeoDeckFx };
