import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import YouTube, { type YouTubeEvent, type YouTubePlayer } from "react-youtube";
import {
  createRoomId,
  isValidRoomId,
  normalizeRoomId,
  roomIdFromSearch,
  roomUrl,
} from "./rooms";
import {
  expectedPosition,
  extractYouTubeVideoId,
  isOwnLatestCommand,
  shouldSeek,
  VIDEO_ID,
} from "./sync";
import { type SyncPhase, usePlaybackSync } from "./usePlaybackSync";

type PlayerStatus = "loading" | "ready" | "playing" | "paused";

const phaseLabels: Record<SyncPhase, string> = {
  idle: "Choose room",
  configuration: "Setup needed",
  authenticating: "Signing in",
  connecting: "Connecting",
  ready: "Synced",
  syncing: "Syncing",
  offline: "Offline",
  error: "Sync error",
};

type RoomLobbyProps = {
  onCreate: () => void;
  onJoin: (roomId: string) => void;
};

function RoomLobby({ onCreate, onJoin }: RoomLobbyProps) {
  const [roomInput, setRoomInput] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);

  const join = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeRoomId(roomInput);
    if (!isValidRoomId(normalized)) {
      setRoomError("Use at least 4 letters, numbers, or dashes.");
      return;
    }
    onJoin(normalized);
  };

  return (
    <section className="room-lobby" aria-labelledby="room-lobby-title">
      <div className="lobby-copy">
        <span>STEP 03 · ROOMS</span>
        <h2 id="room-lobby-title">Start together.</h2>
        <p>Create a fresh listening room, or enter an invite code from a friend.</p>
        <button className="create-room" type="button" onClick={onCreate}>
          <PlayIcon />
          Create a room
        </button>
      </div>

      <form className="join-room" onSubmit={join}>
        <label htmlFor="room-code">Join with a room code</label>
        <div>
          <input
            id="room-code"
            value={roomInput}
            onChange={(event) => {
              setRoomInput(event.target.value);
              setRoomError(null);
            }}
            placeholder="neon-friday-a1b2"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Join room</button>
        </div>
        <p className={roomError ? "room-error" : undefined} role={roomError ? "alert" : undefined}>
          {roomError ?? "Room codes are case-insensitive and become part of the invite link."}
        </p>
      </form>
    </section>
  );
}

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
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedCommandRef = useRef<string | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>("loading");
  const [playerReady, setPlayerReady] = useState(false);
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const [isArmingPlayback, setIsArmingPlayback] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(() => roomIdFromSearch(window.location.search));
  const [copyLabel, setCopyLabel] = useState("Copy invite");
  const [videoInput, setVideoInput] = useState("");
  const [videoInputError, setVideoInputError] = useState<string | null>(null);
  const {
    phase,
    error: syncError,
    remoteState,
    serverTimeOffset,
    lastPublishedCommandId,
    publish,
    queue,
    queueError,
    isQueueUpdating,
    addToQueue,
    removeFromQueue,
  } = usePlaybackSync(roomId);
  const currentVideoId = remoteState?.videoId ?? VIDEO_ID;

  const enterRoom = useCallback((nextRoomId: string) => {
    const url = roomUrl(nextRoomId, window.location);
    window.history.pushState({ roomId: nextRoomId }, "", url);
    setRoomId(nextRoomId);
  }, []);

  const createRoom = useCallback(() => enterRoom(createRoomId()), [enterRoom]);

  const leaveRoom = useCallback(() => {
    playerRef.current?.pauseVideo?.();
    window.history.pushState({}, "", window.location.pathname);
    setRoomId(null);
  }, []);

  const copyInvite = useCallback(async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomUrl(roomId, window.location));
      setCopyLabel("Invite copied");
      window.setTimeout(() => setCopyLabel("Copy invite"), 1_800);
    } catch {
      setCopyLabel("Copy failed");
    }
  }, [roomId]);

  useEffect(() => {
    const readRoomFromHistory = () => setRoomId(roomIdFromSearch(window.location.search));
    window.addEventListener("popstate", readRoomFromHistory);
    return () => window.removeEventListener("popstate", readRoomFromHistory);
  }, []);

  useEffect(() => {
    playerRef.current = null;
    lastAppliedCommandRef.current = null;
    setPlayerReady(false);
    setPlaybackEnabled(false);
    setPlayerStatus("loading");
    setPlayerError(null);
    setCopyLabel("Copy invite");
    setVideoInput("");
    setVideoInputError(null);
  }, [roomId]);

  const applyRemoteState = useCallback(
    (forceReconcile = false) => {
      const player = playerRef.current;
      if (!player || !playerReady || !playbackEnabled || !remoteState) return;

      if (!forceReconcile) {
        if (lastAppliedCommandRef.current === remoteState.commandId) return;
        if (isOwnLatestCommand(remoteState, lastPublishedCommandId)) {
          lastAppliedCommandRef.current = remoteState.commandId;
          return;
        }
      }

      const serverNow = Date.now() + serverTimeOffset;
      const calculatedTarget = expectedPosition(remoteState, serverNow);
      const duration = Number(player.getDuration?.() ?? 0);
      const target = duration > 0 ? Math.min(calculatedTarget, duration) : calculatedTarget;
      const current = Number(player.getCurrentTime?.() ?? 0);
      const loadedVideoId = player.getVideoData?.()?.video_id;

      if (loadedVideoId && loadedVideoId !== remoteState.videoId) {
        const request = { videoId: remoteState.videoId, startSeconds: target };
        if (remoteState.status === "playing") {
          player.loadVideoById(request);
        } else {
          player.cueVideoById(request);
        }
        setPlayerStatus(remoteState.status);
        lastAppliedCommandRef.current = remoteState.commandId;
        return;
      }

      if (shouldSeek(current, target)) player.seekTo(target, true);

      const currentPlayerState = Number(player.getPlayerState?.());
      if (remoteState.status === "playing" && currentPlayerState !== 1) {
        player.playVideo();
      } else if (remoteState.status === "paused" && currentPlayerState === 1) {
        player.pauseVideo();
      }

      lastAppliedCommandRef.current = remoteState.commandId;
    },
    [lastPublishedCommandId, playbackEnabled, playerReady, remoteState, serverTimeOffset],
  );

  useEffect(() => {
    applyRemoteState(false);
  }, [applyRemoteState]);

  useEffect(() => {
    if (!playbackEnabled || remoteState?.status !== "playing") return;
    const intervalId = window.setInterval(() => applyRemoteState(true), 5_000);
    return () => window.clearInterval(intervalId);
  }, [applyRemoteState, playbackEnabled, remoteState?.status]);

  useEffect(() => {
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") applyRemoteState(true);
    };
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => document.removeEventListener("visibilitychange", reconcileWhenVisible);
  }, [applyRemoteState]);

  useEffect(() => {
    return () => {
      if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
    };
  }, []);

  const onReady = useCallback((event: YouTubeEvent) => {
    playerRef.current = event.target;
    setPlayerReady(true);
    setPlayerStatus("ready");
  }, []);

  const enablePlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player || phase !== "ready") return;

    setIsArmingPlayback(true);
    player.mute();
    player.playVideo();

    activationTimerRef.current = setTimeout(() => {
      player.pauseVideo();
      player.unMute();
      setPlaybackEnabled(true);
      setIsArmingPlayback(false);
    }, 180);
  }, [phase]);

  const controlsReady = playerReady && playbackEnabled && phase === "ready";

  const play = useCallback(() => {
    const player = playerRef.current;
    if (!player || !controlsReady) return;
    const position = Number(player.getCurrentTime?.() ?? 0);
    player.playVideo();
    setPlayerStatus("playing");
    void publish("playing", position);
  }, [controlsReady, publish]);

  const pause = useCallback(() => {
    const player = playerRef.current;
    if (!player || !controlsReady) return;
    player.pauseVideo();
    const position = Number(player.getCurrentTime?.() ?? 0);
    setPlayerStatus("paused");
    void publish("paused", position);
  }, [controlsReady, publish]);

  const seekTo30 = useCallback(() => {
    const player = playerRef.current;
    if (!player || !controlsReady) return;
    const status = Number(player.getPlayerState?.()) === 1 ? "playing" : "paused";
    player.seekTo(30, true);
    setPlayerStatus(status);
    void publish(status, 30);
  }, [controlsReady, publish]);

  const selectVideo = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const videoId = extractYouTubeVideoId(videoInput);
      if (!videoId) {
        setVideoInputError("Paste a valid YouTube link or 11-character video ID.");
        return;
      }

      setVideoInputError(null);
      void publish("paused", 0, videoId).then((result) => {
        if (!result.ok) {
          setVideoInputError("The room could not change videos. Check the connection and try again.");
          return;
        }
        playerRef.current?.cueVideoById?.({ videoId, startSeconds: 0 });
        setPlayerStatus("paused");
        setVideoInput("");
      });
    },
    [publish, videoInput],
  );

  const queueVideo = useCallback(() => {
    const videoId = extractYouTubeVideoId(videoInput);
    if (!videoId) {
      setVideoInputError("Paste a valid YouTube link or 11-character video ID.");
      return;
    }

    setVideoInputError(null);
    void addToQueue(videoId).then((ok) => {
      if (ok) setVideoInput("");
      else setVideoInputError("The video could not be added to the shared queue.");
    });
  }, [addToQueue, videoInput]);

  const playQueuedVideo = useCallback(
    (itemId: string, videoId: string) => {
      void publish("paused", 0, videoId).then(async (result) => {
        if (!result.ok) return;
        playerRef.current?.cueVideoById?.({ videoId, startSeconds: 0 });
        setPlayerStatus("paused");
        await removeFromQueue(itemId);
      });
    },
    [publish, removeFromQueue],
  );

  const visibleError = syncError ?? playerError;
  const statusLabel = phase === "ready" ? playerStatus : phaseLabels[phase];
  const videoSelectionReady = playerReady && phase === "ready";
  const queueControlsReady = phase === "ready" && !isQueueUpdating && !queueError;

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
          <span className={`live-dot phase-${phase}`} />
          {roomId ? `${roomId} · ${phaseLabels[phase]}` : "Choose or create a room"}
        </div>
      </nav>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">PROOF OF CONCEPT · SHAREABLE ROOMS</p>
        <h1 id="page-title">One room.<br /><span>One moment.</span></h1>
        <p className="lede">
          {roomId
            ? "Share this room, enable playback on each device, and every command stays in sync."
            : "Create a listening room in one click, then send the invite link to anyone joining the moment."}
        </p>
      </section>

      {roomId && visibleError && (
        <aside className={`notice ${phase === "configuration" ? "notice-setup" : "notice-error"}`} role="alert">
          <div>
            <span>{phase === "configuration" ? "FIREBASE SETUP REQUIRED" : "CONNECTION ISSUE"}</span>
            <strong>{visibleError}</strong>
          </div>
          {phase === "configuration" && <code>Copy .env.example to .env.local</code>}
        </aside>
      )}

      {!roomId && <RoomLobby onCreate={createRoom} onJoin={enterRoom} />}

      {roomId && (
        <>
      <section className="room-actions" aria-label="Room invite actions">
        <div>
          <span>ROOM CODE</span>
          <strong>{roomId}</strong>
        </div>
        <div>
          <button type="button" onClick={copyInvite}>{copyLabel}</button>
          <button type="button" className="leave-room" onClick={leaveRoom}>Leave room</button>
        </div>
      </section>

      <form className="video-selector" onSubmit={selectVideo} aria-label="Change the room video">
        <div>
          <span>SHARED VIDEO</span>
          <strong>Paste a YouTube link</strong>
        </div>
        <div className="video-selector-input">
          <input
            value={videoInput}
            onChange={(event) => {
              setVideoInput(event.target.value);
              setVideoInputError(null);
            }}
            placeholder="youtube.com/watch?v=…"
            aria-label="YouTube URL or video ID"
            aria-invalid={videoInputError ? true : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={!videoSelectionReady}>Play now</button>
          <button
            type="button"
            className="queue-add-button"
            onClick={queueVideo}
            disabled={!queueControlsReady}
          >
            Add to queue
          </button>
        </div>
        {videoInputError && <p role="alert">{videoInputError}</p>}
      </form>

      <section className="player-card" id="player" aria-label="Synchronized YouTube player controls">
        <div className="player-frame">
          <YouTube
            videoId={currentVideoId}
            onReady={onReady}
            onPlay={() => setPlayerStatus("playing")}
            onPause={() => setPlayerStatus("paused")}
            onError={() => setPlayerError("YouTube could not load the selected video.")}
            className="youtube-shell"
            iframeClassName="youtube-iframe"
            opts={{
              width: "100%",
              height: "100%",
              playerVars: {
                autoplay: 0,
                controls: 0,
                disablekb: 1,
                rel: 0,
              },
            }}
          />

          {playerReady && !playbackEnabled && phase === "ready" && (
            <div className="activation-layer">
              <span>JOIN {roomId.toUpperCase()}</span>
              <strong>Enable audio playback on this device</strong>
              <p>Your browser needs one click before it can follow remote play commands.</p>
              <button type="button" onClick={enablePlayback} disabled={isArmingPlayback}>
                <PlayIcon />
                {isArmingPlayback ? "Enabling…" : "Enable synced playback"}
              </button>
            </div>
          )}
        </div>

        <div className="control-deck">
          <div className="now-playing">
            <div className={`equalizer ${playerStatus === "playing" ? "is-playing" : ""}`} aria-hidden="true">
              <i /><i /><i /><i />
            </div>
            <div>
              <span className="meta-label">NOW PLAYING · {roomId}</span>
              <strong>YouTube · {currentVideoId}</strong>
            </div>
          </div>

          <div className="controls">
            <button type="button" onClick={play} disabled={!controlsReady} aria-label="Play video for the room">
              <PlayIcon />
              <span>Play</span>
            </button>
            <button type="button" onClick={pause} disabled={!controlsReady} aria-label="Pause video for the room">
              <PauseIcon />
              <span>Pause</span>
            </button>
            <button type="button" onClick={seekTo30} disabled={!controlsReady} aria-label="Seek the room to 30 seconds">
              <ForwardIcon />
              <span>30 sec</span>
            </button>
          </div>

          <div className="status" role="status" aria-live="polite">
            <span className={`status-light status-${phase === "ready" ? playerStatus : phase}`} />
            {statusLabel}
          </div>
        </div>
      </section>

      <section className="queue-card" aria-labelledby="queue-title">
        <header>
          <div>
            <span>COLLABORATIVE QUEUE</span>
            <h2 id="queue-title">Up next</h2>
          </div>
          <strong>{queue.length} {queue.length === 1 ? "video" : "videos"}</strong>
        </header>

        {queueError ? (
          <p className="queue-message queue-error" role="alert">{queueError}</p>
        ) : queue.length === 0 ? (
          <p className="queue-message">The queue is open. Add a YouTube link above.</p>
        ) : (
          <ol className="queue-list">
            {queue.map((item, index) => (
              <li key={item.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>YouTube video</strong>
                  <code>{item.videoId}</code>
                </div>
                <div className="queue-item-actions">
                  <button
                    type="button"
                    onClick={() => playQueuedVideo(item.id, item.videoId)}
                    disabled={!queueControlsReady}
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeFromQueue(item.id)}
                    disabled={!queueControlsReady}
                    aria-label={`Remove ${item.videoId} from queue`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
        </>
      )}

      <footer>
        <span>STEP 05</span>
        <div className="footer-line" />
        <p>Collaborative queue · shared video selection · synchronized playback</p>
      </footer>
    </main>
  );
}

export default App;
