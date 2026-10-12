import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  child,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  type DatabaseReference,
} from "firebase/database";
import { ensureAnonymousUser, firebaseSetup } from "./firebase";
import {
  VIDEO_ID,
  parsePlaybackState,
  parseQueue,
  type PlaybackState,
  type PlaybackStatus,
  type QueueItem,
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
  const playbackRef = useRef<DatabaseReference | null>(null);
  const queueRef = useRef<DatabaseReference | null>(null);

  useEffect(() => {
    playbackRef.current = null;
    setUid(null);
    setConnected(null);
    setRemoteState(null);
    setLastPublishedCommandId(null);
    setRuntimeError(null);
    setQueue([]);
    setQueueError(null);
    setIsQueueUpdating(false);

    if (!firebaseSetup.services || !roomId) return;

    let active = true;
    let authenticated = false;
    const unsubscribers: Array<() => void> = [];
    const { auth, database } = firebaseSetup.services;

    ensureAnonymousUser(auth)
      .then(async (user) => {
        await user.getIdToken(true);
        if (!active) return;

        authenticated = true;
        setUid(user.uid);
        const roomPlaybackRef = ref(database, `rooms/${roomId}/playback`);
        const roomQueueRef = ref(database, `rooms/${roomId}/queue`);
        playbackRef.current = roomPlaybackRef;
        queueRef.current = roomQueueRef;

        unsubscribers.push(
          onValue(ref(database, ".info/connected"), (snapshot) => {
            if (active) setConnected(snapshot.val() === true);
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
                  videoId: VIDEO_ID,
                  status: "paused",
                  position: 0,
                  updatedAt: Date.now(),
                  updatedBy: user.uid,
                  commandId: "empty-room",
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
      queueRef.current = null;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [roomId]);

  const publish = useCallback(
    async (
      status: PlaybackStatus,
      position: number,
      videoId = remoteState?.videoId ?? VIDEO_ID,
    ): Promise<PublishResult> => {
      if (!playbackRef.current || !uid || connected !== true) return { ok: false, commandId: null };

      const commandId = crypto.randomUUID();
      setLastPublishedCommandId(commandId);
      setIsPublishing(true);
      setRuntimeError(null);

      try {
        await set(playbackRef.current, {
          videoId,
          status,
          position: Math.max(0, position),
          updatedAt: serverTimestamp(),
          updatedBy: uid,
          commandId,
        });
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
    [connected, remoteState?.videoId, uid],
  );

  const addToQueue = useCallback(
    async (videoId: string): Promise<boolean> => {
      if (!queueRef.current || !uid || connected !== true) return false;
      setIsQueueUpdating(true);
      setQueueError(null);
      try {
        await set(push(queueRef.current), {
          videoId,
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
    error: firebaseSetup.error ?? runtimeError,
    remoteState,
    serverTimeOffset,
    lastPublishedCommandId,
    publish,
    queue,
    queueError,
    isQueueUpdating,
    addToQueue,
    removeFromQueue,
  };
}
