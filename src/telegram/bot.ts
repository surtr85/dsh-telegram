import fs from "fs";
import path from "path";
import { Bot, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { AppConfig } from "../config.js";
import { DshClient, SessionItem } from "../dsh/client.js";

export class TelegramBridge {
  private bot: Bot;
  private config: AppConfig;
  private dsh: DshClient;
  private currentSessionId: string | null = null;
  private sessionStateFile: string;

  constructor(config: AppConfig, dshClient: DshClient) {
    this.config = config;
    this.dsh = dshClient;
    this.bot = new Bot(config.telegramToken);
    this.sessionStateFile = path.join(config.defaultCwd, ".dsh-session");

    this.loadPersistedSession();
    this.setupPlugins();
    this.setupMiddleware();
    this.setupCommands();
    this.setupMessageHandler();
  }

  private loadPersistedSession() {
    try {
      if (fs.existsSync(this.sessionStateFile)) {
        const id = fs.readFileSync(this.sessionStateFile, "utf8").trim();
        if (id) {
          this.currentSessionId = id;
          console.log(`[Bridge] Restored session from file: ${id}`);
        }
      }
    } catch {
      // ignore
    }
  }

  private persistSession(sessionId: string) {
    this.currentSessionId = sessionId;
    try {
      fs.writeFileSync(this.sessionStateFile, sessionId, "utf8");
    } catch {
      // ignore
    }
  }

  private setupPlugins() {
    this.bot.api.config.use(autoRetry());
    this.bot.api.config.use(apiThrottler());
  }

  private setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id;
      if (fromId !== this.config.allowedUserId) {
        console.warn(`[Security] Dropping message from unauthorized user: ${fromId}`);
        return;
      }
      await next();
    });
  }

  private async resolveSession(): Promise<string> {
    if (this.currentSessionId) {
      return this.currentSessionId;
    }

    const active = await this.dsh.getActiveSession();
    if (active) {
      this.persistSession(active.sessionId);
      return active.sessionId;
    }

    const created = await this.dsh.createSession();
    this.persistSession(created.sessionId);
    return created.sessionId;
  }

  private setupCommands() {
    // /start
    this.bot.command("start", async (ctx) => {
      try {
        const sessionId = await this.resolveSession();
        const sessions = await this.dsh.listSessions();
        const current = sessions.find((s) => s.sessionId === sessionId);
        const title = current?.projections?.values?.title || "Active DSH Workspace";
        const model = current?.projections?.values?.modelSelection?.lastUsed?.model || "Standard";

        const text =
          `🤖 *DeepSeek Harness (DSH) Bridge Connected*\n\n` +
          `📌 *Current Session:* ${title}\n` +
          `🆔 \`${sessionId}\`\n` +
          `🧠 *Model:* \`${model}\`\n\n` +
          `*Usage:*\n` +
          `• Send any message to chat and execute tasks directly in this session\\.\n` +
          `• \`/new\` \\- Start a brand new session\\.\n` +
          `• \`/session\` \\- Show status & tokens for current session\\.\n` +
          `• \`/sessions\` \\- Switch to another existing session\\.\n` +
          `• \`/attach\` \\- Re\\-attach to the newest active Web GUI session\\.`;

        await ctx.reply(text, { parse_mode: "MarkdownV2" });
      } catch (err: any) {
        await ctx.reply(`❌ Error initializing session: ${err.message}`);
      }
    });

    // /new
    this.bot.command("new", async (ctx) => {
      try {
        const waitMsg = await ctx.reply("✨ Creating new DSH session...");
        const created = await this.dsh.createSession();
        this.persistSession(created.sessionId);

        await ctx.api.editMessageText(
          ctx.chat.id,
          waitMsg.message_id,
          `✨ *New DSH Session Started*\n🆔 \`${created.sessionId}\`\n\nAll subsequent messages will execute inside this session\\.`,
          { parse_mode: "MarkdownV2" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Failed to create session: ${err.message}`);
      }
    });

    // /session or /status
    this.bot.command(["session", "status"], async (ctx) => {
      try {
        const sessionId = await this.resolveSession();
        const sessions = await this.dsh.listSessions();
        const current = sessions.find((s) => s.sessionId === sessionId);

        if (!current) {
          await ctx.reply(`Session \`${sessionId}\` not found in DSH catalog.`);
          return;
        }

        const vals = current.projections?.values;
        const title = vals?.title || "Untitled Session";
        const turns = current.projections?.asOfSeq || 0;
        const tokens = vals?.tokenUsage?.outputTokens || 0;

        const info =
          `📊 *Session Details*\n\n` +
          `📌 *Title:* ${title}\n` +
          `🆔 \`${sessionId}\`\n` +
          `🔄 *Status:* ${current.running ? "⏳ Busy / Running" : "💤 Idle"}\n` +
          `📈 *Events Seq:* ${turns}\n` +
          `📁 *CWD:* \`${current.cwd || this.config.defaultCwd}\``;

        await ctx.reply(info, { parse_mode: "Markdown" });
      } catch (err: any) {
        await ctx.reply(`❌ Error getting session: ${err.message}`);
      }
    });

    // /attach (sync with latest in Web GUI)
    this.bot.command("attach", async (ctx) => {
      try {
        const active = await this.dsh.getActiveSession();
        if (!active) {
          await ctx.reply("No active sessions found in DSH.");
          return;
        }
        this.persistSession(active.sessionId);
        const title = active.projections?.values?.title || "Active Web Session";
        await ctx.reply(
          `🔗 *Attached to Web GUI Session*\n📌 ${title}\n🆔 \`${active.sessionId}\``,
          { parse_mode: "Markdown" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Failed to attach: ${err.message}`);
      }
    });

    // /sessions (list and switch)
    this.bot.command("sessions", async (ctx) => {
      try {
        const items = await this.dsh.listSessions();
        if (items.length === 0) {
          await ctx.reply("No sessions available.");
          return;
        }

        const recent = items.slice(0, 6);
        const keyboard = new InlineKeyboard();

        let listText = "🗂 *Recent DSH Sessions:*\n\n";
        recent.forEach((s, idx) => {
          const isCurrent = s.sessionId === this.currentSessionId;
          const marker = isCurrent ? "👉 " : `${idx + 1}. `;
          const title = s.projections?.values?.title || `Session ${s.sessionId.slice(0, 8)}`;
          listText += `${marker}*${title}*\n\`${s.sessionId}\`\n\n`;

          keyboard.text(
            `${isCurrent ? "✅ " : ""}${idx + 1}. ${title.slice(0, 18)}`,
            `switch:${s.sessionId}`
          );
          if ((idx + 1) % 2 === 0) keyboard.row();
        });

        await ctx.reply(listText, {
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
      } catch (err: any) {
        await ctx.reply(`❌ Error listing sessions: ${err.message}`);
      }
    });

    // Handle inline button callbacks for session switching
    this.bot.callbackQuery(/^switch:(.+)$/, async (ctx) => {
      const targetSessionId = ctx.match[1];
      this.persistSession(targetSessionId);
      await ctx.answerCallbackQuery({ text: `Switched to session ${targetSessionId.slice(0, 8)}` });
      await ctx.editMessageText(
        `✅ *Active Session Switched*\n🆔 \`${targetSessionId}\`\nSubsequent messages will route here.`,
        { parse_mode: "Markdown" }
      );
    });
  }

  private setupMessageHandler() {
    this.bot.on("message:text", async (ctx) => {
      const userText = ctx.message.text.trim();
      if (userText.startsWith("/")) return; // Handled by commands

      const sessionId = await this.resolveSession();

      // Send initial progress message
      const statusMsg = await ctx.reply("⏳ _DSH is processing prompt..._", {
        parse_mode: "Markdown",
        reply_parameters: { message_id: ctx.message.message_id }
      });

      let currentStatus = "⏳ _DSH is thinking..._";
      let lastEditedText = currentStatus;
      let lastEditTime = Date.now();
      let completed = false;
      let updateTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const scheduleEdit = (newText: string, force = false) => {
        currentStatus = newText;
        const now = Date.now();
        const elapsed = now - lastEditTime;

        if (force || elapsed >= 1500) {
          if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
          }
          lastEditTime = now;
          if (newText !== lastEditedText) {
            lastEditedText = newText;
            ctx.api
              .editMessageText(ctx.chat.id, statusMsg.message_id, newText, {
                parse_mode: "Markdown"
              })
              .catch(() => {
                // Ignore telegram edit throttling or parse errors during stream
              });
          }
        } else if (!updateTimer) {
          updateTimer = setTimeout(() => {
            updateTimer = null;
            scheduleEdit(currentStatus, true);
          }, 1500 - elapsed);
        }
      };

      try {
        // Start streaming events
        unsubscribe = this.dsh.followSession(sessionId, {
          onToolCall: (name, desc) => {
            const shortDesc = desc ? ` \`${desc.slice(0, 40)}\`` : "";
            scheduleEdit(`⚙️ *Executing tool:* \`${name}\`${shortDesc}\n⏳ _Working..._`);
          },
          onToolResult: (name) => {
            scheduleEdit(`✅ *Finished tool:* \`${name}\`\n⏳ _Analyzing output..._`);
          },
          onAssistantMessage: (text, isFinal) => {
            if (isFinal) {
              completed = true;
              if (updateTimer) clearTimeout(updateTimer);

              // Split message if longer than Telegram 4000 char limit
              if (text.length <= 4000) {
                ctx.api
                  .editMessageText(ctx.chat.id, statusMsg.message_id, text)
                  .catch(() => {
                    ctx.reply(text);
                  });
              } else {
                ctx.api
                  .editMessageText(ctx.chat.id, statusMsg.message_id, text.slice(0, 4000))
                  .catch(() => {});
                ctx.reply(text.slice(4000));
              }

              if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
              }
            } else {
              // Intermediate text while tools are still running
              scheduleEdit(`💭 *Assistant Update:*\n\n${text.slice(-500)}`);
            }
          },
          onError: (err) => {
            console.error(`[Follow Stream Error]:`, err.message);
          }
        });

        // Submit prompt to DSH
        await this.dsh.sendPrompt(sessionId, userText);

        // Fallback safety timeout (10 minutes)
        setTimeout(() => {
          if (!completed && unsubscribe) {
            unsubscribe();
            scheduleEdit(`⚠️ _Turn timed out after 10m. Check DSH Web GUI for status._`, true);
          }
        }, 600000);
      } catch (err: any) {
        if (unsubscribe) unsubscribe();
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ *Error sending prompt to DSH:*\n\`${err.message}\``,
          { parse_mode: "Markdown" }
        );
      }
    });
  }

  public async start() {
    console.log(`[Bridge] Starting Telegram bot (@${this.bot.botInfo?.username || "bot"})...`);
    await this.bot.start({
      onStart: (info) => {
        console.log(`[Bridge] Connected successfully as @${info.username} (ID: ${info.id})`);
        console.log(`[Bridge] Whitelisted Telegram User: ${this.config.allowedUserId}`);
        console.log(`[Bridge] Target DSH Host: ${this.config.dshAuthority}`);
      }
    });
  }
}
