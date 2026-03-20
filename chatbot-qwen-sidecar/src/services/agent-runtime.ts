import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import {
  query,
  type CanUseTool,
  type SDKMessage,
} from "@qwen-code/sdk";

import type { QwenProjectConfig, SidecarConfig } from "../config.js";
import type {
  ApprovalRequest,
  CancelRunRequest,
  GetSessionMessagesRequest,
  GetSessionMessagesResponse,
  GetSessionSnapshotRequest,
  GetSdkSessionMessagesRequest,
  GetSdkSessionMessagesResponse,
  HistorySessionMessage,
  ListProjectsResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LiveSessionEvent,
  PendingResolution,
  RecentEvent,
  SelectionRequest,
  SendMessageRequest,
  SdkListSessionsResponse,
  SessionRecord,
  SidecarResponse,
  TextInputRequest,
} from "../types.js";
import { SessionStore } from "./session-store.js";
import { SdkSessionService } from "./sdk-session-service.js";
import {
  buildApprovalPendingRequest,
  createAskUserSpec,
} from "./request-mapper.js";

export class AgentRuntime {
  constructor(
    private readonly config: SidecarConfig,
    private readonly store: SessionStore,
    private readonly logger: FastifyBaseLogger,
  ) {}

  listProjects(): ListProjectsResponse {
    return {
      default_project_id: this.config.defaultProjectId,
      items: Object.values(this.config.projects).map((project) => ({
        id: project.id,
        label: project.label,
        workspace_dir: project.workspaceDir,
      })),
    };
  }

  async ensureSession(
    userId: string,
    sessionId: string,
    sdkSessionId?: string,
    projectId?: string,
    workspaceDir?: string,
  ): Promise<SidecarResponse> {
    const project = this.resolveProject(projectId);
    const existing = this.store.getSession(sessionId.trim());
    if (existing?.projectId !== project.id && existing?.currentQuery) {
      throw new Error("Qwen 正在运行，请先等待当前任务完成或取消");
    }
    const effectiveWorkspaceDir = workspaceDir?.trim() || project.workspaceDir;
    const session = this.store.ensureSession(
      userId.trim(),
      sessionId.trim(),
      project.id,
      clip(`已切换项目：${project.label}`, this.config.panelStatusLimit),
      effectiveWorkspaceDir,
    );
    const normalizedSdkSessionId = sdkSessionId?.trim() || "";
    if (!normalizedSdkSessionId || normalizedSdkSessionId === session.sdkSessionId) {
      return this.store.toResponse(session);
    }
    if (session.currentQuery) {
      throw new Error("Qwen 正在运行，请先等待当前任务完成或取消");
    }
    // Qwen SDK 不支持 getSessionInfo，直接使用提供的 session ID
    const attached = this.store.attachSdkSession(
      session.goSessionId,
      normalizedSdkSessionId,
      project.id,
      clip(`已绑定历史会话：${normalizedSdkSessionId}`, this.config.panelStatusLimit),
      workspaceDir,
    );
    return this.store.toResponse(attached);
  }

  /**
   * 通过 SDK 会话 ID 获取或创建 sidecar 会话
   *
   * 用于从 SDK 会话历史列表点击进入时，能够找到或创建对应的 sidecar 会话。
   */
  async resolveSession(
    sdkSessionId: string,
    projectId?: string,
    workspaceDir?: string,
  ): Promise<SidecarResponse> {
    const normalizedSdkSessionId = sdkSessionId.trim();
    if (!normalizedSdkSessionId) {
      throw new Error("sdk_session_id 不能为空");
    }

    // 1. 先尝试通过 sdkSessionId 查找已有的 sidecar 会话
    const existing = this.store.getSession(normalizedSdkSessionId);
    if (existing) {
      return this.store.toResponse(existing);
    }

    // 2. 找不到则创建新会话，使用 sdkSessionId 作为 sidecarSessionId
    const project = this.resolveProject(projectId);
    const effectiveWorkspaceDir = workspaceDir?.trim() || project.workspaceDir;
    const newSessionId = normalizedSdkSessionId; // 使用 sdkSessionId 作为新会话的 ID

    const session = this.store.ensureSession(
      "resolved-user", // 默认用户 ID
      newSessionId,
      project.id,
      clip(`已关联 SDK 会话：${normalizedSdkSessionId}`, this.config.panelStatusLimit),
      effectiveWorkspaceDir,
    );

    // 绑定 SDK 会话 ID
    const attached = this.store.attachSdkSession(
      session.goSessionId,
      normalizedSdkSessionId,
      project.id,
      clip(`已关联 SDK 会话：${normalizedSdkSessionId}`, this.config.panelStatusLimit),
      effectiveWorkspaceDir,
    );

    return this.store.toResponse(attached);
  }

