import { describe, expect, it } from "vitest";
import {
  LEGACY_VIDEO_ID,
  VIDEO_ID,
  canClaimAdvance,
  clampPosition,
  expectedPosition,
  extractYouTubeVideoId,
  isOwnLatestCommand,
  fallbackVideo,
  formatTime,
  isTrustedYouTubeThumbnail,
  parsePlaybackState,
  parseAutoplayBuffer,
  parsePlaybackFallback,
  parseParticipants,
  parseQueue,
  parseTopSongs,
  resolvePlayerErrorTarget,
  shouldSeek,
  selectAutoplayVideos,
  selectAdvanceCandidate,
  type PlaybackState,
} from "./sync";

const state: PlaybackState = {
  ...fallbackVideo(VIDEO_ID),
  videoId: VIDEO_ID,
  status: "playing",
  position: 12,
  updatedAt: 10_000,
  updatedBy: "user-1",
  commandId: "command-1",
  rate: 1,
};

describe("playback synchronization helpers", () => {
  it("advances a playing state using server time", () => {
    expect(expectedPosition(state, 13_500)).toBe(15.5);
  });

  it("keeps a paused state fixed", () => {
    expect(expectedPosition({ ...state, status: "paused" }, 99_000)).toBe(12);
  });

  it("advances playback at the shared rate", () => {
    expect(expectedPosition({ ...state, rate: 1.5 }, 12_000)).toBe(15);
  });

  it("does not move backward when the estimated server clock is behind", () => {
    expect(expectedPosition(state, 9_000)).toBe(12);
  });

  it("only seeks when drift exceeds the threshold", () => {
    expect(shouldSeek(10, 11.25)).toBe(false);
    expect(shouldSeek(10, 11.251)).toBe(true);
  });

  it("rejects malformed database snapshots", () => {
    expect(parsePlaybackState(null)).toBeNull();
    expect(parsePlaybackState({ ...state, status: "buffering" })).toBeNull();
    expect(parsePlaybackState({ ...state, position: -1 })).toBeNull();
    expect(parsePlaybackState({ ...state, commandId: "" })).toBeNull();
    expect(parsePlaybackState({ ...state, videoId: "too-short" })).toBeNull();
  });

  it("accepts a complete valid snapshot", () => {
    expect(parsePlaybackState(state)).toEqual(state);
  });

  it("identifies the client's latest command", () => {
    expect(isOwnLatestCommand(state, "command-1")).toBe(true);
    expect(isOwnLatestCommand(state, "command-2")).toBe(false);
    expect(isOwnLatestCommand(state, null)).toBe(false);
  });

  it("attributes an immediate player error to the pending video when YouTube still reports the previous video", () => {
    expect(resolvePlayerErrorTarget(
      { commandId: "new-command", videoId: "K9R7KcaettM" },
      { commandId: "new-command", videoId: "K9R7KcaettM" },
      "C9OmyNRyz4E",
    )).toEqual({ commandId: "new-command", videoId: "K9R7KcaettM" });
  });

  it("ignores an unrelated stale player error when no video load is pending", () => {
    expect(resolvePlayerErrorTarget(
      null,
      { commandId: "current-command", videoId: "K9R7KcaettM" },
      "C9OmyNRyz4E",
    )).toBeNull();
  });

  it("extracts ids from supported YouTube links", () => {
    expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYouTubeVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYouTubeVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("rejects unsupported or malformed video links", () => {
    expect(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeVideoId("not a video!!")).toBeNull();
  });

  it("parses and orders valid queue items", () => {
    expect(
      parseQueue({
        second: { videoId: "M7lc1UVf-VE", addedAt: 20, addedBy: "user-2" },
        invalid: { videoId: "short", addedAt: 5, addedBy: "user-3" },
        first: { videoId: VIDEO_ID, addedAt: 10, addedBy: "user-1" },
      }),
    ).toEqual([
      { id: "first", ...fallbackVideo(VIDEO_ID), addedAt: 10, addedBy: "user-1" },
      { id: "second", ...fallbackVideo("M7lc1UVf-VE"), addedAt: 20, addedBy: "user-2" },
    ]);
    expect(parseQueue(null)).toEqual([]);
  });

  it("formats and clamps timeline values", () => {
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3661)).toBe("1:01:01");
    expect(clampPosition(-2, 100)).toBe(0);
    expect(clampPosition(140, 100)).toBe(100);
  });

  it("only trusts YouTube thumbnail origins", () => {
    expect(isTrustedYouTubeThumbnail("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).toBe(true);
    expect(isTrustedYouTubeThumbnail("https://example.com/image.jpg")).toBe(false);
  });

  it("allows one advance claim per command until its lease expires", () => {
    expect(canClaimAdvance(null, "command-1", 10_000)).toBe(true);
    expect(canClaimAdvance({ fromCommandId: "command-1", claimedAt: 8_000 }, "command-1", 10_000)).toBe(false);
    expect(canClaimAdvance({ fromCommandId: "command-1", claimedAt: 5_000 }, "command-1", 10_000)).toBe(true);
    expect(canClaimAdvance({ fromCommandId: "command-2", claimedAt: 9_900 }, "command-1", 10_000)).toBe(true);
  });

  it("parses participants and orders them by join time", () => {
    expect(
      parseParticipants({
        later: { joinedAt: 20 },
        invalid: { joinedAt: "now" },
        first: { joinedAt: 10 },
      }),
    ).toEqual([
      { uid: "first", joinedAt: 10 },
      { uid: "later", joinedAt: 20 },
    ]);
    expect(parseParticipants(null)).toEqual([]);
  });

  it("parses, orders, and limits the hidden autoplay buffer", () => {
    const items = Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
      const videoId = `video-id-${index}x`;
      return [videoId, { ...fallbackVideo(videoId), rank: 6 - index }];
    }));
    items.invalid = { ...fallbackVideo(VIDEO_ID), rank: 12 };
    const parsed = parseAutoplayBuffer({
      seedVideoId: VIDEO_ID,
      generatedAt: 100,
      generatedBy: "host-1",
      items,
    });
    expect(parsed?.items).toHaveLength(5);
    expect(parsed?.items.map((item) => item.rank)).toEqual([0, 1, 2, 3, 4]);
    expect(parseAutoplayBuffer({ generatedAt: 100 })).toBeNull();
  });

  it("accepts a consumed autoplay buffer with no remaining items", () => {
    expect(parseAutoplayBuffer({
      seedVideoId: VIDEO_ID,
      generatedAt: 100,
      generatedBy: "host-1",
    })?.items).toEqual([]);
  });

  it("parses and orders a bounded playback fallback", () => {
    const parsed = parsePlaybackFallback({
      forCommandId: "command-new",
      sourceVideoId: VIDEO_ID,
      createdAt: 100,
      createdBy: "user-1",
      items: {
        "1": { ...fallbackVideo(LEGACY_VIDEO_ID), rank: 1 },
        "0": { ...fallbackVideo("aqz-KE-bpKQ"), rank: 0 },
        invalid: { ...fallbackVideo("jNQXAC9IVRw"), rank: 9 },
      },
    });
    expect(parsed?.items.map((item) => item.videoId)).toEqual(["aqz-KE-bpKQ", LEGACY_VIDEO_ID]);
    expect(parsePlaybackFallback({ forCommandId: "command-new" })).toBeNull();
  });

  it("prioritizes the visible queue and ignores stale playback fallbacks", () => {
    const queueItem = { id: "queued", ...fallbackVideo(LEGACY_VIDEO_ID), addedAt: 10, addedBy: "user-1" };
    const fallback = {
      forCommandId: state.commandId,
      sourceVideoId: state.videoId,
      createdAt: 10,
      createdBy: "user-1",
      items: [{ id: "0", ...fallbackVideo("aqz-KE-bpKQ"), rank: 0 }],
    };
    const autoplayBuffer = {
      seedVideoId: state.videoId,
      generatedAt: 10,
      generatedBy: "host-1",
      items: [{ id: "0", ...fallbackVideo("jNQXAC9IVRw"), rank: 0 }],
    };
    expect(selectAdvanceCandidate([queueItem], fallback, autoplayBuffer, state)?.source).toBe("queue");
    expect(selectAdvanceCandidate([], fallback, autoplayBuffer, state)?.source).toBe("fallback");
    expect(selectAdvanceCandidate([], { ...fallback, forCommandId: "stale" }, autoplayBuffer, state)?.source).toBe("autoplay");
  });

  it("selects five unique autoplay videos while respecting exclusions", () => {
    const videos = [
      fallbackVideo(VIDEO_ID),
      fallbackVideo(LEGACY_VIDEO_ID),
      fallbackVideo("aqz-KE-bpKQ"),
      fallbackVideo("jNQXAC9IVRw"),
      fallbackVideo("9bZkp7q19f0"),
      fallbackVideo("kJQP7kiw5Fk"),
      fallbackVideo("M7lc1UVf-VE"),
      fallbackVideo("3JZ_D3ELwOQ"),
    ];
    const selected = selectAutoplayVideos(videos, new Set([VIDEO_ID]));
    expect(selected.map((video) => video.videoId)).toEqual([
      LEGACY_VIDEO_ID,
      "aqz-KE-bpKQ",
      "jNQXAC9IVRw",
      "9bZkp7q19f0",
      "kJQP7kiw5Fk",
    ]);
  });

  it("parses and ranks global top songs while rejecting malformed entries", () => {
    const parsed = parseTopSongs({
      [VIDEO_ID]: { videoId: VIDEO_ID, playCount: 2, lastPlayedAt: 200, lastCommandId: "two", lastRoomId: "room-two" },
      [LEGACY_VIDEO_ID]: { videoId: LEGACY_VIDEO_ID, playCount: 4, lastPlayedAt: 100, lastCommandId: "one", lastRoomId: "room-one" },
      invalid: { videoId: "invalid", playCount: 99 },
    });
    expect(parsed.map((song) => song.videoId)).toEqual([LEGACY_VIDEO_ID, VIDEO_ID]);
  });
});
