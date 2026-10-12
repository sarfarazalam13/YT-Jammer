import { useCallback, useRef, useState } from "react";
import YouTube, { type YouTubeEvent, type YouTubePlayer } from "react-youtube";

const VIDEO_ID = "dQw4w9WgXcQ";

type PlayerStatus = "loading" | "ready" | "playing" | "paused";

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.4v13.2L18.5 12 8 5.4Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 5v4.15L7.2 5 6 6.6 11.1 10H6v2h8.5A4.5 4.5 0 1 1 10 16.5H8A6.5 6.5 0 1 0 14.5 10H15V5h-2Z" />
      <text x="7.1" y="18.2" className="forward-number">30</text>
    </svg>
  );
}

function App() {
  const playerRef = useRef<YouTubePlayer | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("loading");
  const isReady = status !== "loading";

  const onReady = useCallback((event: YouTubeEvent) => {
    playerRef.current = event.target;
    setStatus("ready");
  }, []);

  const play = useCallback(() => {
    playerRef.current?.playVideo();
    setStatus("playing");
  }, []);

  const pause = useCallback(() => {
    playerRef.current?.pauseVideo();
    setStatus("paused");
  }, []);

  const seekTo30 = useCallback(() => {
    playerRef.current?.seekTo(30, true);
  }, []);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="topbar" aria-label="Primary navigation">
        <a className="brand" href="#player" aria-label="YT Jam home">
          <span className="brand-mark"><PlayIcon /></span>
          <span>YT JAM</span>
        </a>
        <div className="room-pill">
          <span className="live-dot" />
          Local session
        </div>
      </nav>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">PROOF OF CONCEPT · PLAYER CONTROL</p>
        <h1 id="page-title">One player.<br /><span>Perfect timing.</span></h1>
        <p className="lede">
          The first building block for listening together: a YouTube player
          that responds instantly to app controls.
        </p>
      </section>

      <section className="player-card" id="player" aria-label="YouTube player controls">
        <div className="player-frame">
          <YouTube
            videoId={VIDEO_ID}
            onReady={onReady}
            onPlay={() => setStatus("playing")}
            onPause={() => setStatus("paused")}
            className="youtube-shell"
            iframeClassName="youtube-iframe"
            opts={{
              width: "100%",
              height: "100%",
              playerVars: {
                autoplay: 0,
                controls: 1,
                rel: 0,
              },
            }}
          />
        </div>

        <div className="control-deck">
          <div className="now-playing">
            <div className={`equalizer ${status === "playing" ? "is-playing" : ""}`} aria-hidden="true">
              <i /><i /><i /><i />
            </div>
            <div>
              <span className="meta-label">NOW PLAYING</span>
              <strong>Player test track</strong>
            </div>
          </div>

          <div className="controls">
            <button type="button" onClick={play} disabled={!isReady} aria-label="Play video">
              <PlayIcon />
              <span>Play</span>
            </button>
            <button type="button" onClick={pause} disabled={!isReady} aria-label="Pause video">
              <PauseIcon />
              <span>Pause</span>
            </button>
            <button type="button" onClick={seekTo30} disabled={!isReady} aria-label="Seek to 30 seconds">
              <ForwardIcon />
              <span>30 sec</span>
            </button>
          </div>

          <div className="status" role="status" aria-live="polite">
            <span className={`status-light status-${status}`} />
            {status === "loading" ? "Connecting" : status === "ready" ? "Ready" : status}
          </div>
        </div>
      </section>

      <footer>
        <span>STEP 01</span>
        <div className="footer-line" />
        <p>Next: shared room state with Firebase</p>
      </footer>
    </main>
  );
}

export default App;