  /**
   * 列出 Sidecar 维护的会话列表
   *
   * 返回当前 sidecar 内存中的会话状态，用于 UI 展示活跃会话。
   */
  async listSessions(input: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const project = this.resolveProject(input.project_id);
    // Sidecar 当前内存中的会话列表
    const sessions = this.store.getAllSessions();
    const items = sessions
      .filter((s) => s.projectId === project.id)
      .map((s) => ({
        session_id: s.sidecarSessionId,
        project_id: s.projectId,
        summary: s.lastStatusText,
        last_modified: s.updatedAt,
        created_at: s.updatedAt,
        cwd: s.workspaceDir,
      }));

    return {
      project_id: project.id,
      items,
      limit: input.limit || 20,
      offset: input.offset || 0,
      has_more: false,
    };
  }

  /**
   * 列出 SDK 维护的会话历史列表
   *
   * 返回 SDK 存储在 ~/.qwen/projects/{projectHash}/chats/ 中的会话文件列表。
   * 这些是完整的历史会话，包含所有对话记录。
   */
  async listSdkSessions(input: { workspace_dir: string; limit?: number; cursor?: number }): Promise<SdkListSessionsResponse> {
    const workspaceDir = input.workspace_dir?.trim();
    if (!workspaceDir) {
      throw new Error("workspace_dir 不能为空");
    }

    const sdkService = new SdkSessionService(workspaceDir);
    const result = await sdkService.listSessions(input.limit || 20, input.cursor);

    return {
      project_id: "",
      items: result.items,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
    };
  }

  /**
   * 获取 SDK 会话的消息列表
   *
   * 从 SDK 存储的 JSONL 文件中读取完整的对话历史。
   */
  async getSdkSessionMessages(input: { workspace_dir: string; session_id: string }): Promise<GetSdkSessionMessagesResponse> {
    const workspaceDir = input.workspace_dir?.trim();
    if (!workspaceDir) {
      return {
        project_id: "",
        session_id: input.session_id,
        error: "workspace_dir 不能为空",
      };
    }

    const sessionId = input.session_id.trim();
    if (!sessionId) {
      return {
        project_id: "",
        session_id: sessionId,
        error: "session_id 不能为空",
      };
    }

    const sdkService = new SdkSessionService(workspaceDir);
    const data = await sdkService.getSessionMessages(sessionId);

    if (!data) {
      return {
        project_id: "",
        session_id: sessionId,
        error: "会话不存在或无法读取",
      };
    }

    return {
      project_id: "",
      session_id: sessionId,
      data,
    };
  }

  /**
   * 获取 Sidecar 会话的消息列表（已废弃，保留兼容）
   */
  async getSessionMessages(input: GetSessionMessagesRequest): Promise<GetSessionMessagesResponse> {
    const project = this.resolveProject(input.project_id);
    const sessionId = input.sdk_session_id.trim();
    if (!sessionId) {
      throw new Error("sdk_session_id 不能为空");
    }
    // Sidecar 不存储完整历史，返回空列表
    return {
      project_id: project.id,
      sdk_session_id: sessionId,
      items: [],
      limit: input.limit || 20,
      offset: input.offset || 0,
      has_more: false,
    };
  }

  getSessionSnapshot(input: GetSessionSnapshotRequest): SidecarResponse {
    const session = this.requireActiveSession(input.session_id, input.sidecar_session_id);
    return this.store.toResponse(session);
  }

  subscribeSession(
    sessionId: string,
    sidecarSessionId: string | undefined,
    onEvent: (event: LiveSessionEvent) => void,
  ): { initialEvent: LiveSessionEvent; unsubscribe: () => void } {
    const session = this.requireActiveSession(sessionId, sidecarSessionId);
    const unsubscribe = this.store.subscribe(session.goSessionId, onEvent);
    return {
      initialEvent: this.store.toLiveEvent(session, "session.snapshot"),
      unsubscribe,
    };
  }

