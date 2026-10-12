export const VIDEO_ID = "dQw4w9WgXcQ";
export const SEEK_THRESHOLD_SECONDS = 1.25;
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export type PlaybackStatus = "playing" | "paused";

export type PlaybackState = {
  videoId: string;
  status: PlaybackStatus;
  position: number;
  updatedAt: number;
  updatedBy: string;
  commandId: string;
};

export type QueueItem = {
  id: string;
  videoId: string;
  addedAt: number;
  addedBy: string;
};

export type Participant = {
  uid: string;
  joinedAt: number;
};

export function parsePlaybackState(value: unknown): PlaybackState | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const isStatus = status === "playing" || status === "paused";

  if (
    typeof candidate.videoId !== "string" ||
    !YOUTUBE_VIDEO_ID_PATTERN.test(candidate.videoId) ||
    !isStatus ||
    typeof candidate.position !== "number" ||
    !Number.isFinite(candidate.position) ||
    candidate.position < 0 ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt) ||
    typeof candidate.updatedBy !== "string" ||
    candidate.updatedBy.length === 0 ||
    typeof candidate.commandId !== "string" ||
    candidate.commandId.length === 0
  ) {
    return null;
  }

  return {
    videoId: candidate.videoId,
    status,
    position: candidate.position,
    updatedAt: candidate.updatedAt,
    updatedBy: candidate.updatedBy,
    commandId: candidate.commandId,
  };
}

export function extractYouTubeVideoId(value: string): string | null {
  const candidate = value.trim();
  if (YOUTUBE_VIDEO_ID_PATTERN.test(candidate)) return candidate;

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let videoId: string | null = null;

    if (hostname === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (
      hostname === "youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "music.youtube.com"
    ) {
      if (url.pathname === "/watch") {
        videoId = url.searchParams.get("v");
      } else {
        const [kind, id] = url.pathname.split("/").filter(Boolean);
        if (kind === "shorts" || kind === "embed") videoId = id ?? null;
      }
    }

    return videoId && YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}

export function parseQueue(value: unknown): QueueItem[] {
  if (value === null) return [];
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>)
    .flatMap(([id, rawItem]) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      if (
        !YOUTUBE_VIDEO_ID_PATTERN.test(String(item.videoId ?? "")) ||
        typeof item.addedAt !== "number" ||
        !Number.isFinite(item.addedAt) ||
        typeof item.addedBy !== "string" ||
        item.addedBy.length === 0
      ) {
        return [];
      }
      return [{ id, videoId: item.videoId as string, addedAt: item.addedAt, addedBy: item.addedBy }];
    })
    .sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

export function parseParticipants(value: unknown): Participant[] {
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>)
    .flatMap(([uid, rawParticipant]) => {
      if (!uid || !rawParticipant || typeof rawParticipant !== "object") return [];
      const participant = rawParticipant as Record<string, unknown>;
      if (
        typeof participant.joinedAt !== "number" ||
        !Number.isFinite(participant.joinedAt) ||
        participant.joinedAt < 0
      ) {
        return [];
      }
      return [{ uid, joinedAt: participant.joinedAt }];
    })
    .sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
}

export function expectedPosition(state: PlaybackState, serverNowMs: number): number {
  if (state.status === "paused") return state.position;
  const elapsedSeconds = Math.max(0, serverNowMs - state.updatedAt) / 1000;
  return state.position + elapsedSeconds;
}

export function shouldSeek(
  currentPosition: number,
  targetPosition: number,
  threshold = SEEK_THRESHOLD_SECONDS,
): boolean {
  return Math.abs(currentPosition - targetPosition) > threshold;
}

export function isOwnLatestCommand(
  state: PlaybackState,
  lastPublishedCommandId: string | null,
): boolean {
  return lastPublishedCommandId !== null && state.commandId === lastPublishedCommandId;
}
