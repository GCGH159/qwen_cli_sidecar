import { randomUUID } from "node:crypto";

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

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly waiters = new Map<string, Set<SessionWaiter>>();
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();

  constructor(private readonly recentEventsLimit = 20) {}

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
        recentEvents: [this.createRecentEvent("project.switched", normalizeStatusText(statusText, `已切换项目：${projectId}`))],
        eventVersion: existing.eventVersion + 1,
        updatedAt: nowUnix(),
        pendingResolvers: existing.pendingResolvers,
      };
      this.sessions.set(goSessionId, merged);
      this.notifyWaiters(merged);
      this.notifySubscribers(merged);
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
      recentEvents: [this.createRecentEvent("session.created", "Claude 模式已开启")],
      eventVersion: 1,
      updatedAt: nowUnix(),
      pendingResolvers: new Map<string, PendingResolver>(),
    };
    this.sessions.set(goSessionId, created);
    this.notifyWaiters(created);
    this.notifySubscribers(created);
    return created;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  requireSession(sessionId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("Claude 会话不存在或已过期");
    }
    return session;
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
    return merged;
  }

  attachSdkSession(sessionId: string, sdkSessionId: string, projectId: string, statusText: string): SessionRecord {
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
      sdkSessionId,
      shouldResume: true,
      activeRunId: undefined,
      currentQuery: undefined,
      pendingRequest: undefined,
      lastStatus: "idle",
      lastStatusText: statusText,
      lastOutput: "",
      recentEvents,
      eventVersion: session.eventVersion + 1,
      updatedAt: nowUnix(),
      pendingResolvers: session.pendingResolvers,
    };
    this.sessions.set(sessionId, merged);
    this.notifyWaiters(merged);
    this.notifySubscribers(merged);
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