  async sendMessage(input: SendMessageRequest): Promise<SidecarResponse> {
    const message = input.message.trim();
    if (!message) {
      throw new Error("消息不能为空");
    }

    const session = this.requireActiveSession(input.session_id, input.sidecar_session_id);
    if (session.currentQuery) {
      throw new Error("Qwen 正在运行，请先等待当前任务完成或取消");
    }

    const runId = randomUUID();
    this.logger.info(
      {
        goSessionId: session.goSessionId,
        sidecarSessionId: session.sidecarSessionId,
        sdkSessionId: session.sdkSessionId,
        projectId: session.projectId,
        runId,
        messageLength: message.length,
        shouldResume: session.shouldResume,
      },
      "Starting Qwen run",
    );

    // 记录用户消息
    this.store.appendRecentEvent(session.goSessionId, "user.message", message);

    const options = this.buildQueryOptions(session.goSessionId, runId);
    const abortController = options.abortController;
    const agentQuery = query({ prompt: message, options });

    let next = this.updateSessionState(
      session.goSessionId,
      {
        activeRunId: runId,
        pendingRequest: undefined,
        lastStatus: "running",
        lastStatusText: "Qwen 正在处理请求",
        lastOutput: "",
      },
      "run.started",
      "Qwen 正在处理请求",
    );
    next = this.store.setLiveQuery(session.goSessionId, {
      interrupt: async () => {
        abortController?.abort();
        await agentQuery.interrupt();
      },
    });

    void this.consumeQuery(session.goSessionId, runId, agentQuery);

    // 直接返回当前状态，前端通过轮询获取更新
    return this.store.toResponse(next);
  }

  async respondApproval(input: ApprovalRequest): Promise<SidecarResponse> {
    const session = this.requirePendingRequest(input.session_id, input.sidecar_session_id, input.request_id, "approval");
    const resolver = this.store.consumePendingResolver(session.goSessionId, input.request_id.trim());
    if (!resolver || resolver.kind !== "approval") {
      throw new Error("当前批准请求已失效，请重新发起 Qwen 请求");
    }

    const decision = normalizeApprovalDecision(input.decision);
    this.logger.info(
      { sessionId: session.goSessionId, requestId: input.request_id, decision },
      "Approval response received",
    );

    const baseline = this.updateSessionState(
      session.goSessionId,
      {
        pendingRequest: undefined,
        lastStatus: "running",
        lastStatusText: "Qwen 正在继续执行",
      },
      "run.resumed",
      "Qwen 正在继续执行",
    );

    resolver.resolve({ kind: "approval", decision });
    // 直接返回状态，前端通过轮询获取更新
    return this.store.toResponse(baseline);
  }

  async respondSelection(input: SelectionRequest): Promise<SidecarResponse> {
    const session = this.requirePendingRequest(input.session_id, input.sidecar_session_id, input.request_id, "selection");
    const resolver = this.store.consumePendingResolver(session.goSessionId, input.request_id.trim());
    if (!resolver || resolver.kind !== "selection") {
      throw new Error("当前选择请求已失效，请重新发起 Qwen 请求");
    }

    const optionId = input.option_id.trim();
    if (!optionId) {
      throw new Error("option_id 不能为空");
    }

    const baseline = this.updateSessionState(
      session.goSessionId,
      {
        pendingRequest: undefined,
        lastStatus: "running",
        lastStatusText: "Qwen 正在继续执行",
      },
      "run.resumed",
      "Qwen 正在继续执行",
    );

    resolver.resolve({ kind: "selection", optionId });
    // 直接返回状态，前端通过轮询获取更新
    return this.store.toResponse(baseline);
  }

  async respondTextInput(input: TextInputRequest): Promise<SidecarResponse> {
    const session = this.requirePendingRequest(input.session_id, input.sidecar_session_id, input.request_id, "text_input");
    const resolver = this.store.consumePendingResolver(session.goSessionId, input.request_id.trim());
    if (!resolver || resolver.kind !== "text_input") {
      throw new Error("当前文本输入请求已失效，请重新发起 Qwen 请求");
    }

    const baseline = this.updateSessionState(
      session.goSessionId,
      {
        pendingRequest: undefined,
        lastStatus: "running",
        lastStatusText: "Qwen 正在继续执行",
      },
      "run.resumed",
      "Qwen 正在继续执行",
    );

    resolver.resolve({ kind: "text_input", text: input.text });
    // 直接返回状态，前端通过轮询获取更新
    return this.store.toResponse(baseline);
  }

  async cancelRun(input: CancelRunRequest): Promise<SidecarResponse> {
    const session = this.requireActiveSession(input.session_id, input.sidecar_session_id);
    if (input.run_id?.trim() && session.activeRunId?.trim() && input.run_id.trim() !== session.activeRunId.trim()) {
      throw new Error("当前运行已变更，请刷新 Qwen 面板后重试");
    }

    const liveQuery = session.currentQuery;
    const updated = this.updateSessionState(
      session.goSessionId,
      {
        activeRunId: undefined,
        currentQuery: undefined,
        pendingRequest: undefined,
        lastStatus: "idle",
        lastStatusText: "已取消当前运行",
      },
      "run.canceled",
      "已取消当前运行",
    );
    this.store.rejectPendingResolvers(session.goSessionId, new Error("Qwen 运行已取消"));

    if (liveQuery) {
      await liveQuery.interrupt().catch(() => undefined);
    }

    return this.store.toResponse(updated, { run_id: undefined });
  }

