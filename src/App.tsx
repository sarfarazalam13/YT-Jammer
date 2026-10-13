import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createRoomId, isValidRoomId, normalizeRoomId, roomIdFromSearch, roomUrl } from "./rooms";
import { RoomYouTubePlayer, type YouTubePlayerApi } from "./RoomYouTubePlayer";
import { LEGACY_VIDEO_ID, PLAYBACK_RATES, VIDEO_ID, clampPosition, expectedPosition, formatTime, isOwnLatestCommand, playbackVideo, resolvePlayerErrorTarget, selectAutoplayVideos, shouldSeek, type PlaybackState, type YouTubeVideo } from "./sync";
import { type SyncPhase, usePlaybackSync } from "./usePlaybackSync";
import { browserRegion, fetchVideosByIds, fetchYouTubePlaylist, fetchYouTubeVideoPage, getSearchBudgetState, parseYouTubeInput, playlistVideosFromLinked, youtubeApiKey, type PlaylistPreview } from "./youtube";
import { readPlayerPreferences, writePlayerPreferences } from "./preferences";

type PlayerStatus = "loading" | "ready" | "playing" | "paused" | "ended";
type PlayerMode = "video" | "compact";
type SurfStatus = "idle" | "loading" | "ready" | "error";
const AUTOPLAY_CATALOG_VERSION = "syndicated-v1";
const REJECTED_VIDEO_IDS_KEY = "yt-jam:rejected-video-ids";

