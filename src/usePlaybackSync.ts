import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  child,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  type DatabaseReference,
} from "firebase/database";
import { ensureAnonymousUser, firebaseSetup } from "./firebase";
import {
  VIDEO_ID,
  parsePlaybackState,
  parseParticipants,
  parseQueue,
  type PlaybackState,
  type PlaybackStatus,
  type Participant,
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
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
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
    setParticipants([]);
    setHostId(null);
    setPresenceError(null);

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
        const roomQueueRef = ref(database, `rooms/${roomId}/queue`);
        const roomParticipantsRef = ref(database, `rooms/${roomId}/participants`);
        const roomHostRef = ref(database, `rooms/${roomId}/hostId`);
        const ownParticipantRef = child(roomParticipantsRef, user.uid);
        playbackRef.current = roomPlaybackRef;
        queueRef.current = roomQueueRef;
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
    removeFromQueue,
    participants,
    hostId,
    presenceError,
  };
}