  private buildQueryOptions(
    sessionId: string,
    runId: string,
  ): NonNullable<Parameters<typeof query>[0]["options"]> {
    const session = this.store.requireSession(sessionId);
    const abortController = new AbortController();
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      this.assertRunActive(sessionId, runId);
      if (toolName === "AskUserQuestion") {
        const requestId = randomUUID();
        const askUser = createAskUserSpec(requestId, input);
        const resolution = await this.awaitPendingResolution(
          sessionId,
          runId,
          askUser.pendingRequest,
          options.signal,
        );
        return {
          behavior: "allow",
          updatedInput: askUser.toUpdatedInput(resolution),
        };
      }

      const requestId = randomUUID();
      const pending = buildApprovalPendingRequest(requestId, toolName, input, {});
      const resolution = await this.awaitPendingResolution(sessionId, runId, pending, options.signal);
      if (resolution.kind !== "approval") {
        throw new Error("Qwen 等待的是批准结果");
      }
      if (resolution.decision === "allow") {
        return {
          behavior: "allow",
          updatedInput: input,
        };
      }
      return {
        behavior: "deny",
        message: "用户拒绝了本次工具调用",
      };
    };

    const project = this.resolveProjectForSession(session);

    // 优先使用 session 中存储的 workspaceDir（对于恢复的 SDK 会话特别重要）
    const effectiveCwd = session.workspaceDir || project.workspaceDir;

