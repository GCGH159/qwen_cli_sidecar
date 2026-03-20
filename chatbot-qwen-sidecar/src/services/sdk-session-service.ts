/**
 * SDK 会话服务
 *
 * 直接读取 SDK 存储的会话历史文件（JSONL 格式）。
 * 文件位置: ~/.qwen/projects/{projectId}/chats/{sessionId}.jsonl
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";
import { createReadStream } from "node:fs";

export interface SdkSessionSummary {
  session_id: string;
  cwd: string;
  start_time: string;
  prompt: string;
  git_branch?: string;
  message_count: number;
}

export interface SdkSessionDetail {
  session_id: string;
  project_hash: string;
  start_time: string;
  last_updated: string;
  messages: SdkSessionMessage[];
}

export interface SdkSessionMessage {
  uuid: string;
  type: "user" | "assistant" | "tool_result" | "system";
  timestamp: string;
  text: string;
  role?: string;
}

export interface SdkListSessionsResult {
  items: SdkSessionSummary[];
  has_more: boolean;
  next_cursor?: number;
}

interface ChatRecord {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: "user" | "assistant" | "tool_result" | "system";
  cwd: string;
  message?: {
    role?: string;
    parts?: Array<{ text?: string; thought?: boolean }>;
  };
}

/**
 * 生成项目目录名（与 SDK 的 sanitizeCwd 保持一致）
 * 将非字母数字字符替换为 "-"
 */
