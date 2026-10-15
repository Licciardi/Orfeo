<p align="center">
  <img src="electron/icon.png" width="128" alt="Ícone do Orfeo: uma lira dourada" />
</p>

<h1 align="center">Orfeo</h1>

<p align="center">
  Player de música para desktop que toca o catálogo do <b>YouTube / YouTube Music</b>, com Jam para ouvir junto com amigos, transições estilo DJ, letras sincronizadas e visualizador que reage à batida.
</p>

<p align="center">
  <a href="https://github.com/Licciardi/Orfeo/releases/latest/download/Orfeo-Setup.exe"><b>⬇ Baixar para Windows</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Licciardi/Orfeo/releases">Todas as versões</a>
</p>

> Orfeu, o músico da mitologia grega cuja música encantava deuses e feras — em italiano, *Orfeo*.

## Baixar e instalar

1. Baixe o **[Orfeo-Setup.exe](https://github.com/Licciardi/Orfeo/releases/latest/download/Orfeo-Setup.exe)** (Windows 10/11, 64 bits).
2. Abra o instalador. O Windows pode mostrar **"O Windows protegeu o computador"**, porque o app não tem assinatura digital paga: clique em **Mais informações → Executar assim mesmo**.
3. Escolha a pasta e pronto — o Orfeo aparece no menu Iniciar.

Para ouvir junto com alguém, os dois precisam da mesma versão: em **Amigos → + Adicionar**, troquem os códigos de amigo.

## Recursos

- **Busca sem chave de API** — músicas (YouTube Music) e vídeos (YouTube); também aceita links colados.
- **Biblioteca** — playlists, músicas curtidas, histórico e artistas mais ouvidos.
- **Autoplay** — quando a fila acaba, continua com músicas parecidas (rádio do YouTube Music).
- **Transições** — *Crossfade* com tempo fixo ou **Automix**: mede o BPM, começa a mistura em cima da batida, dura 4 compassos e detecta o fim real da música (outro/fade-out). No app desktop, a **transição instrumental** tira a voz das duas músicas durante a mistura.
- **Letras sincronizadas** — via [LRCLIB](https://lrclib.net), com clique na linha para pular até ela.
- **Visualizador** — estilos *Círculo* e *Ondas*, reagindo às frequências e à batida reais.
- **Jam** — ouçam juntos: mesma música, no mesmo segundo; todos controlam a fila.
- **Amigos** — código de amigo, quem está online e o que está ouvindo, convite para Jam com 1 clique.
- **Perfil** — nome, foto (aceita GIF animado) e cor de destaque do app.

## Como rodar

Requer [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
npm install
npm start          # app desktop (Electron)
npm run web        # só a versão web, em http://localhost:5173
npm run dist       # gera o instalador do Windows em dist/
```

## Como funciona

| Parte | Onde |
|---|---|
| Interface (telas, fila, letras, Jam, amigos) | `public/` |
| Player com dois "decks" (crossfade/automix), fila, autoplay | `public/platform.js` |
| App desktop: janela, bandeja, processador de áudio dos decks | `electron/` |
| Servidor local: busca, rádio, letras e capas | `server.js` |

- A reprodução usa o **player oficial do YouTube** (IFrame API); nenhum áudio é baixado.
- Jam e Amigos usam conexão direta entre os computadores (WebRTC via [PeerJS](https://peerjs.com)). Só o estado (música, posição, fila) trafega; tudo que chega é validado.
- No app desktop, cada player recebe um processador de áudio local (análise de frequências e remoção de voz por mid/side). Nada é gravado nem enviado.

## Avisos

- A busca usa a API interna do YouTube (InnerTube), que não é oficial: pode mudar sem aviso, e o uso automatizado vai contra os termos do YouTube. Projeto pessoal, sem fins comerciais.
- A remoção de voz é a técnica clássica de "karaokê" (centro do estéreo), não separação por IA.

## Licença

[MIT](LICENSE) © 2026 Luigi Licciardi

## Créditos

- [PeerJS](https://github.com/peers/peerjs) (MIT) — conexões diretas da Jam e dos Amigos.
- [LRCLIB](https://lrclib.net) — letras sincronizadas.
- YouTube IFrame Player API — reprodução.
