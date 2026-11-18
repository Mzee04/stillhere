import { copyFile } from "node:fs/promises";

const brokenShop = new URL("../fixtures/broken-shop.js", import.meta.url);
const liveShop = new URL("../public/shop.js", import.meta.url);

try {
  await copyFile(brokenShop, liveShop);
  console.log("[StillHere] Restored the saved broken shop (Back/Refresh lose checkout state).");
  console.log("[StillHere] Run `npm run demo:loop` to record the real fail → agent fix → pass loop.");
} catch (error) {
  console.error(`[StillHere] Could not restore the demo shop: ${error.message}`);
  process.exitCode = 1;
}
