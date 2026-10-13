import WebSocket from "ws";
import crypto from "crypto";
import { DshAuth } from "./auth.js";
export class DshClient {
    config;
    auth;
    constructor(config) {
        this.config = config;
        this.auth = new DshAuth(config.credentialsPath, config.dshAuthority);
    }
    async rpcCall(method, args) {
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
        return data.result.value;
    }
    async listSessions() {
        const res = await this.rpcCall("session/list", {
            _request: {}
        });
        return res.items || [];
    }
    async getActiveSession() {
        const items = await this.listSessions();
        if (items.length === 0)
            return null;
        // 1. Look for currently running session
        const running = items.find((i) => i.running);
        if (running)
            return running;
        // 2. Otherwise sort by updatedAt descending and return latest non-blank
        const nonBlank = items.filter((i) => !i.blank);
        if (nonBlank.length > 0) {
            nonBlank.sort((a, b) => b.updatedAt - a.updatedAt);
            return nonBlank[0];
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return items[0];
    }
    async createSession(cwd) {
        const res = await this.rpcCall("session/create", {
            request: {
                cwd: cwd || this.config.defaultCwd,
                agentPreset: "standard"
            }
        });
        return res;
    }
    async sendPrompt(sessionId, content) {
        const requestId = crypto.randomUUID();
        const contentParts = typeof content === "string" ? [{ type: "text", text: content }] : content;
        await this.rpcCall("session/prompt", {
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
    async cancelSession(sessionId) {
        const res = await this.rpcCall("session/cancel", {
            request: {
                sessionId
            }
        });
        return res.accepted ?? true;
    }
    async getModelCatalog() {
        return await this.rpcCall("session/modelCatalog", {});
    }
    async selectModel(sessionId, provider, model, reasoningEffort) {
        const res = await this.rpcCall("session/selectModel", {
            request: {
                sessionId,
                provider,
                model,
                ...(reasoningEffort ? { reasoningEffort } : {})
            }
        });
        return res.selected;
    }
    async renameSession(sessionId, title) {
        return await this.rpcCall("session/rename", {
            request: {
                sessionId,
                title
            }
        });
    }
    async getSessionProjections(sessionId) {
        return await this.rpcCall("session/projections", {
            request: {
                sessionId
            }
        });
    }
    async executeCommand(sessionId, line) {
        return await this.rpcCall("commands/execute", {
            agentId: sessionId,
            line,
            submittedAttachments: []
        });
    }
    async forkSession(sessionId, atSeq) {
        return await this.rpcCall("session/fork", {
            request: {
                sessionId,
                ...(typeof atSeq === "number" ? { atSeq } : {})
            }
        });
    }
    followSession(sessionId, handlers) {
        const cookie = this.auth.getCookie();
        const ws = new WebSocket(`${this.config.dshWsUrl}/api/remote.mux`, {
            headers: { Cookie: cookie }
        });
        const streamId = "stream-" + crypto.randomUUID().slice(0, 8);
        let isClosed = false;
        let accumulatedText = "";
        let inProgressTool = null;
        ws.on("open", () => {
            if (isClosed) {
                ws.close();
                return;
            }
            ws.send(JSON.stringify({
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
            }));
        });
        ws.on("message", (raw) => {
            if (isClosed)
                return;
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type !== "item" || !msg.value)
                    return;
                const val = msg.value;
                // 1. Assistant live streaming chunk
                if (val.type === "assistant-stream" && val.frame) {
                    const frame = val.frame;
                    if (frame.type === "chunk" && frame.chunk) {
                        // Check if chunk has text
                        let chunkText = "";
                        if (typeof frame.chunk === "string") {
                            chunkText = frame.chunk;
                        }
                        else if (frame.chunk.text) {
                            chunkText = frame.chunk.text;
                        }
                        else if (frame.chunk.delta?.content) {
                            chunkText = frame.chunk.delta.content;
                        }
                        else if (frame.chunk.content && typeof frame.chunk.content === "string") {
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
                        let desc;
                        if (typeof evt.data.arguments === "string") {
                            try {
                                const parsed = JSON.parse(evt.data.arguments);
                                desc = parsed.description || parsed.command || parsed.path || parsed.query;
                            }
                            catch {
                                desc = evt.data.arguments;
                            }
                        }
                        else if (typeof evt.data.arguments === "object" && evt.data.arguments !== null) {
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
            }
            catch (err) {
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
                }
                else if (ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            }
            catch {
                // ignore
            }
        };
    }
}
