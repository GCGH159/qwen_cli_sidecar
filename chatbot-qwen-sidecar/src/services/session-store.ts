import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type {
  LiveSessionEvent,
  PendingRequest,
  PendingResolver,
  RecentEvent,
  SessionRecord,
  SidecarResponse,
  SidecarStatus,
} from "../types.js";

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

type SessionWaiter = {
  predicate: (session: SessionRecord) => boolean;
  resolve: (session: SessionRecord) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

type SessionSubscriber = (event: LiveSessionEvent) => void;

interface PersistedSessionRecord {
  goSessionId: string;
  sidecarSessionId: string;
  userId: string;
  projectId: string;
  workspaceDir: string;
  sdkSessionId: string;
  shouldResume: boolean;
  activeRunId?: string;
  lastStatus: SidecarStatus;
  lastStatusText: string;
  lastOutput: string;
  lastThinking: string;
  recentEvents: RecentEvent[];
  eventVersion: number;
  updatedAt: number;
  pendingRequest?: PendingRequest;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly waiters = new Map<string, Set<SessionWaiter>>();
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();
  private readonly storeDir: string;
  private readonly recentEventsLimit: number;

  constructor(recentEventsLimit = 20, storeDir?: string) {
    this.recentEventsLimit = recentEventsLimit;
    this.storeDir = storeDir || join(homedir(), ".qwen", "sidecar-sessions");
    void this.initStore();
  }

  private async initStore(): Promise<void> {
    try {
      await mkdir(this.storeDir, { recursive: true });
      await this.loadSessions();
    } catch (err) {
      console.error("Failed to initialize session store:", err);
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      const files = await readdir(this.storeDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await readFile(join(this.storeDir, file), "utf-8");
          const persisted: PersistedSessionRecord = JSON.parse(content);
          const session: SessionRecord = {
            ...persisted,
            pendingResolvers: new Map<string, PendingResolver>(),
            currentQuery: undefined,
          };
          this.sessions.set(session.goSessionId, session);
        } catch {
          console.warn(`Failed to load session file: ${file}`);
        }
      }
    } catch {
      // 目录不存在或为空，第一次运行
    }
  }

  private getSessionFilePath(sessionId: string): string {
    return join(this.storeDir, `${sessionId}.json`);
  }

  private async saveSession(session: SessionRecord): Promise<void> {
    try {
      const persisted: PersistedSessionRecord = {
        goSessionId: session.goSessionId,
        sidecarSessionId: session.sidecarSessionId,
        userId: session.userId,
        projectId: session.projectId,
        workspaceDir: session.workspaceDir,
        sdkSessionId: session.sdkSessionId,
        shouldResume: session.shouldResume,
        activeRunId: session.activeRunId,
        lastStatus: session.lastStatus,
        lastStatusText: session.lastStatusText,
        lastOutput: session.lastOutput,
        lastThinking: session.lastThinking,
        recentEvents: session.recentEvents,
        eventVersion: session.eventVersion,
        updatedAt: session.updatedAt,
        pendingRequest: session.pendingRequest,
      };
      await writeFile(this.getSessionFilePath(session.goSessionId), JSON.stringify(persisted, null, 2), "utf-8");
    } catch (err) {
      console.error(`Failed to save session ${session.goSessionId}:`, err);
    }
  }

  private async deleteSessionFile(sessionId: string): Promise<void> {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.getSessionFilePath(sessionId));
    } catch {
      // 文件不存在，忽略
    }
  }

  ensureSession(userId: string, goSessionId: string, projectId: string, statusText?: string, workspaceDir?: string): SessionRecord {
    const existing = this.sessions.get(goSessionId);
    if (existing) {
      if (existing.projectId === projectId) {
        return existing;
      }
      existing.pendingResolvers.clear();
      const merged: SessionRecord = {
        ...existing,
        userId,
        projectId,
        workspaceDir: workspaceDir || existing.workspaceDir,
        sdkSessionId: randomUUID(),
        shouldResume: false,
        activeRunId: undefined,
        currentQuery: undefined,
        pendingRequest: undefined,
        lastStatus: "idle",
        lastStatusText: normalizeStatusText(statusText, `已切换项目：${projectId}`),
        lastOutput: "",
        lastThinking: "",
        recentEvents: [this.createRecentEvent("project.switched", normalizeStatusText(statusText, `已切换项目：${projectId}`))],
        eventVersion: existing.eventVersion + 1,
        updatedAt: nowUnix(),
        pendingResolvers: existing.pendingResolvers,
      };
      this.sessions.set(goSessionId, merged);
      this.notifyWaiters(merged);
      this.notifySubscribers(merged);
      void this.saveSession(merged);
      return merged;
    }
    const created: SessionRecord = {
      goSessionId,
      sidecarSessionId: goSessionId,
      userId,
      projectId,
      workspaceDir: workspaceDir || "",
      sdkSessionId: randomUUID(),
      shouldResume: false,
      lastStatus: "idle",
      lastStatusText: "Claude 模式已开启",
      lastOutput: "",
      lastThinking: "",
      recentEvents: [this.createRecentEvent("session.created", "Claude 模式已开启")],
      eventVersion: 1,
      updatedAt: nowUnix(),
      pendingResolvers: new Map<string, PendingResolver>(),
    };
    this.sessions.set(goSessionId, created);
    this.notifyWaiters(created);
    this.notifySubscribers(created);
    void this.saveSession(created);
    return created;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    // 先尝试用 goSessionId 查找
    const session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }
    // 如果找不到，尝试用 sidecarSessionId 或 sdkSessionId 查找
    for (const s of this.sessions.values()) {
      if (s.sidecarSessionId === sessionId || s.sdkSessionId === sessionId) {
        return s;
      }
    }
    return undefined;
  }

  requireSession(sessionId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("Claude 会话不存在或已过期");
    }
    return session;
  }

  /**
   * 获取所有会话列表
   */
  getAllSessions(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  updateSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord {
    const session = this.requireSession(sessionId);
    const merged: SessionRecord = {
      ...session,
      ...patch,
      shouldResume: patch.shouldResume ?? session.shouldResume,
      recentEvents: patch.recentEvents ?? session.recentEvents,
      eventVersion: patch.eventVersion ?? session.eventVersion + 1,
      pendingResolvers: patch.pendingResolvers ?? session.pendingResolvers,
      updatedAt: nowUnix(),
    };
    this.sessions.set(sessionId, merged);
    this.notifyWaiters(merged);
    this.notifySubscribers(merged);
    void this.saveSession(merged);
    return merged;
  }

  attachSdkSession(sessionId: string, sdkSessionId: string, projectId: string, statusText: string, workspaceDir?: string): SessionRecord {
    const session = this.requireSession(sessionId);
    session.pendingResolvers.clear();
    const recentEvents: RecentEvent[] = [];
    if (session.projectId !== projectId) {
      recentEvents.push(this.createRecentEvent("project.switched", `已切换项目：${projectId}`));
    }
    recentEvents.push(this.createRecentEvent("session.attached", statusText));
    const merged: SessionRecord = {
      ...session,
      projectId,
      workspaceDir: workspaceDir || session.workspaceDir,
      sdkSessionId,
      shouldResume: true,
      activeRunId: undefined,
      currentQuery: undefined,
      pendingRequest: undefined,
      lastStatus: "idle",
      lastStatusText: statusText,
      lastOutput: "",
      lastThinking: "",
      recentEvents,
      eventVersion: session.eventVersion + 1,
      updatedAt: nowUnix(),
      pendingResolvers: session.pendingResolvers,
    };
    this.sessions.set(sessionId, merged);
    this.notifyWaiters(merged);
    this.notifySubscribers(merged);
    void this.saveSession(merged);
    return merged;
  }

  appendRecentEvent(sessionId: string, type: string, text: string): SessionRecord {
    const session = this.requireSession(sessionId);
    const normalized = text.trim();
    if (!normalized) {
      return session;
    }
    return this.updateSession(sessionId, {
      recentEvents: this.trimRecentEvents([...session.recentEvents, this.createRecentEvent(type, normalized)]),
    });
  }

  setPendingRequest(sessionId: string, pendingRequest: PendingRequest | undefined): SessionRecord {
    return this.updateSession(sessionId, {
      pendingRequest,
      lastStatus: pendingRequest ? pendingStatus(pendingRequest.kind) : "idle",
      lastStatusText: pendingRequest?.prompt?.trim() || (pendingRequest ? "等待用户输入" : "空闲"),
    });
  }

  registerPendingResolver(sessionId: string, requestId: string, resolver: PendingResolver): SessionRecord {
    const session = this.requireSession(sessionId);
    session.pendingResolvers.set(requestId, resolver);
    session.eventVersion += 1;
    session.updatedAt = nowUnix();
    this.sessions.set(sessionId, session);
    this.notifyWaiters(session);
    this.notifySubscribers(session);
    void this.saveSession(session);
    return session;
  }

  consumePendingResolver(sessionId: string, requestId: string): PendingResolver | undefined {
    const session = this.requireSession(sessionId);
    const resolver = session.pendingResolvers.get(requestId);
    if (!resolver) {
      return undefined;
    }
    session.pendingResolvers.delete(requestId);
    session.eventVersion += 1;
    session.updatedAt = nowUnix();
    this.sessions.set(sessionId, session);
    this.notifyWaiters(session);
    this.notifySubscribers(session);
    void this.saveSession(session);
    return resolver;
  }

  clearPending(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    session.pendingRequest = undefined;
    session.lastStatus = session.currentQuery ? "running" : "idle";
    session.lastStatusText = session.currentQuery ? "Claude 正在继续执行" : "空闲";
    session.eventVersion += 1;
    session.updatedAt = nowUnix();
    session.pendingResolvers.clear();
    this.sessions.set(sessionId, session);
    this.notifyWaiters(session);
    this.notifySubscribers(session);
    void this.saveSession(session);
    return session;
  }

  rejectPendingResolvers(sessionId: string, error: Error): SessionRecord {
    const session = this.requireSession(sessionId);
    for (const resolver of session.pendingResolvers.values()) {
      resolver.reject(error);
    }
    session.pendingResolvers.clear();
    session.pendingRequest = undefined;
    session.eventVersion += 1;
    session.updatedAt = nowUnix();
    this.sessions.set(sessionId, session);
    this.notifyWaiters(session);
    this.notifySubscribers(session);
    void this.saveSession(session);
    return session;
  }

  setLiveQuery(sessionId: string, currentQuery: SessionRecord["currentQuery"]): SessionRecord {
    return this.updateSession(sessionId, { currentQuery });
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const bucket = this.subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    bucket.add(subscriber);
    this.subscribers.set(sessionId, bucket);
    return () => {
      const current = this.subscribers.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  waitForUpdate(
    sessionId: string,
    predicate: (session: SessionRecord) => boolean,
    timeoutMs = 0,
  ): Promise<SessionRecord> {
    const current = this.requireSession(sessionId);
    if (predicate(current)) {
      return Promise.resolve(current);
    }
    return new Promise<SessionRecord>((resolve, reject) => {
      const waiter: SessionWaiter = {
        predicate,
        resolve: (session) => {
          this.cleanupWaiter(sessionId, waiter);
          resolve(session);
        },
        reject: (error) => {
          this.cleanupWaiter(sessionId, waiter);
          reject(error);
        },
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.reject(new Error("等待 Claude 运行结果超时"));
        }, timeoutMs);
      }
      const bucket = this.waiters.get(sessionId) ?? new Set<SessionWaiter>();
      bucket.add(waiter);
      this.waiters.set(sessionId, bucket);
    });
  }

  toLiveEvent(session: SessionRecord, type: LiveSessionEvent["type"] = "session.updated"): LiveSessionEvent {
    return {
      type,
      session: this.toResponse(session),
    };
  }

  toResponse(session: SessionRecord, overrides?: Partial<SidecarResponse>): SidecarResponse {
    return {
      session_id: session.sidecarSessionId,
      sdk_session_id: session.sdkSessionId,
      project_id: session.projectId,
      run_id: session.activeRunId,
      status: session.lastStatus,
      status_text: session.lastStatusText,
      output: session.lastOutput,
      thinking: session.lastThinking,
      pending_request: session.pendingRequest ?? null,
      recent_events: [...session.recentEvents],
      event_version: session.eventVersion,
      updated_at: session.updatedAt,
      ...overrides,
    };
  }

  private notifyWaiters(session: SessionRecord): void {
    const bucket = this.waiters.get(session.goSessionId);
    if (!bucket || bucket.size === 0) {
      return;
    }
    for (const waiter of [...bucket]) {
      if (waiter.predicate(session)) {
        waiter.resolve(session);
      }
    }
  }

  private notifySubscribers(session: SessionRecord): void {
    const bucket = this.subscribers.get(session.goSessionId);
    if (!bucket || bucket.size === 0) {
      return;
    }
    const event = this.toLiveEvent(session);
    for (const subscriber of [...bucket]) {
      try {
        subscriber(event);
      } catch {
        // ignore subscriber failures
      }
    }
  }

  private cleanupWaiter(sessionId: string, waiter: SessionWaiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    const bucket = this.waiters.get(sessionId);
    if (!bucket) {
      return;
    }
    bucket.delete(waiter);
    if (bucket.size === 0) {
      this.waiters.delete(sessionId);
    }
  }

  private createRecentEvent(type: string, text: string): RecentEvent {
    return {
      type,
      text,
      created_at: nowUnix(),
    };
  }

  private trimRecentEvents(events: RecentEvent[]): RecentEvent[] {
    if (events.length <= this.recentEventsLimit) {
      return events;
    }
    return events.slice(events.length - this.recentEventsLimit);
  }
}

function pendingStatus(kind: PendingRequest["kind"]): SidecarStatus {
  switch (kind) {
    case "approval":
      return "awaiting_approval";
    case "selection":
      return "awaiting_selection";
    case "text_input":
      return "awaiting_text_input";
    default:
      return "idle";
  }
}

function normalizeStatusText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || "";
  return normalized || fallback;
}