    const options = {
      abortController,
      canUseTool,
      cwd: effectiveCwd,
      env: buildAgentEnv(this.config),
      includePartialMessages: this.config.includePartialMessages,
      maxSessionTurns: this.config.queryMaxTurns,
      model: this.config.model,
      authType: this.config.qwenAuthType as 'openai' | 'qwen-oauth',
      ...(session.shouldResume ? { resume: session.sdkSessionId } : { sessionId: session.sdkSessionId }),
    };
    this.logger.info(
      { model: this.config.model, authType: this.config.qwenAuthType, cwd: effectiveCwd },
      "buildQueryOptions: 模型配置"
    );
    return options;
  }

  private async awaitPendingResolution(
    sessionId: string,
    runId: string,
    pendingRequest: SessionRecord["pendingRequest"],
    signal: AbortSignal,
  ): Promise<PendingResolution> {
    if (!pendingRequest) {
      throw new Error("Qwen 请求缺少等待信息");
    }

    const requestId = pendingRequest.request_id;
    let settled = false;

    const resolutionPromise = new Promise<PendingResolution>((resolve, reject) => {
      const safeResolve = (value: PendingResolution) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const safeReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      this.store.registerPendingResolver(sessionId, requestId, {
        kind: pendingRequest.kind,
        resolve: safeResolve,
        reject: safeReject,
      });
      signal.addEventListener(
        "abort",
        () => {
          safeReject(new Error("Qwen 运行已取消"));
        },
        { once: true },
      );
    });

    this.updateSessionState(
      sessionId,
      {
        pendingRequest,
        lastStatus: pendingStatusOf(pendingRequest.kind),
        lastStatusText: clip(pendingRequest.prompt || "Qwen 正在等待你的输入", this.config.panelStatusLimit),
      },
      "pending.request",
      pendingRequest.prompt || "Qwen 正在等待你的输入",
    );

    this.logger.info(
      { sessionId, runId, requestId, kind: pendingRequest.kind, prompt: pendingRequest.prompt },
      "Waiting for user approval/selection",
    );

    try {
      const resolution = await resolutionPromise;
      this.assertRunActive(sessionId, runId);
      return resolution;
    } finally {
      this.store.consumePendingResolver(sessionId, requestId);
    }
  }

  private async consumeQuery(
    sessionId: string,
    runId: string,
    agentQuery: ReturnType<typeof query>,
  ): Promise<void> {
    try {
      for await (const message of agentQuery) {
        // 调试日志：记录收到的消息类型
        this.logger.debug({ sessionId, runId, type: message.type }, "Received SDK message");
        this.applyMessage(sessionId, runId, message);
      }
    } catch (error) {
      if (!this.isRunActive(sessionId, runId)) {
        return;
      }
      const errorText = getErrorMessage(error, "Qwen 运行失败");
      this.logger.error({ sessionId, runId, error: errorText }, "Qwen run failed");
      this.updateSessionState(
        sessionId,
        {
          pendingRequest: undefined,
          lastStatus: "error",
          lastStatusText: clip(errorText, this.config.panelStatusLimit),
        },
        "run.error",
        errorText,
      );
    } finally {
      if (!this.isRunActive(sessionId, runId)) {
        return;
      }
      const session = this.store.requireSession(sessionId);
      this.logger.info(
        {
          sessionId,
          runId,
          finalStatus: session.lastStatus,
          finalStatusText: session.lastStatusText,
          sdkSessionId: session.sdkSessionId,
          eventVersion: session.eventVersion,
        },
        "Qwen run finished",
      );
      this.updateSessionState(
        sessionId,
        {
          activeRunId: undefined,
          currentQuery: undefined,
          pendingRequest: undefined,
          shouldResume: true,
          lastStatus: session.lastStatus === "error" ? "error" : "idle",
          lastStatusText:
            session.lastStatus === "error"
              ? session.lastStatusText
              : clip("Qwen 已完成当前请求", this.config.panelStatusLimit),
        },
        "run.finished",
        session.lastStatus === "error" ? session.lastStatusText : "Qwen 已完成当前请求",
      );
    }
  }

  private applyMessage(sessionId: string, runId: string, message: SDKMessage): void {
    if (!this.isRunActive(sessionId, runId)) {
      return;
    }

    const sdkSessionId = message.session_id || "";
    const sdkPatch = sdkSessionId ? { sdkSessionId, shouldResume: true } : undefined;

    switch (message.type) {
      case "assistant": {
        const parsed = parseHistoryMessage(message.message);
        if (!parsed.text) {
          return;
        }
        if (parsed.kind === "tool_use") {
          this.logger.info({ sessionId, runId, tool: parsed.text }, "Tool use");
          this.updateSessionState(
            sessionId,
            {
              ...sdkPatch,
              lastStatusText: clip(parsed.text, this.config.panelStatusLimit),
            },
            "tool.use",
            parsed.text,
          );
          return;
        }
        if (parsed.kind === "tool_result") {
          this.logger.info({ sessionId, runId, result: parsed.text.slice(0, 200) }, "Tool result");
          this.updateSessionState(
            sessionId,
            {
              ...sdkPatch,
              lastStatusText: clip(parsed.text, this.config.panelStatusLimit),
            },
            "tool.result",
            parsed.text,
          );
          return;
        }
        const text = clip(parsed.text, this.config.panelOutputLimit);
        this.updateSessionState(
          sessionId,
          {
            ...sdkPatch,
            lastOutput: text,
          },
          "assistant.output",
          text,
        );
        return;
      }
      case "user": {
        const parsed = parseHistoryMessage(message.message);
        if (!parsed.text || parsed.kind !== "tool_result") {
          return;
        }
        this.updateSessionState(
          sessionId,
          {
            ...sdkPatch,
            lastStatusText: clip(parsed.text, this.config.panelStatusLimit),
          },
          "tool.result",
          parsed.text,
        );
        return;
      }
      case "system": {
        const text = `Qwen 系统消息：${message.subtype}`;
        this.updateSessionState(
          sessionId,
          {
            ...sdkPatch,
            lastStatusText: clip(text, this.config.panelStatusLimit),
          },
          "system.message",
          text,
        );
        return;
      }
      case "result": {
        if (message.subtype === "success") {
          const finalOutput = message.result?.trim()
            ? clip(message.result, this.config.panelOutputLimit)
            : this.store.requireSession(sessionId).lastOutput;
          this.logger.info(
            {
              sessionId,
              runId,
              sdkSessionId: sdkSessionId || undefined,
              subtype: message.subtype,
              hasResult: Boolean(message.result?.trim()),
            },
            "Qwen result received",
          );
          this.updateSessionState(
            sessionId,
            {
              ...sdkPatch,
              lastStatus: "idle",
              lastStatusText: clip("Qwen 已完成当前请求", this.config.panelStatusLimit),
              lastOutput: finalOutput,
            },
            "run.result",
            message.result?.trim() || "Qwen 已完成当前请求",
          );
          return;
        }
        const errorText = clip(
          message.error?.message || resultSubtypeText(message.subtype),
          this.config.panelStatusLimit,
        );
        this.logger.warn(
          {
            sessionId,
            runId,
            sdkSessionId: sdkSessionId || undefined,
            subtype: message.subtype,
            error: message.error,
          },
          "Qwen result error received",
        );
        this.updateSessionState(
          sessionId,
          {
            ...sdkPatch,
            lastStatus: "error",
            lastStatusText: errorText,
          },
          "run.error",
          errorText,
        );
        return;
      }
      case "stream_event": {
        // 处理流式事件
        this.logger.info({ sessionId, runId, eventType: message.event?.type }, "Received stream_event");
        if (message.event) {
          this.applyStreamEvent(sessionId, runId, message as Extract<SDKMessage, { type: "stream_event" }>, sdkPatch);
        }
        return;
      }
      default:
        return;
    }
  }

  private applyStreamEvent(
    sessionId: string,
    runId: string,
    message: Extract<SDKMessage, { type: "stream_event" }>,
    sdkPatch: { sdkSessionId: string; shouldResume: boolean } | undefined,
  ): void {
    const event = message.event;
    const session = this.store.getSession(sessionId);
    if (!session) {
      return;
    }

    switch (event.type) {
      case "content_block_delta": {
        // 流式文本输出
        const delta = event.delta;
        this.logger.info({ sessionId, runId, deltaType: delta.type, deltaText: delta.type === "text_delta" ? delta.text?.slice(0, 50) : undefined }, "content_block_delta detail");
        if (delta.type === "text_delta" && delta.text) {
          // 累积流式文本到 lastOutput
          const currentOutput = session.lastOutput || "";
          const newOutput = currentOutput + delta.text;
          // 更新状态，但不添加到 recent_events（避免事件过多）
          this.store.updateSession(sessionId, {
            ...sdkPatch,
            lastOutput: clip(newOutput, this.config.panelOutputLimit),
            lastStatusText: clip("正在生成输出...", this.config.panelStatusLimit),
          });
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          // 累积思考过程到 lastThinking
          const currentThinking = session.lastThinking || "";
          const newThinking = currentThinking + delta.thinking;
          this.store.updateSession(sessionId, {
            ...sdkPatch,
            lastThinking: clip(newThinking, this.config.panelOutputLimit),
          });
        }
        return;
      }
      case "content_block_start": {
        // 内容块开始
        const block = event.content_block;
        if (block?.type === "text") {
          this.logger.debug({ sessionId, runId, index: event.index }, "Text block start");
        } else if (block?.type === "tool_use") {
          // 工具调用开始
          const toolName = typeof block.name === "string" ? block.name : "Tool";
          this.updateSessionState(
            sessionId,
            {
              ...sdkPatch,
              lastStatusText: clip(`正在调用工具: ${toolName}`, this.config.panelStatusLimit),
            },
            "tool.use.start",
            `→ ${toolName} (开始)`,
          );
        }
        return;
      }
      case "content_block_stop": {
        // 内容块结束
        this.logger.debug({ sessionId, runId, index: event.index }, "Content block stop");
        return;
      }
      case "message_start": {
        // 消息开始
        this.logger.debug({ sessionId, runId, model: event.message?.model }, "Message start");
        return;
      }
      case "message_stop": {
        // 消息结束
        this.logger.debug({ sessionId, runId }, "Message stop");
        return;
      }
      default:
        return;
    }
  }

  private updateSessionState(
    sessionId: string,
    patch: Partial<SessionRecord>,
    eventType?: string,
    eventText?: string,
  ): SessionRecord {
    const session = this.store.requireSession(sessionId);
    const recentEvents = appendRecentEvent(
      session.recentEvents,
      eventType,
      eventText,
      this.config.recentEventsLimit,
    );
    return this.store.updateSession(sessionId, {
      ...patch,
      recentEvents,
    });
  }

  private resolveProject(projectId?: string): QwenProjectConfig {
    const normalized = projectId?.trim() || this.config.defaultProjectId;
    const project = this.config.projects[normalized];
    if (!project) {
      throw new Error(`Qwen 项目不存在: ${normalized}`);
    }
    return project;
  }

  private resolveProjectForSession(session: SessionRecord): QwenProjectConfig {
    const project = this.resolveProject(session.projectId);
    // 如果会话有自定义工作目录，使用会话的工作目录覆盖项目配置
    if (session.workspaceDir?.trim()) {
      return {
        ...project,
        workspaceDir: session.workspaceDir.trim(),
      };
    }
    return project;
  }

  private requireActiveSession(sessionId: string, sidecarSessionId?: string): SessionRecord {
    const normalized = sessionId.trim();
    if (!normalized) {
      throw new Error("session_id 不能为空");
    }
    const session = this.store.requireSession(normalized);
    if (sidecarSessionId?.trim() && sidecarSessionId.trim() !== session.sidecarSessionId) {
      throw new Error("sidecar_session_id 与当前会话不匹配");
    }
    return session;
  }

  private requirePendingRequest(
    sessionId: string,
    sidecarSessionId: string | undefined,
    requestId: string,
    kind: NonNullable<SessionRecord["pendingRequest"]>["kind"],
  ): SessionRecord {
    const session = this.requireActiveSession(sessionId, sidecarSessionId);
    const normalizedRequestId = requestId.trim();
    if (!session.pendingRequest || session.pendingRequest.request_id !== normalizedRequestId || session.pendingRequest.kind !== kind) {
      throw new Error("当前等待请求已失效，请重新发起 Qwen 请求");
    }
    if (!session.currentQuery) {
      throw new Error("Qwen 当前没有可继续的运行");
    }
    return session;
  }

  private assertRunActive(sessionId: string, runId: string): void {
    if (!this.isRunActive(sessionId, runId)) {
      throw new Error("当前 Qwen 运行已结束或已被替换");
    }
  }

  private isRunActive(sessionId: string, runId: string): boolean {
    const session = this.store.getSession(sessionId);
    return Boolean(session && session.activeRunId === runId && session.currentQuery);
  }
}

