import { describe, expect, it } from "vitest";
import {
  VIDEO_ID,
  expectedPosition,
  extractYouTubeVideoId,
  isOwnLatestCommand,
  parsePlaybackState,
  parseParticipants,
  parseQueue,
  shouldSeek,
  type PlaybackState,
} from "./sync";

const state: PlaybackState = {
  videoId: VIDEO_ID,
  status: "playing",
  position: 12,
  updatedAt: 10_000,
  updatedBy: "user-1",
  commandId: "command-1",
};

describe("playback synchronization helpers", () => {
  it("advances a playing state using server time", () => {
    expect(expectedPosition(state, 13_500)).toBe(15.5);
  });

  it("keeps a paused state fixed", () => {
    expect(expectedPosition({ ...state, status: "paused" }, 99_000)).toBe(12);
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
      { id: "first", videoId: VIDEO_ID, addedAt: 10, addedBy: "user-1" },
      { id: "second", videoId: "M7lc1UVf-VE", addedAt: 20, addedBy: "user-2" },
    ]);
    expect(parseQueue(null)).toEqual([]);
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
});
