export const VIDEO_ID = "dQw4w9WgXcQ";
export const SEEK_THRESHOLD_SECONDS = 1.25;
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.25, 1.5, 2] as const;

export type PlaybackStatus = "playing" | "paused";

export type YouTubeVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
};

export type PlaybackState = {
  videoId: string;
  status: PlaybackStatus;
  position: number;
  updatedAt: number;
  updatedBy: string;
  commandId: string;
  rate: number;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
};

export type QueueItem = {
  id: string;
  videoId: string;
  addedAt: number;
  addedBy: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
};

export type AutoplayItem = YouTubeVideo & {
  id: string;
  rank: number;
};

export type AutoplayBuffer = {
  seedVideoId: string;
  generatedAt: number;
  generatedBy: string;
  items: AutoplayItem[];
};

export type Participant = {
  uid: string;
  joinedAt: number;
};

export function canClaimAdvance(value: unknown, fromCommandId: string, now: number): boolean {
  if (!value || typeof value !== "object") return true;
  const claim = value as Record<string, unknown>;
  if (claim.fromCommandId !== fromCommandId) return true;
  const claimedAt = typeof claim.claimedAt === "number" ? claim.claimedAt : 0;
  return now - claimedAt >= 5_000;
}

export function isTrustedYouTubeThumbnail(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "i.ytimg.com" ||
      url.hostname === "img.youtube.com"
    );
  } catch {
    return false;
  }
}

export function fallbackVideo(videoId: string): YouTubeVideo {
  return {
    videoId,
    title: "YouTube video",
    channelTitle: "YouTube",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: 0,
  };
}

function parseVideoMetadata(candidate: Record<string, unknown>, videoId: string): YouTubeVideo {
  const fallback = fallbackVideo(videoId);
  return {
    videoId,
    title: typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.slice(0, 200)
      : fallback.title,
    channelTitle: typeof candidate.channelTitle === "string" && candidate.channelTitle.trim()
      ? candidate.channelTitle.slice(0, 120)
      : fallback.channelTitle,
    thumbnailUrl: typeof candidate.thumbnailUrl === "string" && isTrustedYouTubeThumbnail(candidate.thumbnailUrl)
      ? candidate.thumbnailUrl
      : fallback.thumbnailUrl,
    durationSeconds: typeof candidate.durationSeconds === "number" &&
      Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds >= 0
      ? candidate.durationSeconds
      : 0,
  };
}

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

  const video = parseVideoMetadata(candidate, candidate.videoId);
  const rate = typeof candidate.rate === "number" && PLAYBACK_RATES.includes(candidate.rate as typeof PLAYBACK_RATES[number])
    ? candidate.rate
    : 1;

  return {
    videoId: candidate.videoId,
    status,
    position: candidate.position,
    updatedAt: candidate.updatedAt,
    updatedBy: candidate.updatedBy,
    commandId: candidate.commandId,
    rate,
    title: video.title,
    channelTitle: video.channelTitle,
    thumbnailUrl: video.thumbnailUrl,
    durationSeconds: video.durationSeconds,
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
      const video = parseVideoMetadata(item, item.videoId as string);
      return [{ id, ...video, addedAt: item.addedAt, addedBy: item.addedBy }];
    })
    .sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

export function parseAutoplayBuffer(value: unknown): AutoplayBuffer | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.seedVideoId !== "string" ||
    !YOUTUBE_VIDEO_ID_PATTERN.test(candidate.seedVideoId) ||
    typeof candidate.generatedAt !== "number" ||
    !Number.isFinite(candidate.generatedAt) ||
    typeof candidate.generatedBy !== "string" ||
    candidate.generatedBy.length === 0 ||
    (candidate.items !== undefined && (!candidate.items || typeof candidate.items !== "object"))
  ) return null;

  const items = Object.entries((candidate.items ?? {}) as Record<string, unknown>)
    .flatMap(([id, rawItem]) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      const videoId = String(item.videoId ?? "");
      if (
        !YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ||
        typeof item.rank !== "number" ||
        !Number.isInteger(item.rank) ||
        item.rank < 0 ||
        item.rank > 4
      ) return [];
      return [{ id, ...parseVideoMetadata(item, videoId), rank: item.rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, 5);

  return {
    seedVideoId: candidate.seedVideoId,
    generatedAt: candidate.generatedAt,
    generatedBy: candidate.generatedBy,
    items,
  };
}

export function selectAutoplayVideos(
  videos: YouTubeVideo[],
  excludedVideoIds: ReadonlySet<string>,
  limit = 5,
): YouTubeVideo[] {
  const selected: YouTubeVideo[] = [];
  const seen = new Set(excludedVideoIds);
  for (const video of videos) {
    if (seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    selected.push(video);
    if (selected.length >= limit) break;
  }
  return selected;
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
  return state.position + elapsedSeconds * state.rate;
}

export function clampPosition(position: number, duration: number): number {
  const safePosition = Number.isFinite(position) ? position : 0;
  return Math.min(Math.max(0, safePosition), duration > 0 ? duration : Number.MAX_SAFE_INTEGER);
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function playbackVideo(state: PlaybackState): YouTubeVideo {
  return {
    videoId: state.videoId,
    title: state.title,
    channelTitle: state.channelTitle,
    thumbnailUrl: state.thumbnailUrl,
    durationSeconds: state.durationSeconds,
  };
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
