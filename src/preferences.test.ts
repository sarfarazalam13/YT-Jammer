import { describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_PREFERENCES, readPlayerPreferences, writePlayerPreferences } from "./preferences";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("player preferences", () => {
  it("returns safe defaults for missing or malformed storage", () => {
    expect(readPlayerPreferences(null)).toEqual(DEFAULT_PLAYER_PREFERENCES);
    expect(readPlayerPreferences(memoryStorage({ "yt-jam:player-preferences": "{" }))).toEqual(DEFAULT_PLAYER_PREFERENCES);
  });

  it("clamps persisted volume and reads local mode and mute state", () => {
    const storage = memoryStorage({
      "yt-jam:player-preferences": JSON.stringify({ mode: "compact", volume: 130, muted: true }),
    });
    expect(readPlayerPreferences(storage)).toEqual({ mode: "compact", volume: 100, muted: true, playbackEnabled: true });
  });

  it("round-trips preferences", () => {
    const storage = memoryStorage();
    writePlayerPreferences(storage, { mode: "compact", volume: 42, muted: true, playbackEnabled: false });
    expect(readPlayerPreferences(storage)).toEqual({ mode: "compact", volume: 42, muted: true, playbackEnabled: false });
  });

  it("defaults existing stored preferences to playback enabled", () => {
    const storage = memoryStorage({
      "yt-jam:player-preferences": JSON.stringify({ mode: "video", volume: 70, muted: false }),
    });
    expect(readPlayerPreferences(storage).playbackEnabled).toBe(true);
  });
});
