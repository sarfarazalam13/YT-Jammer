import { expect, test, type Page } from "@playwright/test";

async function keepSmokeTestLocal(page: Page) {
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" ? route.continue() : route.abort();
  });
}

test("room lobby remains usable", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Find it. Feel it together." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a room" })).toBeVisible();
  await expect(page.getByLabel("Join with a room code")).toBeEditable();
});

test("player modes are presentation-only and mini player stays compliant", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.goto("/?room=smoke-room", { waitUntil: "domcontentloaded", timeout: 10_000 });

  const player = page.locator("#player");
  await expect(player).toHaveClass(/mode-video/);
  await page.getByRole("button", { name: "Mini player", exact: true }).click();
  await expect(player).toHaveClass(/mode-compact/);

  if (test.info().project.name === "mobile-chromium") {
    const frame = page.locator(".mode-compact .player-frame");
    await expect(frame).toBeVisible();
    const box = await frame.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(200);
    expect(box?.height).toBeGreaterThanOrEqual(200);
  }
});

test("Surf searches automatically after typing", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.route("https://www.googleapis.com/youtube/v3/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/search")) {
      await route.fulfill({ json: { items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "Continuous result", channelTitle: "YT Jam Tests", thumbnails: {} } }] } });
      return;
    }
    await route.fulfill({ json: { items: [{ id: "abcdefghijk", snippet: { title: "Continuous result", channelTitle: "YT Jam Tests", thumbnails: {} }, contentDetails: { duration: "PT3M" } }] } });
  });
  await page.goto("/?room=smoke-room", { waitUntil: "domcontentloaded", timeout: 10_000 });
  const playerTop = await page.locator("#player").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  const queueTop = await page.locator(".queue-card").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  await page.getByRole("button", { name: "Surf YouTube" }).click();
  await expect(page.getByLabel("Search YouTube automatically")).toBeFocused();
  const surfTop = await page.locator(".surf-panel").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  expect(surfTop).toBeGreaterThan(queueTop);
  await page.getByLabel("Search YouTube automatically").fill("lofi");
  await expect(page.getByText("Continuous result")).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.locator("#player").evaluate((element) => element.getBoundingClientRect().top + window.scrollY)).toBe(playerTop);
  await expect.poll(() => page.locator(".queue-card").evaluate((element) => element.getBoundingClientRect().top + window.scrollY)).toBe(queueTop);
});