function buildAgentEnv(config: SidecarConfig): Record<string, string> {
  console.log("[buildAgentEnv] config.model:", config.model);
  console.log("[buildAgentEnv] config.qwenApiKey:", config.qwenApiKey ? "已设置" : "未设置");
  console.log("[buildAgentEnv] config.qwenBaseUrl:", config.qwenBaseUrl);
  console.log("[buildAgentEnv] config.qwenAuthType:", config.qwenAuthType);

  const env: Record<string, string> = {
    ...process.env,
    QWEN_AGENT_SDK_CLIENT_APP: config.clientAppName,
  };

  if (config.qwenApiKey) {
    env.OPENAI_API_KEY = config.qwenApiKey;
    env.QWEN_API_KEY = config.qwenApiKey;
  }
  if (config.qwenAuthToken) {
    env.QWEN_AUTH_TOKEN = config.qwenAuthToken;
  }
  if (config.qwenBaseUrl) {
    env.OPENAI_BASE_URL = config.qwenBaseUrl;
    env.QWEN_BASE_URL = config.qwenBaseUrl;
  }
  if (config.qwenAuthType) {
    env.QWEN_AUTH_TYPE = config.qwenAuthType;
  }
  if (config.httpProxy) {
    env.HTTP_PROXY = config.httpProxy;
  }
  if (config.httpsProxy) {
    env.HTTPS_PROXY = config.httpsProxy;
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy;
  }

  return env;
}

