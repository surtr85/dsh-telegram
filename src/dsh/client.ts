import WebSocket from "ws";
import crypto from "crypto";
import { DshAuth } from "./auth.js";
import { AppConfig } from "../config.js";

export type PromptContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      data: string;
      name?: string;
    };

export interface ModelEffort {
  id: string;
  name: string;
  description?: string;
}

export interface ModelReasoning {
  efforts: ModelEffort[];
  defaultEffort?: string;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  description?: string;
  reasoning?: ModelReasoning;
}

export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogEntry[];
}

export interface ModelCatalog {
  default: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  routableProviders: string[];
  groups: ModelProviderGroup[];
}

export interface SessionStatsProjection {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

export interface ContextPressureProjection {
  pressureTokens: number;
  projectedTokens: number;
  contextWindow: number;
}

export interface ContextBreakdownProjection {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}

export interface SessionProjectionValues {
  title?: string | null;
  sessionStats?: SessionStatsProjection;
  contextPressure?: ContextPressureProjection;
  contextBreakdown?: ContextBreakdownProjection;
  tokenUsage?: {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  modelSelection?: {
    lastUsed?: { provider: string; model: string; reasoningEffort?: string };
    next?: { provider: string; model: string; reasoningEffort?: string };
  };
  turnOutline?: Array<{ turn: number; label: string }>;
  [key: string]: any;
}

export interface SessionProjectionsResult {
  asOfSeq: number;
  values: SessionProjectionValues;
}

export interface SessionItem {
  sessionId: string;
  updatedAt: number;
  agentAvailable: boolean;
  running: boolean;
  blank: boolean;
  cwd?: string;
  projections?: {
    kind: string;
    asOfSeq: number;
    values?: SessionProjectionValues;
  };
}

export interface StreamEventHandlers {
  onAssistantTextChunk?: (chunk: string) => void;
  onAssistantMessage?: (text: string, isFinal: boolean) => void;
  onToolCall?: (name: string, description?: string) => void;
  onToolResult?: (name: string) => void;
  onStepEnd?: () => void;
  onTurnComplete?: (finalText: string) => void;
  onError?: (error: Error) => void;
}

export class DshClient {
  private config: AppConfig;
  private auth: DshAuth;

  constructor(config: AppConfig) {
    this.config = config;
    this.auth = new DshAuth(config.credentialsPath, config.dshAuthority);
  }

  private async rpcCall<T>(method: string, args: Record<string, any>): Promise<T> {
    const cookie = this.auth.getCookie();
    const rpcId = crypto.randomUUID();

    const response = await fetch(`${this.config.dshBaseUrl}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload: { args }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DSH RPC error (${response.status} ${response.statusText}): ${errText}`);
    }

    const data = await response.json();
    if (!data.result || data.result.ok === false) {
      const err = data.result?.error || data.error;
      throw new Error(`DSH RPC failed for ${method}: ${err?.message || JSON.stringify(err)}`);
    }

    return data.result.value as T;
  }

  public async listSessions(): Promise<SessionItem[]> {
    const res = await this.rpcCall<{ items: SessionItem[] }>("session/list", {
      _request: {}
    });
    return res.items || [];
  }

  public async getActiveSession(): Promise<SessionItem | null> {
    const items = await this.listSessions();
    if (items.length === 0) return null;

    // 1. Look for currently running session
    const running = items.find((i) => i.running);
    if (running) return running;

    // 2. Otherwise sort by updatedAt descending and return latest non-blank
    const nonBlank = items.filter((i) => !i.blank);
    if (nonBlank.length > 0) {
      nonBlank.sort((a, b) => b.updatedAt - a.updatedAt);
      return nonBlank[0];
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items[0];
  }

  public async createSession(cwd?: string): Promise<{ sessionId: string }> {
    const res = await this.rpcCall<{ sessionId: string }>("session/create", {
      request: {
        cwd: cwd || this.config.defaultCwd,
        agentPreset: "standard"
      }
    });
    return res;
  }

  public async sendPrompt(sessionId: string, content: string | PromptContentPart[]): Promise<string> {
    const requestId = crypto.randomUUID();
    const contentParts: PromptContentPart[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;

    await this.rpcCall<{ accepted: boolean }>("session/prompt", {
      request: {
        requestId,
        sessionId,
        mode: "queue",
        content: contentParts,
        clientTimeZone: "Asia/Tehran"
      }
    });
    return requestId;
  }

  public async cancelSession(sessionId: string): Promise<boolean> {
    const res = await this.rpcCall<{ accepted: boolean }>("session/cancel", {
      request: {
        sessionId
      }
    });
    return res.accepted ?? true;
  }

  public async getModelCatalog(): Promise<ModelCatalog> {
    return await this.rpcCall<ModelCatalog>("session/modelCatalog", {});
  }

  public async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string
  ): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const res = await this.rpcCall<{ selected: { provider: string; model: string; reasoningEffort?: string } }>(
      "session/selectModel",
      {
        request: {
          sessionId,
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {})
        }
      }
    );
    return res.selected;
  }

