import { AppConfig } from "../config.js";
export type PromptContentPart = {
    type: "text";
    text: string;
} | {
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
        lastUsed?: {
            provider: string;
            model: string;
            reasoningEffort?: string;
        };
        next?: {
            provider: string;
            model: string;
            reasoningEffort?: string;
        };
    };
    turnOutline?: Array<{
        turn: number;
        label: string;
    }>;
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
export interface CommandExecuteResult {
    commandId: string;
    result?: {
        kind: "success" | "error" | string;
        text: string;
        sourceEventSeq?: number;
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
export declare class DshClient {
    private config;
    private auth;
    constructor(config: AppConfig);
    private rpcCall;
    listSessions(): Promise<SessionItem[]>;
    getActiveSession(): Promise<SessionItem | null>;
    createSession(cwd?: string): Promise<{
        sessionId: string;
    }>;
    sendPrompt(sessionId: string, content: string | PromptContentPart[]): Promise<string>;
    cancelSession(sessionId: string): Promise<boolean>;
    getModelCatalog(): Promise<ModelCatalog>;
    selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<{
        provider: string;
        model: string;
        reasoningEffort?: string;
    }>;
    renameSession(sessionId: string, title: string): Promise<{
        title: string;
        seq: number;
    }>;
    getSessionProjections(sessionId: string): Promise<SessionProjectionsResult | null>;
    executeCommand(sessionId: string, line: string): Promise<CommandExecuteResult>;
    forkSession(sessionId: string, atSeq?: number): Promise<{
        sessionId: string;
    }>;
    followSession(sessionId: string, handlers: StreamEventHandlers): () => void;
}