function normalizeApprovalDecision(decision: string): "allow" | "deny" {
  const normalized = decision.trim().toLowerCase();
  if (["allow", "yes", "y", "approve", "approved", "ok"].includes(normalized)) {
    return "allow";
  }
  if (["deny", "no", "n", "reject", "rejected"].includes(normalized)) {
    return "deny";
  }
  throw new Error("无效的批准结果，必须是 yes/allow 或 no/deny");
}

// Qwen SDK 不支持会话历史查询，这些函数已不再使用
// function toHistorySessionSummary(input: SDKSessionInfo, projectId: string): HistorySessionSummary {
//   return {
//     session_id: input.sessionId,
//     project_id: projectId,
//     summary: input.summary,
//     last_modified: input.lastModified,
//     created_at: input.createdAt,
//     cwd: input.cwd,
//     git_branch: input.gitBranch,
//     custom_title: input.customTitle,
//     first_prompt: input.firstPrompt,
//     tag: input.tag,
//     file_size: input.fileSize,
//   };
// }

// function toHistorySessionMessage(input: SDKSessionMessage): HistorySessionMessage {
//   const parsed = parseHistoryMessage(input.message);
//   return {
//     type: input.type,
//     kind: parsed.kind,
//     uuid: input.uuid,
//     session_id: input.session_id,
//     text: parsed.text,
//   };
// }

function parseHistoryMessage(message: unknown): { kind: HistorySessionMessage["kind"]; text: string } {
  const record = asRecord(message);
  if (!record) {
    return { kind: "message", text: "" };
  }
  const content = Array.isArray(record.content) ? contentItems(record.content) : [];
  return parseMessageContent(content);
}

function parseLiveUserMessage(
  message: unknown,
): { kind: HistorySessionMessage["kind"]; text: string } {
  return parseHistoryMessage(message);
}

