export type SidecarStatus =
  | "inactive"
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_selection"
  | "awaiting_text_input"
  | "error";

export type PendingKind = "approval" | "selection" | "text_input";

export interface ClaudeOption {
  id: string;
  label: string;
}

export interface PendingRequest {
  kind: PendingKind;
  request_id: string;
  prompt?: string;
  options?: ClaudeOption[];
}

export interface RecentEvent {
  type: string;
  text: string;
  created_at: number;
}

export interface SidecarResponse {
  session_id?: string;
  sdk_session_id?: string;
  project_id?: string;
  run_id?: string;
  status?: SidecarStatus;
  status_text?: string;
  output?: string;
  error?: string;
  pending_request?: PendingRequest | null;
  recent_events?: RecentEvent[];
  event_version?: number;
  updated_at?: number;
}

export interface LiveSessionEvent {
  type: "session.snapshot" | "session.updated";
  session: SidecarResponse;
}

export interface EnsureSessionRequest {
  user_id: string;
  session_id: string;
  sdk_session_id?: string;
  project_id?: string;
  workspace_dir?: string;
}

export interface ListSessionsRequest {
  project_id?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectSummary {
  id: string;
  label: string;
  workspace_dir: string;
}

export interface ListProjectsResponse {
  default_project_id: string;
  items: ProjectSummary[];
}

export interface HistorySessionSummary {
  session_id: string;
  project_id?: string;
  summary: string;
  last_modified: number;
  created_at?: number;
  cwd?: string;
  git_branch?: string;
  custom_title?: string;
  first_prompt?: string;
  tag?: string;
  file_size?: number;
}

export interface ListSessionsResponse {
  project_id: string;
  items: HistorySessionSummary[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface GetSessionMessagesRequest {
  project_id?: string;
  sdk_session_id: string;
  limit?: number;
  offset?: number;
}

export type HistorySessionMessageKind = "message" | "tool_use" | "tool_result";

export interface HistorySessionMessage {
  type: "user" | "assistant";
  kind: HistorySessionMessageKind;
  uuid: string;
  session_id: string;
  text: string;
}

export interface GetSessionMessagesResponse {
  project_id: string;
  sdk_session_id: string;
  items: HistorySessionMessage[];
  limit: number;
  offset: number;
  has_more: boolean;
}

// ====== SDK 会话相关类型 ======

export interface SdkSessionSummary {
  session_id: string;
  cwd: string;
  start_time: string;
  prompt: string;
  git_branch?: string;
  message_count: number;
}

export interface SdkListSessionsResponse {
  project_id: string;
  items: SdkSessionSummary[];
  has_more: boolean;
  next_cursor?: number;
}

export interface SdkSessionMessage {
  uuid: string;
  type: "user" | "assistant" | "tool_result" | "system";
  timestamp: string;
  text: string;
  role?: string;
}

export interface SdkSessionDetail {
  session_id: string;
  project_hash: string;
  start_time: string;
  last_updated: string;
  messages: SdkSessionMessage[];
}

export interface SdkListSessionsRequest {
  workspace_dir: string;
  limit?: number;
  cursor?: number;
}

export interface GetSdkSessionMessagesRequest {
  workspace_dir: string;
  session_id: string;
}

export interface GetSdkSessionMessagesResponse {
  project_id: string;
  session_id: string;
  data?: SdkSessionDetail;
  error?: string;
}

export interface GetSessionSnapshotRequest {
  session_id: string;
  sidecar_session_id?: string;
}

export interface SendMessageRequest {
  session_id: string;
  sidecar_session_id?: string;
  message: string;
}

export interface ApprovalRequest {
  session_id: string;
  sidecar_session_id?: string;
  request_id: string;
  decision: string;
}

export interface SelectionRequest {
  session_id: string;
  sidecar_session_id?: string;
  request_id: string;
  option_id: string;
}

export interface TextInputRequest {
  session_id: string;
  sidecar_session_id?: string;
  request_id: string;
  text: string;
}

export interface CancelRunRequest {
  session_id: string;
  sidecar_session_id?: string;
  run_id?: string;
}

export interface SessionRecord {
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
  recentEvents: RecentEvent[];
  eventVersion: number;
  pendingRequest?: PendingRequest;
  updatedAt: number;
  currentQuery?: LiveQueryHandle;
  pendingResolvers: Map<string, PendingResolver>;
}

export interface PendingResolver {
  kind: PendingKind;
  resolve: (value: PendingResolution) => void;
  reject: (error: Error) => void;
}

export type PendingResolution =
  | { kind: "approval"; decision: "allow" | "deny" }
  | { kind: "selection"; optionId: string }
  | { kind: "text_input"; text: string };

export interface LiveQueryHandle {
  interrupt: () => Promise<void>;
}
