import { loadConfig } from "./config.js";
import { DshClient } from "./dsh/client.js";
import { TelegramBridge } from "./telegram/bot.js";

async function main() {
  console.log("==========================================");
  console.log("  DeepSeek Harness (DSH) Telegram Bridge  ");
  console.log("==========================================");

  try {
    const config = loadConfig();
    const dsh = new DshClient(config);

    // Verify DSH connectivity
    console.log(`[DSH] Checking connection to ${config.dshBaseUrl}...`);
    const sessions = await dsh.listSessions();
    console.log(`[DSH] Connected! Found ${sessions.length} existing sessions.`);

    const active = await dsh.getActiveSession();
    if (active) {
      console.log(`[DSH] Active session: "${active.projections?.values?.title || 'Untitled'}" (${active.sessionId})`);
    }

    const bridge = new TelegramBridge(config, dsh);
    await bridge.start();
  } catch (err: any) {
    console.error("[Fatal Error]:", err);
    process.exit(1);
  }
}

main();
