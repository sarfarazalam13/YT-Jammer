import { describe, expect, it } from "vitest";
import {
  createRoomId,
  isValidRoomId,
  normalizeRoomId,
  roomIdFromSearch,
  roomUrl,
} from "./rooms";

describe("room helpers", () => {
  it("normalizes human-entered room names", () => {
    expect(normalizeRoomId("  Friday Night JAM!  ")).toBe("friday-night-jam");
  });

  it("rejects short and malformed room ids", () => {
    expect(isValidRoomId("abc")).toBe(false);
    expect(isValidRoomId("Room Name")).toBe(false);
    expect(isValidRoomId("valid-room-7")).toBe(true);
  });

  it("reads only valid room ids from a query string", () => {
    expect(roomIdFromSearch("?room=Friday%20Night")).toBe("friday-night");
    expect(roomIdFromSearch("?room=no")).toBeNull();
  });

  it("creates deterministic shareable room ids", () => {
    const values = [0, 0.2, 0.5];
    expect(createRoomId(() => values.shift() ?? 0)).toBe("amber-coral-i000");
  });

  it("builds a room invite URL", () => {
    expect(roomUrl("neon-room", { origin: "https://example.com", pathname: "/jam" })).toBe(
      "https://example.com/jam?room=neon-room",
    );
  });
});
