import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  child,
  get,
  onDisconnect,
  onValue,
  limitToLast,
  orderByChild,
  push,
  query,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
  type DatabaseReference,
} from "firebase/database";
import { ensureAnonymousUser, firebaseSetup } from "./firebase";
import {
  VIDEO_ID,
  canClaimAdvance,
  fallbackVideo,
  parsePlaybackState,
  parseAutoplayBuffer,
  parsePlaybackFallback,
  parseParticipants,
  parseQueue,
  parseTopSongs,
  playbackVideo,
  selectAdvanceCandidate,
  type PlaybackState,
  type PlaybackStatus,
  type Participant,
  type QueueItem,
  type YouTubeVideo,
  type AutoplayBuffer,
  type PlaybackFallback,
  type TopSong,
} from "./sync";

export type SyncPhase =
  | "idle"
  | "configuration"
  | "authenticating"
  | "connecting"
  | "ready"
  | "syncing"
  | "offline"
  | "error";

type PublishResult = { ok: true; commandId: string } | { ok: false; commandId: null };
type PublishOptions = { video?: YouTubeVideo; rate?: number; fallbackVideos?: YouTubeVideo[] };
export type AdvanceSource = "queue" | "fallback" | "autoplay";

export function usePlaybackSync(roomId: string | null) {
  const [uid, setUid] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [remoteState, setRemoteState] = useState<PlaybackState | null>(null);
  const [serverTimeOffset, setServerTimeOffset] = useState(0);
  const [lastPublishedCommandId, setLastPublishedCommandId] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [isQueueUpdating, setIsQueueUpdating] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState<AutoplayBuffer | null>(null);
  const [autoplayError, setAutoplayError] = useState<string | null>(null);
  const [playbackFallback, setPlaybackFallback] = useState<PlaybackFallback | null>(null);
  const [topSongs, setTopSongs] = useState<TopSong[]>([]);
  const [topSongsError, setTopSongsError] = useState<string | null>(null);
  const playbackRef = useRef<DatabaseReference | null>(null);
  const queueRef = useRef<DatabaseReference | null>(null);
  const roomRef = useRef<DatabaseReference | null>(null);
  const advanceClaimRef = useRef<DatabaseReference | null>(null);
  const autoplayRef = useRef<DatabaseReference | null>(null);
  const playbackFallbackRef = useRef<DatabaseReference | null>(null);

  useEffect(() => {
    playbackRef.current = null;
    roomRef.current = null;
    advanceClaimRef.current = null;
    autoplayRef.current = null;
    playbackFallbackRef.current = null;
    setUid(null);
    setConnected(null);
    setRemoteState(null);
    setLastPublishedCommandId(null);
    setRuntimeError(null);
    setQueue([]);
    setQueueError(null);
    setIsQueueUpdating(false);
    setParticipants([]);
    setHostId(null);
    setPresenceError(null);
    setAutoplay(null);
    setAutoplayError(null);
    setPlaybackFallback(null);
    setTopSongs([]);
    setTopSongsError(null);

    if (!firebaseSetup.services || !roomId) return;

    let active = true;
    let authenticated = false;
    let authenticatedUid: string | null = null;
    let databaseConnected = false;
    let currentHostId: string | null = null;
    let claimingHost = false;
    let participantDisconnect: ReturnType<typeof onDisconnect> | null = null;
    let hostDisconnect: ReturnType<typeof onDisconnect> | null = null;
    let participantReference: DatabaseReference | null = null;
    let hostReference: DatabaseReference | null = null;
    const unsubscribers: Array<() => void> = [];
    const { auth, database } = firebaseSetup.services;

    ensureAnonymousUser(auth)
      .then(async (user) => {
        await user.getIdToken(true);
        if (!active) return;

        authenticated = true;
        authenticatedUid = user.uid;
        setUid(user.uid);
        const roomPlaybackRef = ref(database, `rooms/${roomId}/playback`);
        const currentRoomRef = ref(database, `rooms/${roomId}`);
        const roomQueueRef = ref(database, `rooms/${roomId}/queue`);
        const roomParticipantsRef = ref(database, `rooms/${roomId}/participants`);
        const roomHostRef = ref(database, `rooms/${roomId}/hostId`);
        const roomAutoplayRef = ref(database, `rooms/${roomId}/autoplay`);
        const globalTopSongsRef = ref(database, "topSongs");
        const ownParticipantRef = child(roomParticipantsRef, user.uid);
        playbackRef.current = roomPlaybackRef;
        roomRef.current = currentRoomRef;
        advanceClaimRef.current = child(currentRoomRef, "advanceClaim");
        queueRef.current = roomQueueRef;
        autoplayRef.current = roomAutoplayRef;
        playbackFallbackRef.current = child(currentRoomRef, "playbackFallback");
        participantReference = ownParticipantRef;
        hostReference = roomHostRef;

        const reportPresenceError = (error: unknown) => {
          if (!active) return;
          const message = error instanceof Error ? error.message : "Unknown Firebase error";
          setPresenceError(
            message.toLowerCase().includes("permission_denied") || message.includes("PERMISSION_DENIED")
              ? "Publish the latest database.rules.json to enable live participants and host election."
              : `Presence synchronization failed: ${message}`,
          );
        };

        const scheduleHostDisconnect = async () => {
          try {
            const disconnect = onDisconnect(roomHostRef);
            await disconnect.remove();
            if (active) hostDisconnect = disconnect;
            else await disconnect.cancel();
          } catch (error) {
            reportPresenceError(error);
          }
        };

        const claimHost = async () => {
          if (!active || !databaseConnected || claimingHost || currentHostId) return;
          claimingHost = true;
          try {
            const result = await runTransaction(
              roomHostRef,
              (current) => current ?? user.uid,
              { applyLocally: false },
            );
            if (result.committed && result.snapshot.val() === user.uid) {
              await scheduleHostDisconnect();
            }
          } catch (error) {
            reportPresenceError(error);
          } finally {
            claimingHost = false;
          }
        };

        unsubscribers.push(
          onValue(ref(database, ".info/connected"), (snapshot) => {
            if (!active) return;
            const isConnected = snapshot.val() === true;
            databaseConnected = isConnected;
            setConnected(isConnected);
            if (!isConnected) return;

            void (async () => {
              try {
                const disconnect = onDisconnect(ownParticipantRef);
                await disconnect.remove();
                participantDisconnect = disconnect;
                await set(ownParticipantRef, { joinedAt: serverTimestamp() });
                setPresenceError(null);
                await claimHost();
              } catch (error) {
                reportPresenceError(error);
              }
            })();
          }),
          onValue(ref(database, ".info/serverTimeOffset"), (snapshot) => {
            const offset = snapshot.val();
            if (active && typeof offset === "number") setServerTimeOffset(offset);
          }),
          onValue(
            roomPlaybackRef,
            (snapshot) => {
              if (!active) return;
              const parsed = parsePlaybackState(snapshot.val());
              if (parsed) {
                setRemoteState(parsed);
                setRuntimeError(null);
              } else if (!snapshot.exists()) {
                setRemoteState({
                  ...fallbackVideo(VIDEO_ID),
                  videoId: VIDEO_ID,
                  status: "paused",
                  position: 0,
                  updatedAt: Date.now(),
                  updatedBy: user.uid,
                  commandId: "empty-room",
                  rate: 1,
                });
                setRuntimeError(null);
              } else if (snapshot.exists()) {
                setRuntimeError("The shared playback state is invalid.");
              }
            },
            (error) => {
              if (!active) return;
              const permissionDenied = error.message.includes("permission_denied");
              setRuntimeError(
                permissionDenied
                  ? "Firebase denied this room. Publish the latest database.rules.json, then reload."
                  : `Database listener failed: ${error.message}`,
              );
            },
          ),
          onValue(
            roomQueueRef,
            (snapshot) => {
              if (!active) return;
              setQueue(parseQueue(snapshot.val()));
              setQueueError(null);
            },
            (error) => {
              if (!active) return;
              setQueueError(
                error.message.includes("permission_denied")
                  ? "Publish the latest database.rules.json to enable the shared queue."
                  : `Queue listener failed: ${error.message}`,
              );
            },
          ),
          onValue(
            roomAutoplayRef,
            (snapshot) => {
              if (!active) return;
              setAutoplay(parseAutoplayBuffer(snapshot.val()));
              setAutoplayError(null);
            },
            (error) => {
              if (!active) return;
              setAutoplayError(
                error.message.toLowerCase().includes("permission_denied")
                  ? "Publish the latest database.rules.json to enable related autoplay."
                  : `Related autoplay listener failed: ${error.message}`,
              );
            },
          ),
          onValue(
            child(currentRoomRef, "playbackFallback"),
            (snapshot) => {
              if (active) setPlaybackFallback(parsePlaybackFallback(snapshot.val()));
            },
            () => {
              if (active) setPlaybackFallback(null);
            },
          ),
          onValue(
            roomParticipantsRef,
            (snapshot) => {
              if (!active) return;
              setParticipants(parseParticipants(snapshot.val()));
            },
            reportPresenceError,
          ),
          onValue(
            roomHostRef,
            (snapshot) => {
              if (!active) return;
              const value = snapshot.val();
              currentHostId = typeof value === "string" && value.length > 0 ? value : null;
              setHostId(currentHostId);
              if (!currentHostId) void claimHost();
            },
            reportPresenceError,
          ),
          onValue(
            query(globalTopSongsRef, orderByChild("playCount"), limitToLast(20)),
            (snapshot) => {
              if (!active) return;
              setTopSongs(parseTopSongs(snapshot.val()));
              setTopSongsError(null);
            },
            (error) => {
              if (!active) return;
              setTopSongsError(error.message.includes("permission_denied")
                ? "Publish the latest database.rules.json to enable global recommendations."
                : `Global recommendations failed: ${error.message}`);
            },
          ),
        );

      })
      .catch((error: unknown) => {
        if (active) {
          const context = authenticated ? "Room initialization failed" : "Firebase sign-in failed";
          setRuntimeError(
            error instanceof Error ? `${context}: ${error.message}` : `${context}.`,
          );
        }
      });

    return () => {
      active = false;
      playbackRef.current = null;
      roomRef.current = null;
      advanceClaimRef.current = null;
      autoplayRef.current = null;
      playbackFallbackRef.current = null;
      queueRef.current = null;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void participantDisconnect?.cancel().catch(() => undefined);
      void hostDisconnect?.cancel().catch(() => undefined);
      if (participantReference) void remove(participantReference).catch(() => undefined);
      if (hostReference && authenticatedUid && currentHostId === authenticatedUid) {
        void runTransaction(hostReference, (current) => (current === authenticatedUid ? null : current), {
          applyLocally: false,
        }).catch(() => undefined);
      }
    };
  }, [roomId]);

  const publish = useCallback(
    async (
      status: PlaybackStatus,
      position: number,
      options: PublishOptions = {},
    ): Promise<PublishResult> => {
      if (!playbackRef.current || !uid || connected !== true) return { ok: false, commandId: null };

      const commandId = crypto.randomUUID();
      const video = options.video ?? (remoteState ? playbackVideo(remoteState) : fallbackVideo(VIDEO_ID));
      const rate = options.rate ?? remoteState?.rate ?? 1;
      setLastPublishedCommandId(commandId);
      setIsPublishing(true);
      setRuntimeError(null);

      try {
        const playbackRecord = {
          ...video,
          status,
          position: Math.max(0, position),
          rate,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
          commandId,
        };
        if (options.video && roomRef.current) {
          const excluded = new Set([video.videoId]);
          const fallbacks = (options.fallbackVideos ?? []).filter((candidate) => {
            if (excluded.has(candidate.videoId)) return false;
            excluded.add(candidate.videoId);
            return true;
          }).slice(0, 5);
          const playbackFallback = fallbacks.length > 0 ? {
            forCommandId: commandId,
            sourceVideoId: video.videoId,
            createdAt: serverTimestamp(),
            createdBy: uid,
            items: Object.fromEntries(fallbacks.map((candidate, rank) => [String(rank), { ...candidate, rank }])),
          } : null;
          await update(roomRef.current, { playback: playbackRecord, playbackFallback });
        } else {
          await set(playbackRef.current, playbackRecord);
        }
        return { ok: true, commandId };
      } catch (error) {
        setRuntimeError(
          error instanceof Error ? `Could not publish playback: ${error.message}` : "Could not publish playback.",
        );
        return { ok: false, commandId: null };
      } finally {
        setIsPublishing(false);
      }
    },
    [connected, remoteState, uid],
  );

  const addToQueue = useCallback(
    async (video: YouTubeVideo): Promise<boolean> => {
      if (!queueRef.current || !uid || connected !== true) return false;
      setIsQueueUpdating(true);
      setQueueError(null);
      try {
        await set(push(queueRef.current), {
          ...video,
          addedAt: serverTimestamp(),
          addedBy: uid,
        });
        return true;
      } catch (error) {
        setQueueError(
          error instanceof Error ? `Could not add to queue: ${error.message}` : "Could not add to queue.",
        );
        return false;
      } finally {
        setIsQueueUpdating(false);
      }
    },
    [connected, uid],
  );

  const addManyToQueue = useCallback(
    async (videos: YouTubeVideo[]): Promise<number> => {
      if (!queueRef.current || !uid || connected !== true || videos.length === 0) return 0;
      setIsQueueUpdating(true);
      setQueueError(null);
      try {
        const additions: Record<string, unknown> = {};
        videos.slice(0, 50).forEach((video) => {
          const itemRef = push(queueRef.current!);
          if (!itemRef.key) return;
          additions[itemRef.key] = { ...video, addedAt: serverTimestamp(), addedBy: uid };
        });
        await update(queueRef.current, additions);
        return Object.keys(additions).length;
      } catch (error) {
        setQueueError(error instanceof Error ? `Could not import playlist: ${error.message}` : "Could not import playlist.");
        return 0;
      } finally {
        setIsQueueUpdating(false);
      }
    },
    [connected, uid],
  );

  const recordPlay = useCallback(
    async (state: PlaybackState): Promise<boolean> => {
      if (!firebaseSetup.services || !roomId || !uid || uid !== hostId || connected !== true) return false;
      if (state.status !== "playing" || state.position > 5) return false;
      const songRef = ref(firebaseSetup.services.database, `topSongs/${state.videoId}`);
      try {
        const result = await runTransaction(songRef, (current) => {
          if (current && typeof current === "object" && current.lastCommandId === state.commandId) return;
          const count = current && typeof current === "object" && Number.isInteger(current.playCount) ? current.playCount : 0;
          return { videoId: state.videoId, playCount: count + 1, lastPlayedAt: serverTimestamp(), lastCommandId: state.commandId, lastRoomId: roomId };
        }, { applyLocally: false });
        return result.committed;
      } catch (error) {
        setTopSongsError(error instanceof Error ? `Could not update global recommendations: ${error.message}` : "Could not update global recommendations.");
        return false;
      }
    },
    [connected, hostId, roomId, uid],
  );

  const advancePlayback = useCallback(
    async (fromCommandId: string): Promise<AdvanceSource | false> => {
      if (
        !roomRef.current || !advanceClaimRef.current ||
        !uid || connected !== true || !remoteState
      ) return false;

      const now = Date.now() + serverTimeOffset;
      setIsQueueUpdating(true);
      setQueueError(null);
      try {
        const claim = await runTransaction(
          advanceClaimRef.current,
          (current) => {
            if (!canClaimAdvance(current, fromCommandId, now)) return;
            return { fromCommandId, claimedBy: uid, claimedAt: now };
          },
          { applyLocally: false },
        );
        if (!claim.committed) return false;

        if (!playbackRef.current || !queueRef.current || !autoplayRef.current || !playbackFallbackRef.current) return false;
        const [playbackSnapshot, queueSnapshot, fallbackSnapshot, autoplaySnapshot] = await Promise.all([
          get(playbackRef.current),
          get(queueRef.current),
          get(playbackFallbackRef.current),
          get(autoplayRef.current),
        ]);
        const currentPlayback = parsePlaybackState(playbackSnapshot.val());
        if (!currentPlayback || currentPlayback.commandId !== fromCommandId) return false;
        const latestQueue = parseQueue(queueSnapshot.val());
        const latestFallback = parsePlaybackFallback(fallbackSnapshot.val());
        const latestAutoplay = parseAutoplayBuffer(autoplaySnapshot.val());
        const candidate = selectAdvanceCandidate(latestQueue, latestFallback, latestAutoplay, currentPlayback);
        if (!candidate) return false;
        const { item, source } = candidate;

        const commandId = crypto.randomUUID();
        const nextPlayback = {
          videoId: item.videoId,
          title: item.title,
          channelTitle: item.channelTitle,
          thumbnailUrl: item.thumbnailUrl,
          durationSeconds: item.durationSeconds,
          status: "playing",
          position: 0,
          rate: currentPlayback.rate,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
          commandId,
        };

        const updates: Record<string, unknown> = { playback: nextPlayback };
        if (source === "queue") updates[`queue/${item.id}`] = null;
        if (source === "fallback") updates.playbackFallback = null;
        if (source === "autoplay") updates[`autoplay/items/${item.id}`] = null;
        await update(roomRef.current, updates);
        return source;
      } catch (error) {
        setQueueError(
          error instanceof Error ? `Could not advance playback: ${error.message}` : "Could not advance playback.",
        );
        return false;
      } finally {
        setIsQueueUpdating(false);
      }
    },
    [connected, remoteState, serverTimeOffset, uid],
  );

  const replaceAutoplay = useCallback(
    async (seedVideoId: string, videos: YouTubeVideo[]): Promise<boolean> => {
      if (!autoplayRef.current || !uid || uid !== hostId || connected !== true) return false;
      setAutoplayError(null);
      try {
        const items = Object.fromEntries(videos.slice(0, 5).map((video, rank) => [String(rank), { ...video, rank }]));
        await set(autoplayRef.current, {
          seedVideoId,
          generatedAt: serverTimestamp(),
          generatedBy: uid,
          items,
        });
        return true;
      } catch (error) {
        setAutoplayError(
          error instanceof Error ? `Could not prepare related autoplay: ${error.message}` : "Could not prepare related autoplay.",
        );
        return false;
      }
    },
    [connected, hostId, uid],
  );

  const removeFromQueue = useCallback(
    async (itemId: string): Promise<boolean> => {
      if (!queueRef.current || connected !== true) return false;
      setIsQueueUpdating(true);
      setQueueError(null);
      try {
        await remove(child(queueRef.current, itemId));
        return true;
      } catch (error) {
        setQueueError(
          error instanceof Error ? `Could not update queue: ${error.message}` : "Could not update queue.",
        );
        return false;
      } finally {
        setIsQueueUpdating(false);
      }
    },
    [connected],
  );

  const phase = useMemo<SyncPhase>(() => {
    if (!roomId) return "idle";
    if (firebaseSetup.error) return "configuration";
    if (runtimeError) return "error";
    if (!uid) return "authenticating";
    if (connected === false) return "offline";
    if (connected !== true || !remoteState) return "connecting";
    if (isPublishing) return "syncing";
    return "ready";
  }, [connected, isPublishing, remoteState, roomId, runtimeError, uid]);

  return {
    phase,
    uid,
    error: firebaseSetup.error ?? runtimeError,
    remoteState,
    serverTimeOffset,
    lastPublishedCommandId,
    publish,
    queue,
    queueError,
    isQueueUpdating,
    addToQueue,
    addManyToQueue,
    removeFromQueue,
    advancePlayback,
    autoplay,
    playbackFallback,
    autoplayError,
    replaceAutoplay,
    participants,
    hostId,
    presenceError,
    topSongs,
    topSongsError,
    recordPlay,
  };
}