  public async renameSession(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    return await this.rpcCall<{ title: string; seq: number }>("session/rename", {
      request: {
        sessionId,
        title
      }
    });
  }

  public async getSessionProjections(sessionId: string): Promise<SessionProjectionsResult | null> {
    return await this.rpcCall<SessionProjectionsResult | null>("session/projections", {
      request: {
        sessionId
      }
    });
  }

  public async forkSession(sessionId: string, atSeq?: number): Promise<{ sessionId: string }> {
    return await this.rpcCall<{ sessionId: string }>("session/fork", {
      request: {
        sessionId,
        ...(typeof atSeq === "number" ? { atSeq } : {})
      }
    });
  }

  public followSession(sessionId: string, handlers: StreamEventHandlers): () => void {
    const cookie = this.auth.getCookie();
    const ws = new WebSocket(`${this.config.dshWsUrl}/api/remote.mux`, {
      headers: { Cookie: cookie }
    });

    const streamId = "stream-" + crypto.randomUUID().slice(0, 8);
    let isClosed = false;
    let accumulatedText = "";
    let inProgressTool: string | null = null;

    ws.on("open", () => {
      if (isClosed) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          type: "open",
          streamId,
          endpoint: "session/follow",
          payload: {
            args: {
              request: {
                address: { kind: "session", sessionId },
                assistantStream: true
              }
            }
          }
        })
      );
    });

    ws.on("message", (raw) => {
      if (isClosed) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "item" || !msg.value) return;

        const val = msg.value;

        // 1. Assistant live streaming chunk
        if (val.type === "assistant-stream" && val.frame) {
          const frame = val.frame;
          if (frame.type === "chunk" && frame.chunk) {
            // Check if chunk has text
            let chunkText = "";
            if (typeof frame.chunk === "string") {
              chunkText = frame.chunk;
            } else if (frame.chunk.text) {
              chunkText = frame.chunk.text;
            } else if (frame.chunk.delta?.content) {
              chunkText = frame.chunk.delta.content;
            } else if (frame.chunk.content && typeof frame.chunk.content === "string") {
              chunkText = frame.chunk.content;
            }

            if (chunkText) {
              accumulatedText += chunkText;
              handlers.onAssistantTextChunk?.(chunkText);
            }
          }
        }

        // 2. Durable journal events
        if (val.type === "event" && val.event) {
          const evt = val.event;

          if (evt.type === "tool/call" && evt.data) {
            inProgressTool = evt.data.name;
            let desc: string | undefined;
            if (typeof evt.data.arguments === "string") {
              try {
                const parsed = JSON.parse(evt.data.arguments);
                desc = parsed.description || parsed.command || parsed.path || parsed.query;
              } catch {
                desc = evt.data.arguments;
              }
            } else if (typeof evt.data.arguments === "object" && evt.data.arguments !== null) {
              desc = evt.data.arguments.description || evt.data.arguments.command;
            }
            handlers.onToolCall?.(evt.data.name, desc);
          }

          if (evt.type === "tool/result" && evt.data) {
            handlers.onToolResult?.(evt.data.name || inProgressTool || "tool");
            inProgressTool = null;
          }

          if (evt.type === "step/end") {
            handlers.onStepEnd?.();
          }

          if (evt.type === "assistant/message" && evt.data?.message) {
            const content = evt.data.message.content;
            if (Array.isArray(content)) {
              let msgText = "";
              let hasTool = false;
              for (const part of content) {
                if (part.type === "text" && part.text) {
                  msgText += part.text;
                }
                if (part.type === "tool-call") {
                  hasTool = true;
                }
              }

              if (msgText) {
                accumulatedText = msgText;
                handlers.onAssistantMessage?.(msgText, !hasTool);
              }

              // If there are no tool calls in this assistant message, this is the final user response
              if (!hasTool && msgText) {
                handlers.onTurnComplete?.(msgText);
              }
            }
          }
        }
      } catch (err: any) {
        handlers.onError?.(err);
      }
    });

    ws.on("error", (err) => {
      if (!isClosed) {
        handlers.onError?.(err);
      }
    });

    return () => {
      isClosed = true;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "cancel", streamId }));
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
    };
  }
}