function parseMessageContent(content: Record<string, unknown>[]): { kind: HistorySessionMessage["kind"]; text: string } {
  const textBlocks = content.filter((item) => item.type === "text" && typeof item.text === "string");
  const messageText = textBlocks.map((item) => String(item.text).trim()).filter(Boolean).join("\n\n");
  if (messageText) {
    return { kind: "message", text: messageText };
  }

  const toolUse = content.find((item) => item.type === "tool_use");
  if (toolUse) {
    return {
      kind: "tool_use",
      text: describeToolUse(toolUse),
    };
  }

  const toolResult = content.find((item) => item.type === "tool_result");
  if (toolResult) {
    return {
      kind: "tool_result",
      text: describeToolResult(toolResult),
    };
  }

  return { kind: "message", text: "" };
}

function contentItems(value: unknown[]): Record<string, unknown>[] {
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function describeToolUse(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name.trim() : "Tool";
  const input = asRecord(item.input);
  const summary = describeToolInput(input);
  return summary ? `→ ${name}: ${summary}` : `→ ${name}`;
}

// Qwen SDK 不支持 tool_progress 消息类型，此函数已不再使用
// function describeToolProgress(toolName: string): string {
//   const normalized = toolName.trim();
//   if (!normalized) {
//     return "→ 执行工具";
//   }
//   return `→ ${normalized}`;
// }

function describeToolInput(input: Record<string, unknown> | null): string {
  if (!input) {
    return "";
  }
  if (typeof input.file_path === "string" && input.file_path.trim()) {
    return clip(input.file_path.trim(), 120);
  }
  if (typeof input.path === "string" && input.path.trim()) {
    if (typeof input.pattern === "string" && input.pattern.trim()) {
      return `${input.pattern.trim()} @ ${clip(input.path.trim(), 80)}`;
    }
    return clip(input.path.trim(), 120);
  }
  if (typeof input.pattern === "string" && input.pattern.trim()) {
    return input.pattern.trim();
  }
  if (typeof input.command === "string" && input.command.trim()) {
    return clip(input.command.trim(), 120);
  }
  if (typeof input.description === "string" && input.description.trim()) {
    return clip(input.description.trim(), 120);
  }
  return clip(JSON.stringify(input), 120);
}

function describeToolResult(item: Record<string, unknown>): string {
  const text = describeToolResultContent(item.content);
  return text || "← 工具返回结果";
}

function describeToolResultContent(value: unknown): string {
  if (typeof value === "string") {
    const text = summarizeToolResultText(value);
    return text ? `← ${text}` : "";
  }
  if (Array.isArray(value)) {
    const parts = contentItems(value)
      .map((entry) => {
        if (entry.type === "text" && typeof entry.text === "string") {
          return summarizeToolResultText(entry.text);
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return `← ${clip(parts.join(" | "), 120)}`;
    }
  }
  const record = asRecord(value);
  if (record) {
    if (record.type === "tool_result") {
      return describeToolResult(record);
    }
    if (typeof record.content === "string" || Array.isArray(record.content)) {
      return describeToolResultContent(record.content);
    }
    return `← ${clip(JSON.stringify(record), 120)}`;
  }
  return "";
}

function summarizeToolResultText(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  const firstLine = normalized.split(/\r?\n/, 1)[0]?.trim() || "";
  return clip(firstLine, 120);
}

function readSdkSessionId(message: SDKMessage): string {
  return typeof message.session_id === "string" ? message.session_id.trim() : "";
}

function pendingStatusOf(kind: NonNullable<SessionRecord["pendingRequest"]>["kind"]): SessionRecord["lastStatus"] {
  switch (kind) {
    case "approval":
      return "awaiting_approval";
    case "selection":
      return "awaiting_selection";
    case "text_input":
      return "awaiting_text_input";
    default:
      return "running";
  }
}

function appendRecentEvent(
  current: RecentEvent[],
  type: string | undefined,
  text: string | undefined,
  limit: number,
): RecentEvent[] {
  const normalizedType = type?.trim() || "";
  const normalizedText = text?.trim() || "";
  if (!normalizedType || !normalizedText) {
    return current;
  }
  const next = [...current, { type: normalizedType, text: normalizedText, created_at: nowUnix() }];
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.min(100, Math.floor(value));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

// Qwen SDK 不支持会话历史查询，此函数已不再使用
// function describeSession(info: SDKSessionInfo): string {
//   return info.customTitle?.trim() || info.summary?.trim() || info.firstPrompt?.trim() || info.sessionId;
// }

function clip(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

function resultSubtypeText(subtype: string): string {
  switch (subtype) {
    case "error_during_execution":
      return "Qwen 执行过程中发生错误";
    case "error_max_turns":
      return "Qwen 达到最大轮数限制";
    case "error_max_budget_usd":
      return "Qwen 达到预算限制";
    case "error_max_structured_output_retries":
      return "Qwen 结构化输出重试次数过多";
    default:
      return "Qwen 运行失败";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
