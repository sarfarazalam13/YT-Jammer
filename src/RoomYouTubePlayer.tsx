import { useEffect, useRef } from "react";
import createYouTubePlayer from "youtube-player";

declare global {
  interface Window {
    YT?: { Player?: unknown };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApiPromise: Promise<void> | null = null;

function loadIframeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise<void>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      iframeApiPromise = null;
      reject(new Error("YouTube's player API could not be loaded."));
    };
    document.head.appendChild(script);
  });

  return iframeApiPromise;
}

export type YouTubePlayerApi = {
  cueVideoById(request: { videoId: string; startSeconds?: number }): void;
  destroy(): void;
  getAvailablePlaybackRates(): number[];
  getCurrentTime(): number;
  getDuration(): number;
  getIframe(): HTMLIFrameElement;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  loadVideoById(request: { videoId: string; startSeconds?: number }): void;
  mute(): void;
  pauseVideo(): void;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  unMute(): void;
};

type PlayerEvent = { target: YouTubePlayerApi; data: number };

type Props = {
  initialVideoId: string;
  roomId: string;
  onReady(player: YouTubePlayerApi): void;
  onPlay(): void;
  onPause(): void;
  onEnd(): void;
  onError(code: number, player: YouTubePlayerApi): void;
  onSetupError(message: string): void;
};

export function RoomYouTubePlayer(props: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    let controller: ReturnType<typeof createYouTubePlayer> | null = null;
    let readyListener: ReturnType<ReturnType<typeof createYouTubePlayer>["on"]> | null = null;
    let stateChangeListener: ReturnType<ReturnType<typeof createYouTubePlayer>["on"]> | null = null;
    let errorListener: ReturnType<ReturnType<typeof createYouTubePlayer>["on"]> | null = null;

    const ready = (rawEvent: unknown) => {
      if (!active) return;
      const event = rawEvent as PlayerEvent;
      const iframe = event.target.getIframe();
      iframe.className = "youtube-iframe";
      iframe.title = "YouTube video player";
      callbacksRef.current.onReady(event.target);
    };
    const stateChange = (rawEvent: unknown) => {
      if (!active) return;
      const event = rawEvent as PlayerEvent;
      if (event.data === 0) callbacksRef.current.onEnd();
      else if (event.data === 1) callbacksRef.current.onPlay();
      else if (event.data === 2) callbacksRef.current.onPause();
    };
    const error = (rawEvent: unknown) => {
      if (!active) return;
      const event = rawEvent as PlayerEvent;
      callbacksRef.current.onError(Number(event.data), event.target);
    };

    void loadIframeApi().then(() => {
      if (!active || !container.isConnected) return;
      controller = createYouTubePlayer(container, {
        width: "100%",
        height: "100%",
        videoId: props.initialVideoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          rel: 0,
          origin: window.location.origin,
        },
      });
      readyListener = controller.on("ready", ready);
      stateChangeListener = controller.on("stateChange", stateChange);
      errorListener = controller.on("error", error);
    }).catch((loadError: unknown) => {
      if (!active) return;
      callbacksRef.current.onSetupError(loadError instanceof Error ? loadError.message : "YouTube's player API could not be loaded.");
    });

    return () => {
      active = false;
      if (!controller) return;
      if (readyListener) controller.off(readyListener);
      if (stateChangeListener) controller.off(stateChangeListener);
      if (errorListener) controller.off(errorListener);
      void controller.destroy().catch(() => undefined);
    };
  }, [props.roomId]);

  return <div className="youtube-shell"><div ref={containerRef} className="youtube-iframe" /></div>;
}
