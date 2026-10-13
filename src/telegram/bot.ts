import fs from "fs";
import path from "path";
import { Bot, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { AppConfig } from "../config.js";
import { DshClient } from "../dsh/client.js";
import { formatToTelegramHtml, stripHtml, chunkHtmlMessage } from "./formatter.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
      console.log(`[Bridge] Received /start from user ${ctx.from?.id}`);
      try {
        const sessionId = await this.resolveSession();
        const sessions = await this.dsh.listSessions();
        const current = sessions.find((s) => s.sessionId === sessionId);
        const title = current?.projections?.values?.title || "Active DSH Workspace";
        const model = current?.projections?.values?.modelSelection?.lastUsed?.model || "Standard";

        const text =
          `🤖 <b>DeepSeek Harness (DSH) Bridge Connected</b>\n\n` +
          `📌 <b>Current Session:</b> ${escapeHtml(title)}\n` +
          `🆔 <code>${sessionId}</code>\n` +
          `🧠 <b>Model:</b> <code>${escapeHtml(model)}</code>\n\n` +
          `<b>Commands & Usage:</b>\n` +
          `• Send any text to chat and work directly inside this session.\n` +
          `• <code>/new</code> - Start a brand new session.\n` +
          `• <code>/session</code> - Show details & token metrics for this session.\n` +
          `• <code>/sessions</code> - Browse & switch between recent sessions.\n` +
          `• <code>/attach</code> - Re-attach to the newest active Web GUI session.`;

        await ctx.reply(text, { parse_mode: "HTML" });
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
          `✨ <b>New DSH Session Started</b>\n🆔 <code>${created.sessionId}</code>\n\nAll subsequent messages will execute inside this session.`,
          { parse_mode: "HTML" }
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
          await ctx.reply(`Session <code>${sessionId}</code> not found in DSH catalog.`, { parse_mode: "HTML" });
          return;
        }

        const vals = current.projections?.values;
        const title = vals?.title || "Untitled Session";
        const seq = current.projections?.asOfSeq || 0;

        const info =
          `📊 <b>Session Details</b>\n\n` +
          `📌 <b>Title:</b> ${escapeHtml(title)}\n` +
          `🆔 <code>${sessionId}</code>\n` +
          `🔄 <b>Status:</b> ${current.running ? "⏳ Busy / Running" : "💤 Idle"}\n` +
          `📈 <b>Events Seq:</b> ${seq}\n` +
          `📁 <b>CWD:</b> <code>${escapeHtml(current.cwd || this.config.defaultCwd)}</code>`;

        await ctx.reply(info, { parse_mode: "HTML" });
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
          `🔗 <b>Attached to Web GUI Session</b>\n📌 ${escapeHtml(title)}\n🆔 <code>${active.sessionId}</code>`,
          { parse_mode: "HTML" }
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

        let listText = "🗂 <b>Recent DSH Sessions:</b>\n\n";
        recent.forEach((s, idx) => {
          const isCurrent = s.sessionId === this.currentSessionId;
          const marker = isCurrent ? "👉 " : `${idx + 1}. `;
          const title = s.projections?.values?.title || `Session ${s.sessionId.slice(0, 8)}`;
          listText += `${marker}<b>${escapeHtml(title)}</b>\n<code>${s.sessionId}</code>\n\n`;

          keyboard.text(
            `${isCurrent ? "✅ " : ""}${idx + 1}. ${title.slice(0, 18)}`,
            `switch:${s.sessionId}`
          );
          if ((idx + 1) % 2 === 0) keyboard.row();
        });

        await ctx.reply(listText, {
          parse_mode: "HTML",
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
        `✅ <b>Active Session Switched</b>\n🆔 <code>${targetSessionId}</code>\nSubsequent messages will route here.`,
        { parse_mode: "HTML" }
      );
    });
  }

  private setupMessageHandler() {
    this.bot.on("message:text", async (ctx) => {
      const userText = ctx.message.text.trim();
      console.log(`[Bridge] Received text message: "${userText.slice(0, 50)}" from user ${ctx.from?.id}`);
      if (userText.startsWith("/")) return; // Handled by commands

      const sessionId = await this.resolveSession();

      // Send initial progress message
      const statusMsg = await ctx.reply("⏳ <i>DSH is processing prompt...</i>", {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id }
      });

      let currentHtml = "⏳ <i>DSH is thinking...</i>";
      let lastEditedHtml = currentHtml;
      let lastEditTime = Date.now();
      let completed = false;
      let updateTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const scheduleEdit = (newHtml: string, force = false) => {
        currentHtml = newHtml;
        const now = Date.now();
        const elapsed = now - lastEditTime;

        if (force || elapsed >= 1500) {
          if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
          }
          lastEditTime = now;
          if (newHtml !== lastEditedHtml) {
            lastEditedHtml = newHtml;
            ctx.api
              .editMessageText(ctx.chat.id, statusMsg.message_id, newHtml, {
                parse_mode: "HTML"
              })
              .catch(() => {
                // Fallback to plain text if HTML tags mismatched
                ctx.api
                  .editMessageText(
                    ctx.chat.id,
                    statusMsg.message_id,
                    newHtml.replace(/<[^>]*>/g, "")
                  )
                  .catch(() => {});
              });
          }
        } else if (!updateTimer) {
          updateTimer = setTimeout(() => {
            updateTimer = null;
            scheduleEdit(currentHtml, true);
          }, 1500 - elapsed);
        }
      };

      try {
        // Start streaming events
        unsubscribe = this.dsh.followSession(sessionId, {
          onToolCall: (name, desc) => {
            const shortDesc = desc ? ` <code>${escapeHtml(desc.slice(0, 45))}</code>` : "";
            scheduleEdit(`⚙️ <b>Executing tool:</b> <code>${escapeHtml(name)}</code>${shortDesc}\n⏳ <i>Working...</i>`);
          },
          onToolResult: (name) => {
            scheduleEdit(`✅ <b>Finished tool:</b> <code>${escapeHtml(name)}</code>\n⏳ <i>Analyzing output...</i>`);
          },
          onAssistantMessage: async (text, isFinal) => {
            if (isFinal) {
              completed = true;
              if (updateTimer) clearTimeout(updateTimer);

              const formattedHtml = formatToTelegramHtml(text);
              const chunks = chunkHtmlMessage(formattedHtml);

              for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (i === 0) {
                  try {
                    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, chunk, {
                      parse_mode: "HTML"
                    });
                  } catch (err: any) {
                    console.error("[Edit HTML Error]:", err.message);
                    await ctx.api
                      .editMessageText(ctx.chat.id, statusMsg.message_id, stripHtml(chunk))
                      .catch(() => {});
                  }
                } else {
                  try {
                    await ctx.reply(chunk, { parse_mode: "HTML" });
                  } catch (err: any) {
                    console.error("[Reply HTML Error]:", err.message);
                    await ctx.reply(stripHtml(chunk)).catch(() => {});
                  }
                }
              }

              if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
              }
            } else {
              // Intermediate text preview while tools are running
              scheduleEdit(`💭 <b>Assistant Update:</b>\n\n${escapeHtml(text.slice(-300))}`);
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
            scheduleEdit(`⚠️ <i>Turn timed out after 10m. Check DSH Web GUI for status.</i>`, true);
          }
        }, 600000);
      } catch (err: any) {
        if (unsubscribe) unsubscribe();
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ <b>Error sending prompt to DSH:</b>\n<code>${escapeHtml(err.message)}</code>`,
          { parse_mode: "HTML" }
        );
      }
    });
  }

  public async start() {
    await this.bot.init();
    console.log(`[Bridge] Starting Telegram bot (@${this.bot.botInfo.username})...`);
    await this.bot.start({
      onStart: (info) => {
        console.log(`[Bridge] Connected successfully as @${info.username} (ID: ${info.id})`);
        console.log(`[Bridge] Whitelisted Telegram User: ${this.config.allowedUserId}`);
        console.log(`[Bridge] Target DSH Host: ${this.config.dshAuthority}`);
      }
    });
  }
}
