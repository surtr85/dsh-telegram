import fs from "fs";
import path from "path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { AppConfig } from "../config.js";
import { DshClient, PromptContentPart } from "../dsh/client.js";
import {
  formatToTelegramHtml,
  stripHtml,
  chunkHtmlMessage,
  extractImages
} from "./formatter.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface MediaGroupItem {
  type: "photo" | "document";
  fileId: string;
  fileUniqueId: string;
  mimeType: string;
  fileName?: string;
}

interface MediaGroupBuffer {
  mediaGroupId: string;
  ctx: any;
  sessionId: string;
  items: MediaGroupItem[];
  caption?: string;
  statusMsg?: any;
  timer: NodeJS.Timeout;
}

export class TelegramBridge {
  private bot: Bot;
  private config: AppConfig;
  private dsh: DshClient;
  private currentSessionId: string | null = null;
  private sessionStateFile: string;
  private mediaGroupBuffers = new Map<string, MediaGroupBuffer>();
  private sessionLocks = new Map<string, Promise<void>>();

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
          `<b>Commands & Capabilities:</b>\n` +
          `• 💬 Send any text, photo, or screenshot with caption.\n` +
          `• 🖼 Receive rich posts with images, code blocks, and formatting.\n` +
          `• <code>/new</code> - Start a brand new session.\n` +
          `• <code>/session</code> - Show details & token metrics for this session.\n` +
          `• <code>/sessions</code> - Browse & switch between recent sessions.\n` +
          `• <code>/attach</code> - Re-attach to newest active Web GUI session.`;

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
          await ctx.reply(`Session <code>${sessionId}</code> not found in DSH catalog.`, {
            parse_mode: "HTML"
          });
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
      await ctx.answerCallbackQuery({
        text: `Switched to session ${targetSessionId.slice(0, 8)}`
      });
      await ctx.editMessageText(
        `✅ <b>Active Session Switched</b>\n🆔 <code>${targetSessionId}</code>\nSubsequent messages will route here.`,
        { parse_mode: "HTML" }
      );
    });
  }

  private async enqueueSessionTurn(sessionId: string, fn: () => Promise<void>) {
    const prev = this.sessionLocks.get(sessionId) || Promise.resolve();
    const next = (async () => {
      try {
        await prev;
      } catch {}
      await fn();
    })();
    this.sessionLocks.set(sessionId, next);
    return next;
  }

  private setupMessageHandler() {
    this.bot.on(["message:text", "message:photo", "message:document"], async (ctx) => {
      if (ctx.message.text?.startsWith("/") || ctx.message.caption?.startsWith("/")) return;

      const sessionId = await this.resolveSession();

      // 0. Media Group (Album) handling
      const mediaGroupId = ctx.message.media_group_id;
      if (
        mediaGroupId &&
        (ctx.message.photo || (ctx.message.document && ctx.message.document.mime_type?.startsWith("image/")))
      ) {
        let item: MediaGroupItem | null = null;
        if (ctx.message.photo) {
          const photos = ctx.message.photo;
          const bestPhoto = photos[photos.length - 1];
          item = {
            type: "photo",
            fileId: bestPhoto.file_id,
            fileUniqueId: bestPhoto.file_unique_id,
            mimeType: "image/jpeg"
          };
        } else if (ctx.message.document) {
          const doc = ctx.message.document;
          item = {
            type: "document",
            fileId: doc.file_id,
            fileUniqueId: doc.file_unique_id,
            mimeType: doc.mime_type || "image/jpeg",
            fileName: doc.file_name
          };
        }

        let buffer = this.mediaGroupBuffers.get(mediaGroupId);
        if (buffer) {
          if (item) buffer.items.push(item);
          if (ctx.message.caption?.trim() && !buffer.caption) {
            buffer.caption = ctx.message.caption.trim();
          }
          clearTimeout(buffer.timer);
          buffer.timer = setTimeout(() => this.processMediaGroup(mediaGroupId), 1000);
        } else {
          const statusMsg = await ctx.reply(
            "⏳ <i>در حال دریافت آلبوم تصاویر...</i>",
            {
              parse_mode: "HTML",
              reply_parameters: { message_id: ctx.message.message_id }
            }
          );

          buffer = {
            mediaGroupId,
            ctx,
            sessionId,
            items: item ? [item] : [],
            caption: ctx.message.caption?.trim(),
            statusMsg,
            timer: setTimeout(() => this.processMediaGroup(mediaGroupId), 1000)
          };
          this.mediaGroupBuffers.set(mediaGroupId, buffer);
        }
        return;
      }

      // 1. Photo with optional caption
      if (ctx.message.photo) {
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];
        const caption =
          ctx.message.caption?.trim() || "تصویر ارسالی از تلگرام. لطفاً بررسی و تحلیل کنید.";

        console.log(
          `[Bridge] Received photo from user ${ctx.from?.id} (caption: "${caption.slice(0, 40)}")`
        );
        const statusMsg = await ctx.reply(
          "⏳ <i>در حال دریافت و ارسال تصویر به مدل هوش مصنوعی...</i>",
          {
            parse_mode: "HTML",
            reply_parameters: { message_id: ctx.message.message_id }
          }
        );

        try {
          const file = await ctx.api.getFile(bestPhoto.file_id);
          if (!file.file_path) throw new Error("Could not retrieve file path from Telegram");
          const fileUrl = `https://api.telegram.org/file/bot${this.config.telegramToken}/${file.file_path}`;
          const res = await fetch(fileUrl);
          if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
          const arrayBuffer = await res.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");

          const promptContent: PromptContentPart[] = [
            {
              type: "image",
              mediaType: "image/jpeg",
              data: base64,
              name: `telegram_${bestPhoto.file_unique_id}.jpg`
            },
            {
              type: "text",
              text: caption
            }
          ];

          await this.enqueueSessionTurn(sessionId, () =>
            this.handleSessionTurn(ctx, sessionId, promptContent, statusMsg)
          );
        } catch (err: any) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ <b>خطا در دریافت تصویر:</b> <code>${escapeHtml(err.message)}</code>`,
            { parse_mode: "HTML" }
          );
        }
        return;
      }

      // 2. Uncompressed image document with optional caption
      if (ctx.message.document && ctx.message.document.mime_type?.startsWith("image/")) {
        const doc = ctx.message.document;
        const caption =
          ctx.message.caption?.trim() || "تصویر ارسالی از تلگرام. لطفاً بررسی و تحلیل کنید.";

        console.log(
          `[Bridge] Received image document from user ${ctx.from?.id} (name: ${doc.file_name})`
        );
        const statusMsg = await ctx.reply("⏳ <i>در حال دریافت فایل تصویر در DSH...</i>", {
          parse_mode: "HTML",
          reply_parameters: { message_id: ctx.message.message_id }
        });

        try {
          const file = await ctx.api.getFile(doc.file_id);
          if (!file.file_path) throw new Error("Could not retrieve file path from Telegram");
          const fileUrl = `https://api.telegram.org/file/bot${this.config.telegramToken}/${file.file_path}`;
          const res = await fetch(fileUrl);
          if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
          const arrayBuffer = await res.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");

          let mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" = "image/png";
          if (doc.mime_type === "image/jpeg") mediaType = "image/jpeg";
          else if (doc.mime_type === "image/webp") mediaType = "image/webp";
          else if (doc.mime_type === "image/gif") mediaType = "image/gif";

          const promptContent: PromptContentPart[] = [
            {
              type: "image",
              mediaType,
              data: base64,
              name: doc.file_name || `telegram_${doc.file_unique_id}.png`
            },
            {
              type: "text",
              text: caption
            }
          ];

          await this.enqueueSessionTurn(sessionId, () =>
            this.handleSessionTurn(ctx, sessionId, promptContent, statusMsg)
          );
        } catch (err: any) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ <b>خطا در دریافت فایل تصویر:</b> <code>${escapeHtml(err.message)}</code>`,
            { parse_mode: "HTML" }
          );
        }
        return;
      }

      // 3. Plain text message
      if (ctx.message.text) {
        const userText = ctx.message.text.trim();
        console.log(
          `[Bridge] Received text message: "${userText.slice(0, 50)}" from user ${ctx.from?.id}`
        );
        const statusMsg = await ctx.reply("⏳ <i>DSH is processing prompt...</i>", {
          parse_mode: "HTML",
          reply_parameters: { message_id: ctx.message.message_id }
        });

        await this.enqueueSessionTurn(sessionId, () =>
          this.handleSessionTurn(ctx, sessionId, userText, statusMsg)
        );
        return;
      }
    });
  }

  private async processMediaGroup(mediaGroupId: string) {
    const buffer = this.mediaGroupBuffers.get(mediaGroupId);
    if (!buffer) return;
    this.mediaGroupBuffers.delete(mediaGroupId);

    const { ctx, sessionId, items, caption, statusMsg } = buffer;
    const finalCaption = caption || "تصاویر ارسالی از تلگرام. لطفاً بررسی و تحلیل کنید.";

    console.log(
      `[Bridge] Processing media group ${mediaGroupId} with ${items.length} items (caption: "${finalCaption.slice(0, 40)}")`
    );

    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `⏳ <i>در حال دانلود ${items.length} تصویر و ارسال به مدل هوش مصنوعی...</i>`,
        { parse_mode: "HTML" }
      );

      const downloadedParts: PromptContentPart[] = await Promise.all(
        items.map(async (item, idx) => {
          const file = await ctx.api.getFile(item.fileId);
          if (!file.file_path) throw new Error(`Could not retrieve file path for image ${idx + 1}`);
          const fileUrl = `https://api.telegram.org/file/bot${this.config.telegramToken}/${file.file_path}`;
          const res = await fetch(fileUrl);
          if (!res.ok) throw new Error(`Download failed for image ${idx + 1}: ${res.statusText}`);
          const arrayBuffer = await res.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");
          const ext = item.mimeType === "image/png" ? "png" : "jpg";
          const name = item.fileName || `telegram_${item.fileUniqueId}.${ext}`;

          let mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" = "image/jpeg";
          if (item.mimeType === "image/png") mediaType = "image/png";
          else if (item.mimeType === "image/webp") mediaType = "image/webp";
          else if (item.mimeType === "image/gif") mediaType = "image/gif";

          return {
            type: "image" as const,
            mediaType,
            data: base64,
            name
          };
        })
      );

      const promptContent: PromptContentPart[] = [
        ...downloadedParts,
        {
          type: "text",
          text: finalCaption
        }
      ];

      await this.enqueueSessionTurn(sessionId, () =>
        this.handleSessionTurn(ctx, sessionId, promptContent, statusMsg)
      );
    } catch (err: any) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ <b>خطا در دریافت آلبوم تصاویر:</b> <code>${escapeHtml(err.message)}</code>`,
        { parse_mode: "HTML" }
      );
    }
  }

  private handleSessionTurn(
    ctx: any,
    sessionId: string,
    promptContent: string | PromptContentPart[],
    statusMsg: any
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let currentHtml = "⏳ <i>DSH is thinking...</i>";
      let lastEditedHtml = currentHtml;
      let lastEditTime = Date.now();
      let completed = false;
      let updateTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const finish = () => {
        if (completed) return;
        completed = true;
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        resolve();
      };

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
        unsubscribe = this.dsh.followSession(sessionId, {
          onToolCall: (name, desc) => {
            const shortDesc = desc ? ` <code>${escapeHtml(desc.slice(0, 45))}</code>` : "";
            scheduleEdit(
              `⚙️ <b>Executing tool:</b> <code>${escapeHtml(name)}</code>${shortDesc}\n⏳ <i>Working...</i>`
            );
          },
          onToolResult: (name) => {
            scheduleEdit(
              `✅ <b>Finished tool:</b> <code>${escapeHtml(name)}</code>\n⏳ <i>Analyzing output...</i>`
            );
          },
          onAssistantMessage: async (text, isFinal) => {
            if (isFinal) {
              await this.deliverAssistantResponse(ctx, statusMsg, text);
              finish();
            } else {
              const preview = formatToTelegramHtml(text.slice(-300));
              scheduleEdit(`💭 <b>Assistant Update:</b>\n\n${preview}`);
            }
          },
          onError: (err) => {
            console.error(`[Follow Stream Error]:`, err.message);
          }
        });

        this.dsh.sendPrompt(sessionId, promptContent).catch((err) => {
          scheduleEdit(
            `❌ <b>Error submitting prompt:</b> <code>${escapeHtml(err.message)}</code>`,
            true
          );
          finish();
        });

        // Safety timeout after 10 minutes
        setTimeout(() => {
          if (!completed) {
            scheduleEdit(`⚠️ <i>Turn timed out after 10m. Check DSH Web GUI for status.</i>`, true);
            finish();
          }
        }, 600000);
      } catch (err: any) {
        scheduleEdit(
          `❌ <b>Error communicating with DSH:</b>\n<code>${escapeHtml(err.message)}</code>`,
          true
        );
        finish();
      }
    });
  }

  /**
   * Intelligently delivers the assistant response.
   * If markdown images are detected, sends them as rich Telegram photos with caption and post text!
   */
  private async deliverAssistantResponse(ctx: any, statusMsg: any, rawText: string) {
    const { textWithoutImages, images } = extractImages(rawText);

    // Case 1: Pure text post without images
    if (images.length === 0) {
      const formattedHtml = formatToTelegramHtml(rawText);
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
      return;
    }

    // Case 2: Response contains image(s) -> Deliver rich media post or cohesive album!
    try {
      const formattedText = formatToTelegramHtml(textWithoutImages).trim();
      const fitsCaption = formattedText.length > 0 && formattedText.length <= 1024;

      const photoInputs: Array<{ input: string | InputFile; alt?: string }> = [];
      for (const img of images) {
        let photoInput: string | InputFile | null = null;

        if (img.source.startsWith("http://") || img.source.startsWith("https://")) {
          photoInput = img.source;
        } else {
          let resolved = img.source;
          if (!path.isAbsolute(resolved)) {
            resolved = path.resolve(this.config.defaultCwd, resolved);
          }
          if (fs.existsSync(resolved)) {
            photoInput = new InputFile(resolved);
          }
        }

        if (photoInput) {
          photoInputs.push({ input: photoInput, alt: img.alt });
        }
      }

      if (photoInputs.length === 0) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, formattedText, {
          parse_mode: "HTML"
        });
        return;
      }

      // Subcase 2A: Single Image
      if (photoInputs.length === 1) {
        const single = photoInputs[0];
        if (fitsCaption) {
          await ctx.replyWithPhoto(single.input, {
            caption: formattedText,
            parse_mode: "HTML"
          });
        } else {
          await ctx.replyWithPhoto(single.input, {
            caption: single.alt ? `🖼 <b>${escapeHtml(single.alt)}</b>` : undefined,
            parse_mode: "HTML"
          });
          if (formattedText.length > 0) {
            const chunks = chunkHtmlMessage(formattedText);
            for (const chunk of chunks) {
              await ctx.reply(chunk, { parse_mode: "HTML" });
            }
          }
        }
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        return;
      }

      // Subcase 2B: Multiple Images -> True Telegram MediaGroup Album!
      const mediaGroup = photoInputs.map((item, idx) => ({
        type: "photo" as const,
        media: item.input,
        caption: idx === 0 && fitsCaption ? formattedText : undefined,
        parse_mode: idx === 0 && fitsCaption ? ("HTML" as const) : undefined
      }));

      await ctx.api.sendMediaGroup(ctx.chat.id, mediaGroup);

      // If text exceeds 1024 chars, deliver as subsequent text message
      if (!fitsCaption && formattedText.length > 0) {
        const chunks = chunkHtmlMessage(formattedText);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        }
      }

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (err: any) {
      console.error("[Media Delivery Error]:", err.message);
      const formattedHtml = formatToTelegramHtml(rawText);
      await ctx.api
        .editMessageText(ctx.chat.id, statusMsg.message_id, stripHtml(formattedHtml))
        .catch(() => {});
    }
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