function readRejectedVideoIds(storage: Storage): Set<string> {
  try {
    const parsed = JSON.parse(storage.getItem(REJECTED_VIDEO_IDS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberRejectedVideoId(storage: Storage, videoIds: Set<string>, videoId: string): void {
  videoIds.add(videoId);
  try {
    storage.setItem(REJECTED_VIDEO_IDS_KEY, JSON.stringify([...videoIds]));
  } catch {
    // Playback recovery still works when session storage is unavailable.
  }
}

const phaseLabels: Record<SyncPhase, string> = { idle: "Choose room", configuration: "Setup needed", authenticating: "Signing in", connecting: "Connecting", ready: "Synced", syncing: "Syncing", offline: "Offline", error: "Sync error" };
function PlayIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2L18.5 12 8 5.4Z" /></svg>; }
function PauseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" /></svg>; }
function BackTenIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5V2L6 6l5 4V7a6 6 0 1 1-5 9.3l-1.7 1.1A8 8 0 1 0 11 5Z" /><text x="11.8" y="15.6">10</text></svg>; }
function ForwardTenIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5V2l5 4-5 4V7a6 6 0 1 0 5 9.3l1.7 1.1A8 8 0 1 1 13 5Z" /><text x="6.3" y="15.6">10</text></svg>; }
function NextIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 5 9 7-9 7V5Zm10 0h2v14h-2V5Z" /></svg>; }
function VolumeIcon({ muted }: { muted: boolean }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.2-.8-1.4 1.4a3.4 3.4 0 0 1 0 4.8l1.4 1.4a5.4 5.4 0 0 0 0-7.6Z" />{muted && <path className="icon-cut" d="m16.2 9.2 4.6 4.6m0-4.6-4.6 4.6" />}</svg>; }
function FullscreenIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z" /></svg>; }

function RoomLobby({ onCreate, onJoin }: { onCreate: () => void; onJoin: (roomId: string) => void }) {
  const [roomInput, setRoomInput] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const join = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeRoomId(roomInput);
    if (!isValidRoomId(normalized)) { setRoomError("Use at least 4 letters, numbers, or dashes."); return; }
    onJoin(normalized);
  };
  return <section className="room-lobby" aria-labelledby="room-lobby-title">
    <div className="lobby-copy"><span>STEP 07 · ROOMS</span><h2 id="room-lobby-title">Start together.</h2><p>Create a listening room, discover something on YouTube, and share the moment.</p><button className="create-room" type="button" onClick={onCreate}><PlayIcon />Create a room</button></div>
    <form className="join-room" onSubmit={join}><label htmlFor="room-code">Join with a room code</label><div><input id="room-code" value={roomInput} onChange={(event) => { setRoomInput(event.target.value); setRoomError(null); }} placeholder="neon-friday-a1b2" autoComplete="off" spellCheck={false} /><button type="submit">Join room</button></div><p className={roomError ? "room-error" : undefined} role={roomError ? "alert" : undefined}>{roomError ?? "Room codes are case-insensitive and become part of the invite link."}</p></form>
  </section>;
}

function App() {
  const playerRef = useRef<YouTubePlayerApi | null>(null);
  const playerCardRef = useRef<HTMLElement | null>(null);
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfSentinelRef = useRef<HTMLDivElement | null>(null);
  const surfPanelRef = useRef<HTMLElement | null>(null);
  const surfSearchInputRef = useRef<HTMLInputElement | null>(null);
  const surfVersionRef = useRef(0);
  const surfPageCountRef = useRef(0);
  const lastSurfPageAtRef = useRef(0);
  const recordedPlayRef = useRef<string | null>(null);
  const playedVideoIdsRef = useRef(new Set<string>());
  const lastAppliedCommandRef = useRef<string | null>(null);
  const latestRemoteRef = useRef<PlaybackState | null>(null);
  const autoplayRequestRef = useRef<string | null>(null);
  const autoplayValidatedSeedRef = useRef<string | null>(null);
  const legacyPlaybackMigratedRef = useRef(false);
  const failedPlaybackCommandRef = useRef<string | null>(null);
  const pendingPlaybackRef = useRef<{ commandId: string; videoId: string } | null>(null);
  const rejectedVideoIdsRef = useRef(readRejectedVideoIds(window.sessionStorage));
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>("loading");
  const [playerReady, setPlayerReady] = useState(false);
  const [playbackEnabled, setPlaybackEnabled] = useState(() => readPlayerPreferences(window.localStorage).playbackEnabled);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [joinNoticeDismissed, setJoinNoticeDismissed] = useState(false);
  const [isArmingPlayback, setIsArmingPlayback] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerErrorCode, setPlayerErrorCode] = useState<number | null>(null);
  const [playerEmbedBlocked, setPlayerEmbedBlocked] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(() => roomIdFromSearch(window.location.search));
  const [copyLabel, setCopyLabel] = useState("Copy invite");
  const [playerMode, setPlayerMode] = useState<PlayerMode>(() => readPlayerPreferences(window.localStorage).mode);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [volume, setVolume] = useState(() => readPlayerPreferences(window.localStorage).volume);
  const [muted, setMuted] = useState(() => readPlayerPreferences(window.localStorage).muted);
  const [availableRates, setAvailableRates] = useState<number[]>([1]);
  const [surfOpen, setSurfOpen] = useState(false);
  const [surfQuery, setSurfQuery] = useState("");
  const [surfRequest, setSurfRequest] = useState<string | undefined>();
  const [surfStatus, setSurfStatus] = useState<SurfStatus>("idle");
  const [surfError, setSurfError] = useState<string | null>(null);
  const [surfVideos, setSurfVideos] = useState<YouTubeVideo[]>([]);
  const [surfNextPageToken, setSurfNextPageToken] = useState<string | null>(null);
  const [isSurfLoadingMore, setIsSurfLoadingMore] = useState(false);
  const [playlistPreview, setPlaylistPreview] = useState<PlaylistPreview | null>(null);
  const [linkedVideo, setLinkedVideo] = useState<YouTubeVideo | null>(null);
  const [topSongVideos, setTopSongVideos] = useState<YouTubeVideo[]>([]);
  const [searchBudget, setSearchBudget] = useState(() => getSearchBudgetState(window.localStorage));
  const [playlistMessage, setPlaylistMessage] = useState<string | null>(null);
  const [autoplayMessage, setAutoplayMessage] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const { phase, uid, error: syncError, remoteState, serverTimeOffset, lastPublishedCommandId, publish, queue, queueError, isQueueUpdating, addToQueue, addManyToQueue, removeFromQueue, advancePlayback, autoplay, playbackFallback, autoplayError, replaceAutoplay, participants, hostId, presenceError, topSongs, topSongsError, recordPlay } = usePlaybackSync(roomId);
  const currentVideoId = remoteState?.videoId ?? VIDEO_ID;
  const currentVideo = remoteState ? playbackVideo(remoteState) : null;
  const controlsReady = playerReady && playbackEnabled && phase === "ready";

  useEffect(() => {
    latestRemoteRef.current = remoteState;
    if (pendingPlaybackRef.current && remoteState && remoteState.commandId !== pendingPlaybackRef.current.commandId) pendingPlaybackRef.current = null;
    if (remoteState?.videoId) playedVideoIdsRef.current.add(remoteState.videoId);
    if (remoteState?.status === "playing") setAutoplayMessage(null);
    if (remoteState?.commandId && remoteState.commandId !== failedPlaybackCommandRef.current) { setPlayerError(null); setPlayerErrorCode(null); }
  }, [remoteState]);
  const enterRoom = useCallback((nextRoomId: string) => { window.history.pushState({ roomId: nextRoomId }, "", roomUrl(nextRoomId, window.location)); setRoomId(nextRoomId); }, []);
  const createRoom = useCallback(() => enterRoom(createRoomId()), [enterRoom]);
  const leaveRoom = useCallback(() => { playerRef.current?.pauseVideo?.(); window.history.pushState({}, "", window.location.pathname); setRoomId(null); }, []);
  const copyInvite = useCallback(async () => { if (!roomId) return; try { await navigator.clipboard.writeText(roomUrl(roomId, window.location)); setCopyLabel("Invite copied"); window.setTimeout(() => setCopyLabel("Copy invite"), 1_800); } catch { setCopyLabel("Copy failed"); } }, [roomId]);
  const openSurf = useCallback(() => {
    setSurfOpen(true);
    setSurfRequest(undefined);
    window.requestAnimationFrame(() => {
      surfSearchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => { const readRoom = () => setRoomId(roomIdFromSearch(window.location.search)); window.addEventListener("popstate", readRoom); return () => window.removeEventListener("popstate", readRoom); }, []);
  useEffect(() => {
    playerRef.current = null;
    lastAppliedCommandRef.current = null;
    autoplayRequestRef.current = null;
    autoplayValidatedSeedRef.current = null;
    legacyPlaybackMigratedRef.current = false;
    failedPlaybackCommandRef.current = null;
    pendingPlaybackRef.current = null;
    recordedPlayRef.current = null;
    setPlayerReady(false);
    setPlaybackEnabled(readPlayerPreferences(window.localStorage).playbackEnabled);
    setAudioUnlocked(false);
    setJoinNoticeDismissed(false);
    setPlayerStatus("loading");
    setPlayerError(null);
    setPlayerErrorCode(null);
    setPlayerEmbedBlocked(false);
    setFallbackNotice(null);
    setPosition(0);
    setDuration(0);
    setSurfOpen(false);
    return () => {
      playerRef.current = null;
    };
  }, [roomId]);
  useEffect(() => { writePlayerPreferences(window.localStorage, { mode: playerMode, volume, muted, playbackEnabled }); }, [muted, playbackEnabled, playerMode, volume]);

  useEffect(() => {
    if (!surfOpen) return;
    const frame = window.requestAnimationFrame(() => {
      surfSearchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [surfOpen]);

  useEffect(() => {
    if (!surfOpen) return;
    const parsed = parseYouTubeInput(surfQuery);
    const delay = parsed.kind === "search" ? 1_500 : 350;
    const timeout = window.setTimeout(() => setSurfRequest(surfQuery.trim() || undefined), delay);
    return () => window.clearTimeout(timeout);
  }, [surfOpen, surfQuery]);

  useEffect(() => {
    if (!surfOpen) return;
    if (!youtubeApiKey) {
      setSurfStatus("idle");
      setSurfError(null);
      setSurfVideos([]);
      return;
    }
    const controller = new AbortController();
    const version = ++surfVersionRef.current;
    setSurfStatus("loading"); setSurfError(null);
    setSurfNextPageToken(null);
    setPlaylistPreview(null);
    setLinkedVideo(null);
    setPlaylistMessage(null);
    surfPageCountRef.current = 0;
    const input = parseYouTubeInput(surfRequest ?? "");
    if (input.kind === "search" && input.query.length < 3) {
      setSurfVideos([]);
      setSurfStatus("ready");
      setSurfError("Type at least 3 characters. Popular and YT Jam favorites remain available without using a search.");
      return () => controller.abort();
    }
    void (async () => {
      if (input.kind === "video-playlist") {
        const request = { apiKey: youtubeApiKey, regionCode: browserRegion(), signal: controller.signal };
        const [videoResult, playlistResult] = await Promise.allSettled([
          fetchVideosByIds([input.videoId], request),
          fetchYouTubePlaylist(input, request),
        ]);
        if (controller.signal.aborted || version !== surfVersionRef.current) return;
        const video = videoResult.status === "fulfilled" ? videoResult.value[0] ?? null : null;
        const preview = playlistResult.status === "fulfilled" ? playlistResult.value : null;
        const combined = [
          ...(video ? [video] : []),
          ...(preview?.videos ?? []).filter((candidate) => candidate.videoId !== video?.videoId),
        ];
        setLinkedVideo(video);
        setPlaylistPreview(preview);
        setSurfVideos(combined);
        if (preview) {
          const details = preview.skippedCount ? `${preview.skippedCount} unavailable ${preview.skippedCount === 1 ? "video was" : "videos were"} skipped.` : `${preview.videos.length} playable tracks found.`;
          setPlaylistMessage(video ? details : `The linked video is unavailable, but the playlist loaded. ${details}`);
        } else {
          const reason = playlistResult.status === "rejected" && playlistResult.reason instanceof Error ? playlistResult.reason.message : "The playlist could not be loaded.";
          setPlaylistMessage(video ? `The linked song is ready. Playlist import is unavailable: ${reason}` : null);
        }
        if (!video && !preview?.videos.length) {
          const videoReason = videoResult.status === "rejected" && videoResult.reason instanceof Error ? videoResult.reason.message : "The linked video is unavailable or cannot be embedded.";
          const playlistReason = playlistResult.status === "rejected" && playlistResult.reason instanceof Error ? playlistResult.reason.message : "The playlist is unavailable.";
          setSurfError(`${videoReason} ${playlistReason}`);
          setSurfStatus("error");
        } else {
          setSurfStatus("ready");
        }
        return;
      }
      if (input.kind === "playlist") {
        const preview = await fetchYouTubePlaylist(input, { apiKey: youtubeApiKey, regionCode: browserRegion(), signal: controller.signal });
        if (version !== surfVersionRef.current) return;
        setPlaylistPreview(preview);
        setSurfVideos(preview.videos);
        setPlaylistMessage(preview.skippedCount ? `${preview.skippedCount} unavailable ${preview.skippedCount === 1 ? "video was" : "videos were"} skipped.` : `${preview.videos.length} playable tracks found.`);
        setSurfStatus("ready");
        return;
      }
      if (input.kind === "video") {
        const videos = await fetchVideosByIds([input.videoId], { apiKey: youtubeApiKey, regionCode: browserRegion(), signal: controller.signal });
        if (version !== surfVersionRef.current) return;
        setSurfVideos(videos);
        setSurfStatus("ready");
        if (!videos.length) setSurfError("This YouTube video is unavailable or cannot be embedded.");
        return;
      }
      const page = await fetchYouTubeVideoPage({ apiKey: youtubeApiKey, query: input.kind === "search" ? input.query : undefined, regionCode: browserRegion(), signal: controller.signal });
      if (version !== surfVersionRef.current) return;
      setSurfVideos(page.videos);
      setSurfNextPageToken(page.nextPageToken);
      surfPageCountRef.current = 1;
      lastSurfPageAtRef.current = Date.now();
      setSurfStatus("ready");
    })().catch((error: unknown) => {
      if (controller.signal.aborted || version !== surfVersionRef.current) return;
      setSurfError(error instanceof Error ? error.message : "YouTube discovery failed.");
      setSurfStatus("error");
    }).finally(() => setSearchBudget(getSearchBudgetState(window.localStorage)));
    return () => controller.abort();
  }, [surfOpen, surfRequest]);

  const loadMoreSurfVideos = useCallback(async () => {
    if (!youtubeApiKey || !surfNextPageToken || isSurfLoadingMore || surfPageCountRef.current >= 3 || playlistPreview) return;
    const version = surfVersionRef.current;
    setIsSurfLoadingMore(true);
    try {
      const waitMs = Math.max(0, 2_500 - (Date.now() - lastSurfPageAtRef.current));
      if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      const input = parseYouTubeInput(surfRequest ?? "");
      const page = await fetchYouTubeVideoPage({ apiKey: youtubeApiKey, query: surfRequest, pageToken: surfNextPageToken, regionCode: browserRegion() });
      if (version !== surfVersionRef.current) return;
      setSurfVideos((current) => {
        const known = new Set(current.map((video) => video.videoId));
        return [...current, ...page.videos.filter((video) => !known.has(video.videoId))];
      });
      setSurfNextPageToken(page.nextPageToken);
      surfPageCountRef.current += 1;
      lastSurfPageAtRef.current = Date.now();
      if (input.kind === "video" || input.kind === "playlist" || input.kind === "video-playlist" || surfPageCountRef.current >= 3) setSurfNextPageToken(null);
    } catch (error) {
      if (version === surfVersionRef.current) setSurfError(error instanceof Error ? error.message : "Could not load more videos.");
    } finally {
      setSearchBudget(getSearchBudgetState(window.localStorage));
      if (version === surfVersionRef.current) setIsSurfLoadingMore(false);
    }
  }, [isSurfLoadingMore, playlistPreview, surfNextPageToken, surfRequest]);

  useEffect(() => {
    const sentinel = surfSentinelRef.current;
    if (!surfOpen || !sentinel || !surfNextPageToken) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreSurfVideos();
    }, { root: surfPanelRef.current, rootMargin: "320px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreSurfVideos, surfNextPageToken, surfOpen]);

  useEffect(() => {
    if (!youtubeApiKey || topSongs.length === 0) { setTopSongVideos([]); return; }
    const controller = new AbortController();
    void fetchVideosByIds(topSongs.map((song) => song.videoId), {
      apiKey: youtubeApiKey,
      regionCode: browserRegion(),
      signal: controller.signal,
    }).then((videos) => {
      const metadata = new Map(videos.map((video) => [video.videoId, video]));
      setTopSongVideos(topSongs.flatMap((song) => metadata.get(song.videoId) ? [metadata.get(song.videoId)!] : []));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [topSongs]);

  useEffect(() => {
    if (!remoteState || phase !== "ready" || uid !== hostId || remoteState.status !== "playing" || remoteState.position > 5) return;
    if (Date.now() + serverTimeOffset - remoteState.updatedAt > 60_000) return;
    if (recordedPlayRef.current === remoteState.commandId) return;
    recordedPlayRef.current = remoteState.commandId;
    void recordPlay(remoteState);
  }, [hostId, phase, recordPlay, remoteState, serverTimeOffset, uid]);

  useEffect(() => {
    if (!remoteState || !uid || uid !== hostId || phase !== "ready") return;
    const validatedSeed = `${remoteState.videoId}:${AUTOPLAY_CATALOG_VERSION}`;
    if (autoplay?.seedVideoId === remoteState.videoId && autoplay.items.length > 0 && autoplayValidatedSeedRef.current === validatedSeed) return;
    if (autoplayRequestRef.current === remoteState.videoId) return;
    if (!youtubeApiKey) {
      setAutoplayMessage("Related autoplay needs a configured YouTube API key.");
      return;
    }

    const seed = playbackVideo(remoteState);
    const hasUsefulMetadata = seed.title !== "YouTube video" && seed.channelTitle !== "YouTube";
    const query = hasUsefulMetadata ? `${seed.title} ${seed.channelTitle}` : undefined;
    const requestedVideoId = seed.videoId;
    autoplayRequestRef.current = requestedVideoId;
    autoplayValidatedSeedRef.current = validatedSeed;
    setAutoplayMessage("Preparing related autoplay…");

    void (async () => {
      const excluded = new Set<string>([
        requestedVideoId,
        ...playedVideoIdsRef.current,
        ...rejectedVideoIdsRef.current,
        ...queue.map((item) => item.videoId),
        ...(autoplay?.items.map((item) => item.videoId) ?? []),
      ]);
      let candidates: YouTubeVideo[] = [];
      if (query) {
        try {
          const related = await fetchYouTubeVideoPage({ apiKey: youtubeApiKey, query, regionCode: browserRegion() });
          candidates = related.videos;
        } catch {
          // A search cooldown must not stop global or Popular autoplay fallbacks.
        }
      }
      let selected = selectAutoplayVideos([...candidates, ...topSongVideos], excluded);
      if (selected.length < 5) {
        const popular = await fetchYouTubeVideoPage({ apiKey: youtubeApiKey, regionCode: browserRegion() });
        selected = selectAutoplayVideos([...selected, ...popular.videos], excluded);
      }
      if (selected.length === 0) throw new Error("No fresh related videos are available right now.");
      if (autoplayRequestRef.current !== requestedVideoId) return;
      const saved = await replaceAutoplay(requestedVideoId, selected);
      if (autoplayRequestRef.current === requestedVideoId && saved) setAutoplayMessage(`${selected.length} related tracks ready`);
    })().catch((error: unknown) => {
      if (autoplayRequestRef.current === requestedVideoId) {
        setAutoplayMessage(error instanceof Error ? error.message : "Could not prepare related autoplay.");
      }
    }).finally(() => {
      if (autoplayRequestRef.current === requestedVideoId) autoplayRequestRef.current = null;
    });

  }, [autoplay, hostId, phase, queue, remoteState, replaceAutoplay, topSongVideos, uid]);

  useEffect(() => {
    if (
      legacyPlaybackMigratedRef.current ||
      phase !== "ready" ||
      !uid || uid !== hostId ||
      remoteState?.videoId !== LEGACY_VIDEO_ID ||
      remoteState.title !== "YouTube video"
    ) return;
    legacyPlaybackMigratedRef.current = true;
    void publish("paused", 0, {
      video: {
        videoId: VIDEO_ID,
        title: "Choose a track from Surf YouTube",
        channelTitle: "YT Jam",
        thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
        durationSeconds: 0,
      },
      rate: 1,
    });
  }, [hostId, phase, publish, remoteState, uid]);

  const loadPlayerVideo = useCallback(async (
    player: YouTubePlayerApi,
    videoId: string,
    startSeconds: number,
    status: "playing" | "paused",
    rate: number,
  ): Promise<boolean> => {
    if (playerRef.current !== player) return false;
    try {
      const request = { videoId, startSeconds };
      if (status === "playing") await Promise.resolve(player.loadVideoById(request));
      else await Promise.resolve(player.cueVideoById(request));
      if (playerRef.current !== player) return false;
      await Promise.resolve(player.setPlaybackRate?.(rate));
      return playerRef.current === player;
    } catch (error) {
      if (playerRef.current === player) {
        setPlayerStatus("paused");
        setPlayerErrorCode(null);
        setPlayerEmbedBlocked(false);
        setPlayerError(error instanceof Error
          ? `Could not switch videos: ${error.message}`
          : "Could not switch videos. Try the track again.");
      }
      return false;
    }
  }, []);

  const applyRemoteState = useCallback((force = false, allowDisabled = false) => {
    const player = playerRef.current;
    if (!player || !playerReady || (!playbackEnabled && !allowDisabled) || !remoteState) return;
    if (!force) {
      if (lastAppliedCommandRef.current === remoteState.commandId) return;
      if (isOwnLatestCommand(remoteState, lastPublishedCommandId)) { lastAppliedCommandRef.current = remoteState.commandId; return; }
    }
    const calculated = expectedPosition(remoteState, Date.now() + serverTimeOffset);
    const loadedId = player.getVideoData?.()?.video_id;
    const playerDuration = Number(player.getDuration?.() ?? 0);
    const targetDuration = loadedId === remoteState.videoId
      ? playerDuration || remoteState.durationSeconds
      : remoteState.durationSeconds;
    const target = clampPosition(calculated, targetDuration);
    if (loadedId !== remoteState.videoId) {
      const commandId = remoteState.commandId;
      pendingPlaybackRef.current = { commandId, videoId: remoteState.videoId };
      void loadPlayerVideo(player, remoteState.videoId, target, remoteState.status, remoteState.rate).then((loaded) => {
        if (!loaded || latestRemoteRef.current?.commandId !== commandId) return;
        setPlayerStatus(remoteState.status);
        lastAppliedCommandRef.current = commandId;
      });
      return;
    } else {
      if (shouldSeek(Number(player.getCurrentTime?.() ?? 0), target)) player.seekTo(target, true);
      player.setPlaybackRate?.(remoteState.rate);
      const state = Number(player.getPlayerState?.());
      if (remoteState.status === "playing" && state !== 1) player.playVideo();
      if (remoteState.status === "paused" && state === 1) player.pauseVideo();
    }
    setPlayerStatus(remoteState.status); lastAppliedCommandRef.current = remoteState.commandId;
  }, [lastPublishedCommandId, loadPlayerVideo, playbackEnabled, playerReady, remoteState, serverTimeOffset]);

  useEffect(() => { applyRemoteState(false); }, [applyRemoteState]);
  useEffect(() => { if (!playbackEnabled || remoteState?.status !== "playing") return; const id = window.setInterval(() => applyRemoteState(true), 5_000); return () => window.clearInterval(id); }, [applyRemoteState, playbackEnabled, remoteState?.status]);
  useEffect(() => { if (!playerReady) return; const id = window.setInterval(() => { const player = playerRef.current; if (!player) return; if (seekDraft === null) setPosition(Number(player.getCurrentTime?.() ?? 0)); setDuration(Number(player.getDuration?.() ?? remoteState?.durationSeconds ?? 0)); }, 400); return () => window.clearInterval(id); }, [playerReady, remoteState?.durationSeconds, seekDraft]);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") applyRemoteState(true); }; document.addEventListener("visibilitychange", visible); return () => document.removeEventListener("visibilitychange", visible); }, [applyRemoteState]);
  useEffect(() => () => { if (activationTimerRef.current) clearTimeout(activationTimerRef.current); if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current); if (fallbackNoticeTimerRef.current) clearTimeout(fallbackNoticeTimerRef.current); }, []);

  const onReady = useCallback((target: YouTubePlayerApi) => {
    window.setTimeout(() => {
      let iframe: HTMLIFrameElement | null = null;
      try {
        iframe = target.getIframe?.() as HTMLIFrameElement | null;
      } catch {
        return;
      }
      if (!iframe?.isConnected || iframe !== document.querySelector(".youtube-iframe")) return;
      playerRef.current = target;
      setPlayerReady(true);
      setPlayerStatus("ready");
      setDuration(Number(target.getDuration?.() ?? 0));
      target.setVolume?.(volume);
      if (!playbackEnabled || !audioUnlocked || muted) target.mute?.();
      else target.unMute?.();
      const rates = (target.getAvailablePlaybackRates?.() ?? [1]).filter((rate: number) => PLAYBACK_RATES.includes(rate as typeof PLAYBACK_RATES[number]));
      setAvailableRates(rates.length ? rates : [1]);
    }, 0);
  }, [audioUnlocked, muted, playbackEnabled, volume]);

  const joinPlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player || phase !== "ready") return;
    setIsArmingPlayback(true);
    setPlaybackEnabled(true);
    setAudioUnlocked(true);
    setMuted(false);
    setJoinNoticeDismissed(true);
    player.setVolume?.(volume);
    player.unMute?.();
    applyRemoteState(true, true);
    activationTimerRef.current = setTimeout(() => setIsArmingPlayback(false), 180);
  }, [applyRemoteState, phase, volume]);

  const disablePlayback = useCallback(() => {
    playerRef.current?.pauseVideo?.();
    setPlaybackEnabled(false);
    setAudioUnlocked(false);
    setJoinNoticeDismissed(false);
    setPlayerStatus("paused");
  }, []);

  const publishAt = useCallback((nextPosition: number, status?: "playing" | "paused") => { const player = playerRef.current; if (!player || !controlsReady) return; const nextStatus = status ?? (Number(player.getPlayerState?.()) === 1 ? "playing" : "paused"); const safe = clampPosition(nextPosition, duration); player.seekTo(safe, true); setPosition(safe); void publish(nextStatus, safe); }, [controlsReady, duration, publish]);
  const play = useCallback(() => { const player = playerRef.current; if (!player || !controlsReady) return; const current = Number(player.getCurrentTime?.() ?? 0); player.playVideo(); setPlayerStatus("playing"); void publish("playing", current); }, [controlsReady, publish]);
  const pause = useCallback(() => { const player = playerRef.current; if (!player || !controlsReady) return; player.pauseVideo(); const current = Number(player.getCurrentTime?.() ?? 0); setPlayerStatus("paused"); void publish("paused", current); }, [controlsReady, publish]);
  const changeRate = useCallback((rate: number) => { const player = playerRef.current; if (!player || !controlsReady || !remoteState) return; player.setPlaybackRate(rate); void publish(remoteState.status, Number(player.getCurrentTime?.() ?? 0), { rate }); }, [controlsReady, publish, remoteState]);
  const changeVolume = useCallback((nextVolume: number) => { setVolume(nextVolume); playerRef.current?.setVolume?.(nextVolume); if (nextVolume > 0 && muted) { playerRef.current?.unMute?.(); setMuted(false); } }, [muted]);
  const toggleMute = useCallback(() => { const player = playerRef.current; if (!player) return; muted ? player.unMute() : player.mute(); setMuted(!muted); }, [muted]);
  const playVideo = useCallback(async (video: YouTubeVideo) => {
    const player = playerRef.current;
    if (!player || !controlsReady) return;
    const rate = remoteState?.rate ?? 1;
    const selectedIndex = surfVideos.findIndex((candidate) => candidate.videoId === video.videoId);
    const orderedSurfFallbacks = selectedIndex >= 0
      ? [...surfVideos.slice(selectedIndex + 1), ...surfVideos.slice(0, selectedIndex)]
      : surfVideos;
    const excluded = new Set<string>([
      video.videoId,
      currentVideoId,
      ...queue.map((item) => item.videoId),
      ...rejectedVideoIdsRef.current,
    ]);
    const fallbackVideos = selectAutoplayVideos([
      ...orderedSurfFallbacks,
      ...topSongVideos,
      ...(autoplay?.items ?? []),
    ], excluded);
    const result = await publish("playing", 0, { video, rate, fallbackVideos });
    if (!result.ok || playerRef.current !== player) return;
    pendingPlaybackRef.current = { commandId: result.commandId, videoId: video.videoId };
    const loaded = await loadPlayerVideo(player, video.videoId, 0, "playing", rate);
    if (!loaded || playerRef.current !== player) return;
    lastAppliedCommandRef.current = result.commandId;
    setPlayerStatus("playing");
    setPosition(0);
    setDuration(video.durationSeconds);
    setSurfOpen(false);
  }, [autoplay?.items, controlsReady, currentVideoId, loadPlayerVideo, publish, queue, remoteState?.rate, surfVideos, topSongVideos]);
  const queuePlaylist = useCallback(async () => {
    if (!playlistPreview) return;
    const existing = new Set([currentVideoId, ...queue.map((item) => item.videoId)]);
    const candidates = playlistVideosFromLinked(playlistPreview.videos, playlistPreview.highlightedVideoId, playlistPreview.highlightedIndex);
    const videos = candidates.filter((video) => !existing.has(video.videoId));
    const added = await addManyToQueue(videos);
    setPlaylistMessage(added > 0 ? `${added} playlist ${added === 1 ? "track" : "tracks"} added to the shared queue.` : "Every playable playlist track is already queued.");
  }, [addManyToQueue, currentVideoId, playlistPreview, queue]);
  const hasAdvanceCandidate = queue.length > 0 || Boolean(autoplay?.items.length) || Boolean(playbackFallback?.items.length && playbackFallback.forCommandId === remoteState?.commandId);
  const next = useCallback(async (fromCommandId = remoteState?.commandId) => { if (!fromCommandId) return false; return advancePlayback(fromCommandId); }, [advancePlayback, remoteState?.commandId]);
  const onEnded = useCallback(() => {
    setPlayerStatus("ended");
    const endedState = latestRemoteRef.current;
    const endedCommand = endedState?.commandId;
    if (!endedCommand) return;
    if (!hasAdvanceCandidate) {
      setAutoplayMessage("The related mix is still being prepared. Playback is safely paused.");
      void publish("paused", Math.max(duration, endedState?.durationSeconds ?? 0));
      return;
    }
    void advancePlayback(endedCommand).then((advanced) => {
      if (advanced) return;
      autoAdvanceTimerRef.current = setTimeout(() => {
        if (latestRemoteRef.current?.commandId === endedCommand) void advancePlayback(endedCommand);
      }, 5_200);
    }).catch(() => setAutoplayMessage("Could not advance automatically. You can try Next again."));
  }, [advancePlayback, duration, hasAdvanceCandidate, publish]);

  const onPlayerError = useCallback((errorCode: number, player: YouTubePlayerApi) => {
    if (playerRef.current && player !== playerRef.current) return;
    setPlayerErrorCode(Number.isFinite(errorCode) ? errorCode : null);
    if (errorCode === 153) {
      setPlayerEmbedBlocked(true);
      setPlayerStatus("paused");
      setPlayerError("This browser did not send the referrer identity required by YouTube. Reload once; if it continues, open this local URL in Chrome or Edge.");
      return;
    }

    const remote = latestRemoteRef.current;
    const loadedVideoId = player.getVideoData?.()?.video_id;
    const failedTarget = resolvePlayerErrorTarget(pendingPlaybackRef.current, remote, loadedVideoId);
    const failedCommandId = failedTarget?.commandId ?? null;
    const failedVideoId = failedTarget?.videoId ?? null;
    if (!failedCommandId || !failedVideoId) {
      setPlayerError("YouTube could not load this video. Choose another track from Surf YouTube.");
      return;
    }

    if (failedPlaybackCommandRef.current === failedCommandId) return;

    if (errorCode === 5) {
      pendingPlaybackRef.current = null;
      setPlayerEmbedBlocked(false);
      setPlayerStatus("paused");
      setPlayerError("This browser could not play the video's HTML5 stream. Retry the track or choose another one; it has not been blacklisted.");
      return;
    }

    if (errorCode !== 100 && errorCode !== 101 && errorCode !== 150) {
      pendingPlaybackRef.current = null;
      setPlayerEmbedBlocked(false);
      setPlayerStatus("paused");
      setPlayerError(errorCode === 2
        ? "YouTube rejected the video request. Try the track again or choose another one."
        : "YouTube could not play this video in the embedded player. Try it again or choose another track.");
      return;
    }

    failedPlaybackCommandRef.current = failedCommandId;
    pendingPlaybackRef.current = null;
    rememberRejectedVideoId(window.sessionStorage, rejectedVideoIdsRef.current, failedVideoId);
    playedVideoIdsRef.current.add(failedVideoId);
    setPlayerEmbedBlocked(false);
    setPlayerStatus("paused");
    const unavailableMessage = errorCode === 101 || errorCode === 150
      ? "The video owner does not allow this track to play in embedded players."
      : "This YouTube video is unavailable.";
    setPlayerError(`${unavailableMessage} Skipping to the next track…`);
    void advancePlayback(failedCommandId).then((advanced) => {
      if (advanced === "fallback") {
        setFallbackNotice("Exact video unavailable—playing a related track.");
        if (fallbackNoticeTimerRef.current) clearTimeout(fallbackNoticeTimerRef.current);
        fallbackNoticeTimerRef.current = setTimeout(() => setFallbackNotice(null), 8_000);
      }
      if (!advanced && latestRemoteRef.current?.commandId === failedCommandId) {
        failedPlaybackCommandRef.current = null;
        setPlayerError(`${unavailableMessage} No replacement is ready; choose another track from Surf YouTube.`);
      }
    }).catch(() => {
      failedPlaybackCommandRef.current = null;
      setPlayerError(`${unavailableMessage} No replacement is ready; choose another track from Surf YouTube.`);
    });
  }, [advancePlayback, hasAdvanceCandidate]);

  const visibleError = syncError;
  const timelineValue = seekDraft ?? position;
  const timelineMax = Math.max(1, duration || remoteState?.durationSeconds || 0);
  const statusLabel = phase === "ready" ? playerStatus : phaseLabels[phase];
  const remainingTime = Math.max(0, timelineMax - timelineValue);
  const sharedControlHint = controlsReady ? undefined : "Join playback on this device to use this control";
  const showTopSongs = topSongVideos.length > 0 && (!surfRequest || surfStatus === "error");

  return <main className={`app-shell ${roomId ? "has-room" : ""}`}>
    {roomId && <div className="music-backdrop" aria-hidden="true">
      {currentVideo?.thumbnailUrl && <div key={currentVideoId} className="music-backdrop-art" style={{ backgroundImage: `url(${currentVideo.thumbnailUrl})` }} />}
      <div className="music-backdrop-shade" />
    </div>}
    <nav className="topbar" aria-label="Primary navigation"><a className="brand" href="#player" aria-label="YT Jam home"><span className="brand-mark"><PlayIcon /></span><span>YT JAM</span></a><div className="room-pill"><span className={`live-dot phase-${phase}`} />{roomId ? `${roomId} · ${phaseLabels[phase]}` : "Choose or create a room"}</div></nav>
    {roomId && visibleError && <aside className={`notice ${phase === "configuration" ? "notice-setup" : "notice-error"}`} role="alert"><div><span>{phase === "configuration" ? "FIREBASE SETUP REQUIRED" : "CONNECTION ISSUE"}</span><strong>{visibleError}</strong></div>{phase === "configuration" ? <code>Copy .env.example to .env.local</code> : <button type="button" onClick={() => window.location.reload()}>Retry connection</button>}</aside>}
    {roomId && !visibleError && phase === "offline" && <aside className="notice notice-offline" role="status"><div><span>OFFLINE</span><strong>Playback controls will return when this device reconnects. The player will then apply the latest room state.</strong></div></aside>}
    {roomId && fallbackNotice && <aside className="notice notice-player" role="status"><div><span>PLAYBACK FALLBACK</span><strong>{fallbackNotice}</strong></div></aside>}
    {roomId && playerError && <aside className="notice notice-player" role="status"><div><span>{playerErrorCode === 153 ? "YOUTUBE EMBED BLOCKED · ERROR 153" : `PLAYBACK UNAVAILABLE${playerErrorCode === null ? "" : ` · ERROR ${playerErrorCode}`}`}</span><strong>{playerError}</strong></div><div className="notice-actions"><a href={`https://www.youtube.com/watch?v=${currentVideoId}`} target="_blank" rel="noreferrer">Open on YouTube</a><button type="button" onClick={() => { if (playerEmbedBlocked) window.location.reload(); else if (hasAdvanceCandidate) void next(); else openSurf(); }}>{playerEmbedBlocked ? "Retry player" : hasAdvanceCandidate ? "Skip video" : "Surf YouTube"}</button></div></aside>}
    {!roomId && <RoomLobby onCreate={createRoom} onJoin={enterRoom} />}
    {roomId && <>
      <section className="room-header" aria-label="Room controls and participants">
        <div className="room-actions" aria-label="Room invite actions"><div><span>ROOM CODE</span><strong>{roomId}</strong></div><div><button type="button" onClick={openSurf}>Surf YouTube</button><button type="button" onClick={copyInvite}>{copyLabel}</button><button type="button" className="leave-room" onClick={leaveRoom}>Leave room</button></div></div>
        <div className="presence-card" aria-label="Room participants"><div className="presence-summary"><span className={`role-badge ${uid && uid === hostId ? "is-host" : ""}`}>{uid && uid === hostId ? "HOST" : "GUEST"}</span><div><strong>{participants.length} {participants.length === 1 ? "listener" : "listeners"}</strong><span>{hostId ? "Room host is online" : "Electing a room host…"}</span></div></div><div className="participant-list" aria-label="Connected listeners">{participants.slice(0, 6).map((participant) => <span className={participant.uid === hostId ? "participant is-host" : "participant"} key={participant.uid}><i aria-hidden="true">{participant.uid === hostId ? "★" : "●"}</i>{participant.uid === uid ? "YOU" : `P-${participant.uid.slice(-4).toUpperCase()}`}</span>)}{participants.length > 6 && <span className="participant-more">+{participants.length - 6}</span>}</div>{presenceError && <p role="alert">{presenceError}</p>}</div>
      </section>
      {playerReady && phase === "ready" && (!playbackEnabled || !audioUnlocked) && !joinNoticeDismissed && <div className="join-notice-layer"><section className="join-notice" role="dialog" aria-labelledby="join-notice-title" aria-describedby="join-notice-copy"><span>{playbackEnabled ? "SYNCED SILENTLY" : "LOCAL PLAYBACK OFF"}</span><div className="join-notice-icon"><PlayIcon /></div><strong id="join-notice-title">{playbackEnabled ? "You’re in the room" : "Playback is off here"}</strong><p id="join-notice-copy">{playbackEnabled ? "The room is playing silently. Join the JAM to turn on sound and jump to the live position." : "Rejoin playback from the room’s current position. Browsing and queue controls stay available either way."}</p><div className="join-notice-actions"><button type="button" className="join-primary" onClick={joinPlayback} disabled={isArmingPlayback}><PlayIcon />{isArmingPlayback ? "Joining…" : playbackEnabled ? "Join the JAM" : "Join playback"}</button><button type="button" className="join-secondary" onClick={() => setJoinNoticeDismissed(true)}>Keep muted</button></div></section></div>}
      <div className="player-workspace">
      <section ref={playerCardRef} className={`player-card mode-${playerMode}`} id="player" aria-label="Synchronized YouTube player controls">
        <div className="track-art-glow" style={currentVideo?.thumbnailUrl ? { backgroundImage: `url(${currentVideo.thumbnailUrl})` } : undefined} aria-hidden="true" />
        <div className="player-toolbar">
          <div className="mode-switch" role="group" aria-label="Player display mode">
            <button type="button" className={playerMode === "video" ? "active" : ""} aria-pressed={playerMode === "video"} onClick={() => setPlayerMode("video")}>Video</button>
            <button type="button" className={playerMode === "compact" ? "active" : ""} aria-pressed={playerMode === "compact"} onClick={() => setPlayerMode("compact")}>Mini player</button>
          </div>
          <div className="player-toolbar-status"><button type="button" className="local-playback-toggle" onClick={playbackEnabled ? disablePlayback : joinPlayback} disabled={!playerReady || phase !== "ready" || isArmingPlayback}>{playbackEnabled ? "Disable playback" : "Join playback"}</button><div className="status" role="status" aria-live="polite"><span className={`status-light status-${phase === "ready" ? playerStatus : phase}`} />{playbackEnabled ? statusLabel : "Local playback off"}</div></div>
        </div>
        <div className="player-layout">
          <div className="player-frame">
            {remoteState
              ? <RoomYouTubePlayer key={`${window.location.origin}:${roomId}`} roomId={roomId} initialVideoId={remoteState.videoId} onReady={onReady} onPlay={() => { pendingPlaybackRef.current = null; setPlayerError(null); setPlayerErrorCode(null); setPlayerEmbedBlocked(false); setPlayerStatus("playing"); }} onPause={() => setPlayerStatus("paused")} onEnd={onEnded} onError={onPlayerError} onSetupError={(message) => { setPlayerReady(false); setPlayerEmbedBlocked(true); setPlayerError(message); }} />
              : <div className="youtube-shell" aria-label="Loading synchronized YouTube player" />}
          </div>
          <div className="player-console">
            <div className="now-playing">
              <div className={`equalizer ${playerStatus === "playing" ? "is-playing" : ""}`} aria-hidden="true"><i /><i /><i /><i /></div>
              <div><span className="meta-label">NOW PLAYING · {roomId}</span><strong>{currentVideo?.title ?? "YouTube video"}</strong><small>{currentVideo?.channelTitle ?? currentVideoId}</small></div>
            </div>
            <div className="timeline">
              <input type="range" min="0" max={timelineMax} step="0.1" value={clampPosition(timelineValue, timelineMax)} disabled={!controlsReady} title={sharedControlHint ?? "Seek shared playback"} aria-label="Seek shared playback" aria-valuetext={`${formatTime(timelineValue)} of ${formatTime(timelineMax)}`} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={() => { if (seekDraft !== null) publishAt(seekDraft); setSeekDraft(null); }} onKeyUp={() => { if (seekDraft !== null) publishAt(seekDraft); setSeekDraft(null); }} />
              <div><span>{formatTime(timelineValue)}</span><span aria-label={`${formatTime(remainingTime)} remaining`}>−{formatTime(remainingTime)}</span></div>
            </div>
            <div className="transport-modern" aria-label="Shared playback controls">
              <button type="button" className="transport-button" onClick={() => publishAt(position - 10)} disabled={!controlsReady} title={sharedControlHint ?? "Back 10 seconds"} aria-label="Seek backward 10 seconds"><BackTenIcon /></button>
              <button type="button" className={`transport-button play-main ${playerStatus === "playing" ? "is-playing" : ""}`} onClick={playerStatus === "playing" ? pause : play} disabled={!controlsReady} title={sharedControlHint ?? (playerStatus === "playing" ? "Pause" : "Play")} aria-label={playerStatus === "playing" ? "Pause shared playback" : "Play shared playback"}>{playerStatus === "playing" ? <PauseIcon /> : <PlayIcon />}</button>
              <button type="button" className="transport-button" onClick={() => publishAt(position + 10)} disabled={!controlsReady} title={sharedControlHint ?? "Forward 10 seconds"} aria-label="Seek forward 10 seconds"><ForwardTenIcon /></button>
              <button type="button" className="transport-button" onClick={() => void next()} disabled={!controlsReady || !hasAdvanceCandidate || isQueueUpdating} title={!controlsReady ? sharedControlHint : !hasAdvanceCandidate ? "The queue and related mix are empty" : isQueueUpdating ? "Updating the queue" : "Play next video"} aria-label="Play next video"><NextIcon /></button>
            </div>
            <div className="utility-row">
              <div className="volume-group">
                <button type="button" className="utility-icon" onClick={toggleMute} disabled={!playerReady || !audioUnlocked} title={!playerReady ? "The player is still loading" : !audioUnlocked ? "Join the JAM to enable audio" : muted ? "Unmute" : "Mute"} aria-label={muted || !audioUnlocked ? "Unmute local audio" : "Mute local audio"}><VolumeIcon muted={muted || !audioUnlocked} /></button>
                <input type="range" min="0" max="100" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} aria-label="Local volume" aria-valuetext={`${volume} percent`} title={!playerReady ? "The player is still loading" : `Volume ${volume}%`} disabled={!playerReady} />
              </div>
              <div className="player-options">
                <label className="speed-control"><span>Speed</span><select value={remoteState?.rate ?? 1} onChange={(event) => changeRate(Number(event.target.value))} disabled={!controlsReady} title={sharedControlHint ?? "Shared playback speed"} aria-label="Shared playback speed">{availableRates.map((rate) => <option value={rate} key={rate}>{rate}×</option>)}</select></label>
                <button type="button" className="utility-icon" onClick={() => void playerCardRef.current?.requestFullscreen?.()} disabled={!playerReady} title={!playerReady ? "The player is still loading" : "Enter fullscreen"} aria-label="Enter fullscreen"><FullscreenIcon /></button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="queue-card" aria-labelledby="queue-title"><header><div><span>COLLABORATIVE QUEUE</span><h2 id="queue-title">Up next</h2></div><strong>{queue.length} {queue.length === 1 ? "video" : "videos"}</strong></header>{queueError ? <p className="queue-message queue-error" role="alert">{queueError}</p> : queue.length === 0 ? <p className={autoplayError ? "queue-message queue-error" : "queue-message"} role={autoplayError ? "alert" : "status"}>{autoplayError ?? autoplayMessage ?? (autoplay?.items.length ? `${autoplay.items.length} related ${autoplay.items.length === 1 ? "track" : "tracks"} ready` : "Preparing related autoplay…")}</p> : <ol className="queue-list">{queue.map((item, index) => <li key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><img src={item.thumbnailUrl} alt="" /><div><strong>{item.title}</strong><small>{item.channelTitle} · {formatTime(item.durationSeconds)}</small></div><div className="queue-item-actions"><button type="button" onClick={() => void next()} disabled={!controlsReady || index !== 0 || isQueueUpdating}>Play</button><button type="button" onClick={() => void removeFromQueue(item.id)} disabled={phase !== "ready" || isQueueUpdating} aria-label={`Remove ${item.title} from queue`}>Remove</button></div></li>)}</ol>}</section>
      </div>
      {surfOpen && <section ref={surfPanelRef} className="surf-panel" id="surf-results" aria-labelledby="surf-title">
        <header><div><span>YOUTUBE DISCOVERY</span><h2 id="surf-title">Choose what plays next</h2></div><button type="button" onClick={() => setSurfOpen(false)} aria-label="Close YouTube discovery">Close</button></header>
        {!youtubeApiKey && <p className="surf-message">Add <code>VITE_YOUTUBE_API_KEY</code> to <code>.env.local</code>, then restart the dev server.</p>}
        {youtubeApiKey && <p className="surf-budget" role="status">{searchBudget.remaining} of {searchBudget.limit} uncached searches left today · links, playlists, Popular, and cached results do not use this search budget</p>}
        {surfStatus === "loading" && <p className="surf-message">Surfing YouTube…</p>}
        {surfError && <p className="surf-message surf-error" role="alert">{surfError}</p>}
        {topSongsError && <p className="surf-message surf-error" role="alert">{topSongsError}</p>}
        {showTopSongs && <section className="surf-section" aria-labelledby="top-songs-title"><div className="surf-section-heading"><span>COMMUNITY PICKS</span><h3 id="top-songs-title">Most played on YT Jam</h3></div><div className="surf-grid">{topSongVideos.filter((video) => video.videoId !== currentVideoId && !queue.some((item) => item.videoId === video.videoId) && !rejectedVideoIdsRef.current.has(video.videoId)).slice(0, 8).map((video) => <article key={`top-${video.videoId}`}><img src={video.thumbnailUrl} alt="" /><div><strong>{video.title}</strong><span>{video.channelTitle} · {formatTime(video.durationSeconds)}</span></div><div className="surf-actions"><button type="button" onClick={() => playVideo(video)} disabled={!controlsReady}>Play now</button><button type="button" onClick={() => void addToQueue(video)} disabled={phase !== "ready" || isQueueUpdating}>Queue</button></div></article>)}</div></section>}
        {(playlistPreview || linkedVideo) && <div className="playlist-summary"><div><span>{linkedVideo ? "VIDEO + PLAYLIST" : "PLAYLIST PREVIEW"}</span><strong>{playlistPreview ? `${playlistPreview.videos.length} playable tracks` : "Linked song ready"}</strong></div><div>{linkedVideo ? <><button type="button" onClick={() => void playVideo(linkedVideo)} disabled={!controlsReady}>Play linked song</button><button type="button" onClick={() => void addToQueue(linkedVideo)} disabled={phase !== "ready" || isQueueUpdating}>Queue song</button></> : <button type="button" onClick={() => playlistPreview?.videos[0] && void playVideo(playlistPreview.videos[0])} disabled={!controlsReady || !playlistPreview?.videos.length}>Play first</button>}{playlistPreview && <button type="button" onClick={() => void queuePlaylist()} disabled={phase !== "ready" || isQueueUpdating || playlistPreview.videos.length === 0}>{isQueueUpdating ? "Adding…" : linkedVideo ? "Queue playlist from here" : "Queue playlist"}</button>}</div></div>}
        {playlistMessage && <p className="surf-message" role="status">{playlistMessage}</p>}
        {surfStatus === "ready" && surfVideos.length === 0 && <p className="surf-message">No embeddable videos found. Keep typing to try another search.</p>}
        <div className="surf-grid">{surfVideos.filter((video) => !rejectedVideoIdsRef.current.has(video.videoId)).map((video) => <article key={video.videoId} className={playlistPreview?.highlightedVideoId === video.videoId ? "is-highlighted" : undefined}><img src={video.thumbnailUrl} alt="" /><div><strong>{video.title}</strong><span>{playlistPreview?.highlightedVideoId === video.videoId ? "LINKED VIDEO · " : ""}{video.channelTitle} · {formatTime(video.durationSeconds)}</span></div><div className="surf-actions"><button type="button" onClick={() => playVideo(video)} disabled={!controlsReady} title={!controlsReady ? "Join playback above to play this video" : "Play this video now"}>Play now</button><button type="button" onClick={() => void addToQueue(video)} disabled={phase !== "ready" || isQueueUpdating}>Queue</button></div></article>)}</div>
        <div ref={surfSentinelRef} className="surf-sentinel" aria-live="polite">{isSurfLoadingMore ? "Loading more videos…" : surfNextPageToken ? `Scroll for more · page ${surfPageCountRef.current} of 3` : surfVideos.length > 0 ? "You’ve reached the end of these results." : ""}</div>
        <small>Powered by YouTube · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a></small>
      </section>}
      <div className="surf-dock" role="search">
        <button type="button" className="surf-dock-brand" onClick={openSurf} aria-label="Open YouTube discovery"><span className="brand-mark"><PlayIcon /></span><span>Surf YouTube</span></button>
        <input ref={surfSearchInputRef} value={surfQuery} onFocus={() => setSurfOpen(true)} onChange={(event) => { setSurfQuery(event.target.value); setSurfOpen(true); }} placeholder="Search or paste a YouTube video / playlist…" aria-label="Search YouTube or paste a video or playlist link" aria-controls="surf-results" aria-expanded={surfOpen} />
        <button type="button" className="surf-popular" onClick={() => { setSurfOpen(true); setSurfQuery(""); setSurfRequest(undefined); }}>Popular</button>
        <button type="button" className="surf-dock-toggle" onClick={() => setSurfOpen((open) => !open)} aria-label={surfOpen ? "Close YouTube discovery" : "Open YouTube discovery"} aria-expanded={surfOpen}>{surfOpen ? "↓" : "↑"}</button>
      </div>
    </>}
    <footer><span>YT JAM</span><div className="footer-line" /><p>Shared listening, one timeline</p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a></footer>
  </main>;
}

export default App;
