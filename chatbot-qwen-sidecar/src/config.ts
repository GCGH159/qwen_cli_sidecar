import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export type SidecarLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export type AskUserPreviewFormat = "markdown" | "html";

export type QwenThinkingMode = "adaptive" | "disabled";

export type QwenEffort = "low" | "medium" | "high" | "max";

export interface QwenProjectConfig {
  id: string;
  label: string;
  workspaceDir: string;
}

export interface SidecarConfig {
  // 运行环境
  env: string;

  // HTTP 服务配置
  host: string;
  port: number;
  logLevel: SidecarLogLevel;

  // Sidecar 鉴权配置
  sidecarApiKey: string;

  // 上游 Qwen / Gateway 配置
  qwenApiKey: string;
  qwenAuthToken: string;
  qwenBaseUrl: string;
  qwenAuthType: string;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;

  // Qwen Agent 配置
  model: string;
  workspaceDir: string;
  defaultProjectId: string;
  projects: Record<string, QwenProjectConfig>;
  thinkingMode: QwenThinkingMode;
  effort: QwenEffort;
  queryMaxTurns: number;
  includePartialMessages: boolean;
  promptSuggestions: boolean;
  agentProgressSummaries: boolean;
  askUserPreviewFormat: AskUserPreviewFormat;
  clientAppName: string;

  // 面板与快照配置
  snapshotWaitMs: number;
  panelOutputLimit: number;
  panelStatusLimit: number;
  recentEventsLimit: number;
}

function getEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return raw.trim();
}

function getEnvAsInt(name: string, fallback: number): number {
  const raw = getEnv(name, "");
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getEnvAsBool(name: string, fallback: boolean): boolean {
  const raw = getEnv(name, "").toLowerCase();
  switch (raw) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function getEnvAsLogLevel(name: string, fallback: SidecarLogLevel): SidecarLogLevel {
  const raw = getEnv(name, "").toLowerCase();
  switch (raw) {
    case "trace":
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
    case "silent":
      return raw;
    default:
      return fallback;
  }
}

function getEnvAsPreviewFormat(name: string, fallback: AskUserPreviewFormat): AskUserPreviewFormat {
  const raw = getEnv(name, "").toLowerCase();
  switch (raw) {
    case "markdown":
    case "html":
      return raw;
    default:
      return fallback;
  }
}

function getEnvAsThinkingMode(name: string, fallback: QwenThinkingMode): QwenThinkingMode {
  const raw = getEnv(name, "").toLowerCase();
  switch (raw) {
    case "adaptive":
    case "disabled":
      return raw;
    default:
      return fallback;
  }
}

function getEnvAsEffort(name: string, fallback: QwenEffort): QwenEffort {
  const raw = getEnv(name, "").toLowerCase();
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return raw;
    default:
      return fallback;
  }
}

function defaultWorkspaceDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith("/claude-sidecar")) {
    const parent = cwd.slice(0, -"/claude-sidecar".length).trim();
    if (parent) {
      return parent;
    }
  }
  return cwd;
}

function defaultQwenProjectsRoot(): string {
  return join(homedir(), ".qwen", "projects");
}

function defaultWorkspaceSearchRoot(legacyWorkspaceDir: string): string {
  if (isAbsolute(legacyWorkspaceDir)) {
    return dirname(legacyWorkspaceDir);
  }
  return dirname(defaultWorkspaceDir());
}