function sanitizeCwd(cwd: string): string {
  // On Windows, normalize to lowercase for case-insensitive matching
  const normalizedCwd = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * SDK 会话服务
 *
 * 提供对 SDK 存储的会话历史文件的访问。
 */
export class SdkSessionService {
  private readonly projectId: string;
  private readonly chatsDir: string;

  constructor(cwd: string) {
    this.projectId = sanitizeCwd(cwd);
    this.chatsDir = join(homedir(), ".qwen", "projects", this.projectId, "chats");
  }

  /**
   * 列出 SDK 维护的会话列表
   */
  async listSessions(size: number = 20, cursor?: number): Promise<SdkListSessionsResult> {
    const files = await this.getSessionFiles(cursor);

    const items: SdkSessionSummary[] = [];
    let hasMore = false;
    let nextCursor: number | undefined;

    for (let i = 0; i < files.length && items.length < size; i++) {
      const file = files[i];
      try {
        const summary = await this.getSessionSummary(file.path);
        if (summary) {
          items.push(summary);
        }
      } catch {
        // 忽略读取失败的文件
      }
    }

    if (files.length > size) {
      hasMore = true;
      nextCursor = files[size]?.mtime;
    }

    return { items, has_more: hasMore, next_cursor: nextCursor };
  }

  /**
   * 获取 SDK 会话的详细消息列表
   */
  async getSessionMessages(sessionId: string): Promise<SdkSessionDetail | null> {
    const filePath = join(this.chatsDir, `${sessionId}.jsonl`);

    try {
      const records = await this.readAllRecords(filePath);
      if (records.length === 0) {
        return null;
      }

      // 重建线性历史（从树结构）
      const messages = this.reconstructHistory(records);

      const stats = await stat(filePath);
      const firstRecord = records[0];

      return {
        session_id: sessionId,
        project_hash: this.projectId,
        start_time: firstRecord.timestamp,
        last_updated: new Date(stats.mtimeMs).toISOString(),
        messages: messages.map((record) => ({
          uuid: record.uuid,
          type: record.type,
          timestamp: record.timestamp,
          text: this.extractTextFromContent(record.message),
          role: record.message?.role,
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * 检查会话是否存在
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const filePath = join(this.chatsDir, `${sessionId}.jsonl`);
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取会话文件列表
   */
  private async getSessionFiles(cursor?: number): Promise<Array<{ name: string; path: string; mtime: number }>> {
    try {
      const fileNames = await readdir(this.chatsDir);
      const files: Array<{ name: string; path: string; mtime: number }> = [];

      for (const name of fileNames) {
        // 只处理 .jsonl 文件
        if (!name.endsWith(".jsonl")) continue;

        const filePath = join(this.chatsDir, name);
        try {
          const stats = await stat(filePath);
          // 应用游标过滤
          if (cursor !== undefined && stats.mtimeMs >= cursor) continue;
          files.push({ name, path: filePath, mtime: stats.mtimeMs });
        } catch {
          continue;
        }
      }

      // 按修改时间降序排列
      files.sort((a, b) => b.mtime - a.mtime);
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 获取会话摘要
   */
  private async getSessionSummary(filePath: string): Promise<SdkSessionSummary | null> {
    try {
      const records = await this.readLines(filePath, 10);
      if (records.length === 0) return null;

      const firstRecord = records[0];
      const messageCount = await this.countMessages(filePath);

      // 提取第一个用户提示
      let prompt = "";
      for (const record of records) {
        if (record.type === "user" && record.message?.parts) {
          for (const part of record.message.parts) {
            if (part.text && !part.thought) {
              prompt = part.text;
              break;
            }
          }
          if (prompt) break;
        }
      }

      // 截断长提示
      if (prompt.length > 200) {
        prompt = prompt.slice(0, 200) + "...";
      }

      return {
        session_id: firstRecord.sessionId,
        cwd: firstRecord.cwd,
        start_time: firstRecord.timestamp,
        prompt,
        message_count: messageCount,
      };
    } catch {
      return null;
    }
  }

  /**
   * 读取 JSONL 文件的前 N 行
   */
  private async readLines(filePath: string, maxLines: number): Promise<ChatRecord[]> {
    const records: ChatRecord[] = [];

    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let lineCount = 0;

      rl.on("line", (line) => {
        if (lineCount >= maxLines) {
          rl.close();
          return;
        }

        const trimmed = line.trim();
        if (trimmed) {
          try {
            records.push(JSON.parse(trimmed) as ChatRecord);
            lineCount++;
          } catch {
            // 忽略解析失败的行
          }
        }
      });

      rl.on("close", () => resolve(records));
      rl.on("error", reject);
    });
  }

  /**
   * 读取所有记录
   */
  private async readAllRecords(filePath: string): Promise<ChatRecord[]> {
    const records: ChatRecord[] = [];

    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            records.push(JSON.parse(trimmed) as ChatRecord);
          } catch {
            // 忽略解析失败的行
          }
        }
      });

      rl.on("close", () => resolve(records));
      rl.on("error", reject);
    });
  }

  /**
   * 统计消息数量
   */
  private async countMessages(filePath: string): Promise<number> {
    const uuids = new Set<string>();

    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const record = JSON.parse(trimmed) as ChatRecord;
          if (record.type === "user" || record.type === "assistant") {
            uuids.add(record.uuid);
          }
        } catch {
          // 忽略解析失败的行
        }
      });

      rl.on("close", () => resolve(uuids.size));
      rl.on("error", reject);
    });
  }

  /**
   * 从树结构重建线性历史
   */
  private reconstructHistory(records: ChatRecord[]): ChatRecord[] {
    if (records.length === 0) return [];

    // 按 UUID 分组
    const recordsByUuid = new Map<string, ChatRecord[]>();
    for (const record of records) {
      const existing = recordsByUuid.get(record.uuid) || [];
      existing.push(record);
      recordsByUuid.set(record.uuid, existing);
    }

    // 从最后一条记录回溯到根
    const lastUuid = records[records.length - 1].uuid;
    const uuidChain: string[] = [];
    const visited = new Set<string>();
    let currentUuid: string | null = lastUuid;

    while (currentUuid && !visited.has(currentUuid)) {
      visited.add(currentUuid);
      uuidChain.push(currentUuid);
      const recordsForUuid = recordsByUuid.get(currentUuid);
      if (!recordsForUuid || recordsForUuid.length === 0) break;
      currentUuid = recordsForUuid[0].parentUuid;
    }

    // 反转得到时间顺序
    uuidChain.reverse();

    // 构建消息列表
    const messages: ChatRecord[] = [];
    for (const uuid of uuidChain) {
      const recordsForUuid = recordsByUuid.get(uuid);
      if (recordsForUuid && recordsForUuid.length > 0) {
        // 合并相同 UUID 的记录
        messages.push(this.aggregateRecords(recordsForUuid));
      }
    }

    return messages;
  }

  /**
   * 合并相同 UUID 的多条记录
   */
  private aggregateRecords(records: ChatRecord[]): ChatRecord {
    if (records.length === 0) {
      throw new Error("Cannot aggregate empty records array");
    }

    const base = { ...records[0] };

    for (let i = 1; i < records.length; i++) {
      const record = records[i];

      // 合并 message parts
      if (record.message?.parts) {
        if (!base.message) {
          base.message = record.message;
        } else {
          base.message = {
            role: base.message.role,
            parts: [...(base.message.parts || []), ...(record.message.parts || [])],
          };
        }
      }

      // 更新时间戳为最新的
      if (record.timestamp > base.timestamp) {
        base.timestamp = record.timestamp;
      }
    }

    return base;
  }

  /**
   * 从 message 对象中提取文本
   */
  private extractTextFromContent(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const content = message as { parts?: Array<{ text?: string; thought?: boolean }> };
    if (!content.parts || !Array.isArray(content.parts)) {
      return "";
    }

    const textParts: string[] = [];
    for (const part of content.parts) {
      // 跳过 thought 类型的 part
      if (part.thought) continue;
      if (part.text) {
        textParts.push(part.text);
      }
    }

    return textParts.join("\n");
  }
}