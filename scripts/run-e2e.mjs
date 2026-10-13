import { spawn } from "node:child_process";
import { once } from "node:events";

const preview = spawn(process.execPath, ["scripts/serve-dist.mjs"], { stdio: "inherit" });

async function waitForPreview() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4173");
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The production preview did not start.");
}

try {
  await waitForPreview();
  const runner = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test"],
    { stdio: "inherit", env: { ...process.env, YT_JAM_EXTERNAL_PREVIEW: "1" } },
  );
  const [code] = await once(runner, "exit");
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  preview.kill("SIGTERM");
}
