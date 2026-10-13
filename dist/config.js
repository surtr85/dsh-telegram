import fs from "fs";
import path from "path";
import yaml from "yaml";
function resolveTelegramToken(credsPath) {
    // 1. Environment variable
    if (process.env.TELEGRAM_BOT_TOKEN) {
        return process.env.TELEGRAM_BOT_TOKEN.trim();
    }
    // 2. SOPS secret file if exists
    const sopsPath = "/run/secrets/telegram-bot-token";
    if (fs.existsSync(sopsPath)) {
        try {
            return fs.readFileSync(sopsPath, "utf8").trim();
        }
        catch {
            // ignore
        }
    }
    // 3. Fallback to ~/.dsh/.credentials.yaml
    if (fs.existsSync(credsPath)) {
        try {
            const creds = yaml.parse(fs.readFileSync(credsPath, "utf8"));
            // Look for any ref containing telegram token
            for (const [key, val] of Object.entries(creds.refs || {})) {
                if (key.includes("telegram") && typeof val === "string" && val.includes(":")) {
                    return val.trim();
                }
            }
        }
        catch {
            // ignore
        }
    }
    throw new Error("Telegram bot token not found in env, /run/secrets, or credentials.yaml");
}
function resolveAllowedUserId(homeDir) {
    if (process.env.TELEGRAM_ALLOWED_USER_ID) {
        return parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
    }
    // Check channels.json in dsh-im-connect if available
    const channelsPath = path.join(homeDir, ".dsh/dsh-im-connect/channels.json");
    if (fs.existsSync(channelsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
            for (const list of Object.values(data.allowlist || {})) {
                if (Array.isArray(list) && list.length > 0) {
                    const id = parseInt(list[0], 10);
                    if (!isNaN(id))
                        return id;
                }
            }
        }
        catch {
            // ignore
        }
    }
    return 7273048535; // Default to Sajjad's user ID
}
export function loadConfig() {
    const homeDir = process.env.HOME || "/home/amadeus";
    const credentialsPath = path.join(homeDir, ".dsh/.credentials.yaml");
    const telegramToken = resolveTelegramToken(credentialsPath);
    const allowedUserId = resolveAllowedUserId(homeDir);
    const dshHost = process.env.DSH_HOST || "127.0.0.1";
    const dshPort = process.env.DSH_PORT || "3080";
    const dshAuthority = `${dshHost}:${dshPort}`;
    return {
        telegramToken,
        allowedUserId,
        dshBaseUrl: `http://${dshAuthority}`,
        dshWsUrl: `ws://${dshAuthority}`,
        dshAuthority,
        credentialsPath,
        defaultCwd: process.env.DSH_DEFAULT_CWD || "/home/amadeus/Projects"
    };
}