function normalizeProjectId(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

function loadExplicitProjects(): Record<string, QwenProjectConfig> {
  const raw = getEnv("QWEN_PROJECTS_JSON", "");
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`QWEN_PROJECTS_JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QWEN_PROJECTS_JSON 必须是 JSON object");
  }

  const projects: Record<string, QwenProjectConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const id = key.trim();
    if (!id) {
      continue;
    }

    let label = id;
    let workspaceDir = "";

    if (typeof value === "string") {
      workspaceDir = value.trim();
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.label === "string" && record.label.trim()) {
        label = record.label.trim();
      }
      if (typeof record.workspaceDir === "string" && record.workspaceDir.trim()) {
        workspaceDir = record.workspaceDir.trim();
      }
    }

    if (!workspaceDir) {
      throw new Error(`Qwen 项目 ${id} 缺少 workspaceDir`);
    }
    if (!isAbsolute(workspaceDir)) {
      throw new Error(`Qwen 项目 ${id} 的 workspaceDir 必须是绝对路径`);
    }

    projects[id] = {
      id,
      label,
      workspaceDir,
    };
  }

  return projects;
}

function loadProjects(defaultProjectId: string, legacyWorkspaceDir: string): Record<string, QwenProjectConfig> {
  const discovered = discoverProjectsFromQwenMetadata(defaultWorkspaceSearchRoot(legacyWorkspaceDir));
  const explicit = loadExplicitProjects();
  const projects: Record<string, QwenProjectConfig> = {
    ...discovered,
    ...explicit,
  };

  if (Object.keys(projects).length === 0) {
    projects[defaultProjectId] = {
      id: defaultProjectId,
      label: defaultProjectId,
      workspaceDir: legacyWorkspaceDir,
    };
  }

  if (!projects[defaultProjectId] && isAbsolute(legacyWorkspaceDir)) {
    projects[defaultProjectId] = {
      id: defaultProjectId,
      label: defaultProjectId,
      workspaceDir: legacyWorkspaceDir,
    };
  }

  if (!projects[defaultProjectId]) {
    throw new Error(`默认 Qwen 项目不存在: ${defaultProjectId}`);
  }

  return projects;
}

function discoverProjectsFromQwenMetadata(searchRoot: string): Record<string, QwenProjectConfig> {
  if (!isAbsolute(searchRoot)) {
    return {};
  }

  const root = defaultQwenProjectsRoot();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return {};
  }

  const searchRootSlug = toProjectMetadataName(searchRoot);
  const slugIndex = buildWorkspaceSlugIndex(searchRoot);
  const projects: Record<string, QwenProjectConfig> = {};
  const usedIDs = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") {
      continue;
    }

    const workspaceDir = resolveWorkspaceDirFromProjectName(entry.name, searchRoot, searchRootSlug, slugIndex);
    if (!workspaceDir) {
      continue;
    }

    const baseID = normalizeProjectId(basename(workspaceDir), entry.name.replace(/^-+/, "").trim());
    const id = ensureUniqueProjectID(baseID, workspaceDir, usedIDs);
    projects[id] = {
      id,
      label: baseID,
      workspaceDir,
    };
  }

  return projects;
}

function buildWorkspaceSlugIndex(searchRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  walkWorkspaceDirectories(searchRoot, "", index);
  return index;
}

function walkWorkspaceDirectories(currentDir: string, relativeDir: string, index: Map<string, string>): void {
  if (relativeDir) {
    index.set(relativeDir.replace(/[\\/]+/g, "-"), currentDir);
  }

  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".claude") {
      continue;
    }

    const nextDir = join(currentDir, entry.name);
    const nextRelativeDir = relativeDir ? join(relativeDir, entry.name) : entry.name;
    walkWorkspaceDirectories(nextDir, nextRelativeDir, index);
  }
}

function resolveWorkspaceDirFromProjectName(
  projectName: string,
  searchRoot: string,
  searchRootSlug: string,
  slugIndex: Map<string, string>,
): string {
  const normalized = projectName.trim();
  if (!normalized) {
    return "";
  }
  if (normalized === searchRootSlug) {
    return searchRoot;
  }

  const expectedPrefix = `${searchRootSlug}-`;
  if (!normalized.startsWith(expectedPrefix)) {
    return "";
  }

  const relativeSlug = normalized.slice(expectedPrefix.length).trim();
  if (!relativeSlug) {
    return "";
  }

  return slugIndex.get(relativeSlug) ?? "";
}

function toProjectMetadataName(workspaceDir: string): string {
  return `-${workspaceDir.replace(/^\/+/, "").replace(/[\\/]+/g, "-")}`;
}

function ensureUniqueProjectID(baseID: string, workspaceDir: string, usedIDs: Set<string>): string {
  let candidate = baseID.trim();
  if (!candidate) {
    candidate = workspaceDir.replace(/^\/+/, "").replace(/[\\/]+/g, "-");
  }
  if (!usedIDs.has(candidate)) {
    usedIDs.add(candidate);
    return candidate;
  }

  const pathCandidate = workspaceDir.replace(/^\/+/, "").replace(/[\\/]+/g, "-");
  if (pathCandidate && !usedIDs.has(pathCandidate)) {
    usedIDs.add(pathCandidate);
    return pathCandidate;
  }

  let index = 2;
  while (usedIDs.has(`${candidate}-${index}`)) {
    index += 1;
  }
  const unique = `${candidate}-${index}`;
  usedIDs.add(unique);
  return unique;
}

export function loadConfig(): SidecarConfig {
  const legacyWorkspaceDir = getEnv("QWEN_WORKSPACE_DIR", defaultWorkspaceDir());
  const defaultProjectId = normalizeProjectId(getEnv("QWEN_DEFAULT_PROJECT", "chatbot-go"), "chatbot-go");
  const projects = loadProjects(defaultProjectId, legacyWorkspaceDir);
  const defaultProject = projects[defaultProjectId];

  const config = {
    env: getEnv("ENV", "dev"),

    host: getEnv("HOST", "0.0.0.0"),
    port: getEnvAsInt("PORT", 8099),
    logLevel: getEnvAsLogLevel("LOG_LEVEL", "info"),

    sidecarApiKey: getEnv("SIDECAR_API_KEY", ""),

    qwenApiKey: getEnv("QWEN_API_KEY", ""),
    qwenAuthToken: getEnv("QWEN_AUTH_TOKEN", ""),
    qwenBaseUrl: getEnv("QWEN_BASE_URL", ""),
    qwenAuthType: getEnv("QWEN_AUTH_TYPE", "openai"),
    httpProxy: getEnv("HTTP_PROXY", ""),
    httpsProxy: getEnv("HTTPS_PROXY", ""),
    noProxy: getEnv("NO_PROXY", ""),

    model: getEnv("QWEN_MODEL", "qwen-max"),
    workspaceDir: defaultProject.workspaceDir,
    defaultProjectId,
    projects,
    thinkingMode: getEnvAsThinkingMode("QWEN_THINKING_MODE", "adaptive"),
    effort: getEnvAsEffort("QWEN_EFFORT", "high"),
    queryMaxTurns: getEnvAsInt("QWEN_QUERY_MAX_TURNS", 60),
    includePartialMessages: getEnvAsBool("QWEN_INCLUDE_PARTIAL_MESSAGES", true),
    promptSuggestions: getEnvAsBool("QWEN_PROMPT_SUGGESTIONS", false),
    agentProgressSummaries: getEnvAsBool("QWEN_AGENT_PROGRESS_SUMMARIES", true),
    askUserPreviewFormat: getEnvAsPreviewFormat("QWEN_ASK_USER_PREVIEW_FORMAT", "markdown"),
    clientAppName: getEnv("QWEN_AGENT_SDK_CLIENT_APP", "chatbot-qwen-sidecar/0.1.0"),

    snapshotWaitMs: getEnvAsInt("QWEN_SNAPSHOT_WAIT_MS", 8000),
    panelOutputLimit: getEnvAsInt("QWEN_PANEL_OUTPUT_LIMIT", 2800),
    panelStatusLimit: getEnvAsInt("QWEN_PANEL_STATUS_LIMIT", 400),
    recentEventsLimit: getEnvAsInt("QWEN_RECENT_EVENTS_LIMIT", 20),
  };

  console.log("[loadConfig] QWEN_MODEL from env:", process.env.QWEN_MODEL);
  console.log("[loadConfig] config.model:", config.model);
  console.log("[loadConfig] config.qwenBaseUrl:", config.qwenBaseUrl);
  console.log("[loadConfig] config.qwenAuthType:", config.qwenAuthType);

  return config;
}

export const Cfg: SidecarConfig = loadConfig();
