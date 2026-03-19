import type { PendingResolution, PendingRequest } from "../types.js";

export interface PermissionPromptMeta {
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
}

type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
};

type AskOption = {
  label: string;
  description?: string;
};

export interface AskUserSpec {
  pendingRequest: PendingRequest;
  toUpdatedInput: (resolution: PendingResolution) => Record<string, unknown>;
}

export function buildApprovalPendingRequest(
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
  meta: PermissionPromptMeta,
): PendingRequest {
  const lines = [
    meta.title?.trim(),
    meta.displayName?.trim() && meta.description?.trim()
      ? `${meta.displayName.trim()}：${meta.description.trim()}`
      : meta.displayName?.trim() || meta.description?.trim(),
    meta.decisionReason?.trim() ? `原因：${meta.decisionReason.trim()}` : undefined,
    meta.blockedPath?.trim() ? `路径：${meta.blockedPath.trim()}` : undefined,
    summarizeToolInput(toolName, input),
  ].filter((value): value is string => Boolean(value));

  return {
    kind: "approval",
    request_id: requestId,
    prompt: clip(lines.join("\n"), 500),
  };
}

export function createAskUserSpec(requestId: string, input: Record<string, unknown>): AskUserSpec {
  const questions = readQuestions(input);
  if (questions.length === 0) {
    return {
      pendingRequest: {
        kind: "text_input",
        request_id: requestId,
        prompt: "Qwen 请求你补充输入，请直接回复下一条消息。",
      },
      toUpdatedInput: (resolution) => ({
        ...input,
        answers: {
          question: resolution.kind === "text_input" ? resolution.text : readResolutionText(resolution),
        },
      }),
    };
  }

  if (questions.length === 1 && questions[0].options.length > 0 && !questions[0].multiSelect) {
    const [question] = questions;
    const optionMap = new Map<string, string>();
    const options = question.options.map((option, index) => {
      const id = String(index + 1);
      optionMap.set(id, option.label);
      return { id, label: clip(option.label, 40) };
    });

    return {
      pendingRequest: {
        kind: "selection",
        request_id: requestId,
        prompt: clip(question.question, 500),
        options,
      },
      toUpdatedInput: (resolution) => {
        if (resolution.kind !== "selection") {
          throw new Error("Qwen 等待的是一个选项，而不是文本输入");
        }
        const label = optionMap.get(resolution.optionId);
        if (!label) {
          throw new Error("无效的选项");
        }
        return {
          ...input,
          answers: {
            [question.question]: label,
          },
        };
      },
    };
  }

  const prompt = buildAskUserPrompt(questions);
  return {
    pendingRequest: {
      kind: "text_input",
      request_id: requestId,
      prompt,
    },
    toUpdatedInput: (resolution) => {
        if (resolution.kind !== "text_input") {
          throw new Error("Qwen 等待的是文本输入");
        }
        return {
          ...input,
          answers: buildTextAnswers(questions, resolution.text),
        };
      },
  };
}

function readQuestions(input: Record<string, unknown>): AskQuestion[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((item) => readQuestion(item))
    .filter((item): item is AskQuestion => item !== null);
}

function readQuestion(value: unknown): AskQuestion | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const question = readString(record.question);
  if (!question) {
    return null;
  }
  const options = Array.isArray(record.options)
    ? record.options.map((item) => readOption(item)).filter((item): item is AskOption => item !== null)
    : [];
  return {
    question,
    header: readString(record.header) || undefined,
    options,
    multiSelect: record.multiSelect === true,
  };
}

function readOption(value: unknown): AskOption | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const label = readString(record.label);
  if (!label) {
    return null;
  }
  return {
    label,
    description: readString(record.description) || undefined,
  };
}

function buildAskUserPrompt(questions: AskQuestion[]): string {
  if (questions.length === 1 && questions[0].options.length === 0) {
    return clip(questions[0].question, 500);
  }

  const lines: string[] = [
    "Qwen 请求你补充信息。请直接回复下一条消息。",
  ];

  if (questions.length > 1 || questions.some((question) => question.multiSelect)) {
    lines.push("如果包含多个问题，建议按 JSON 格式回复，键使用题目原文。", "示例：{\"问题1\":\"答案\"}");
  }

  for (const [index, question] of questions.entries()) {
    lines.push(`${index + 1}. ${question.question}`);
    if (question.options.length > 0) {
      lines.push(`可选：${question.options.map((option) => option.label).join(" / ")}`);
    }
    if (question.multiSelect) {
      lines.push("可多选，多个答案请用逗号分隔。");
    }
  }

  return clip(lines.join("\n"), 900);
}

function buildTextAnswers(questions: AskQuestion[], text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (questions.length === 0) {
    return { question: trimmed };
  }

  if (questions.length === 1) {
    const [question] = questions;
    if (question.options.length > 0 && question.multiSelect) {
      const selected = matchMultiOptions(question, trimmed);
      return {
        [question.question]: selected.length > 0 ? selected.join(", ") : trimmed,
      };
    }
    return { [question.question]: trimmed };
  }

  const parsed = parseObjectLike(trimmed);
  if (parsed) {
    const answers: Record<string, unknown> = {};
    for (const question of questions) {
      const direct = parsed[question.question];
      const byHeader = question.header ? parsed[question.header] : undefined;
      const value = direct ?? byHeader;
      if (value !== undefined) {
        answers[question.question] = normalizeAnswerValue(value);
      }
    }
    if (Object.keys(answers).length > 0) {
      return answers;
    }
  }

  const lineAnswers = parseLinePairs(trimmed, questions);
  if (Object.keys(lineAnswers).length > 0) {
    return lineAnswers;
  }

  return { [questions[0].question]: trimmed };
}

function parseObjectLike(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseLinePairs(text: string, questions: AskQuestion[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const rawKey = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const question = questions.find((item) => item.question === rawKey || item.header === rawKey);
    if (!question || !rawValue) {
      continue;
    }
    answers[question.question] = question.options.length > 0 && question.multiSelect
      ? matchMultiOptions(question, rawValue).join(", ") || rawValue
      : rawValue;
  }

  return answers;
}

function matchMultiOptions(question: AskQuestion, text: string): string[] {
  const tokens = text
    .split(/[,，\n]/)
    .map((token) => token.trim())
    .filter(Boolean);
  const matches: string[] = [];
  for (const token of tokens) {
    const option = question.options.find((item) => item.label.toLowerCase() === token.toLowerCase());
    if (option) {
      matches.push(option.label);
    }
  }
  return matches;
}

function normalizeAnswerValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const summary = safeJson(input);
  if (!summary) {
    return `工具：${toolName}`;
  }
  return clip(`工具：${toolName}\n参数：${summary}`, 500);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function readResolutionText(resolution: PendingResolution): string {
  switch (resolution.kind) {
    case "approval":
      return resolution.decision;
    case "selection":
      return resolution.optionId;
    case "text_input":
      return resolution.text;
    default:
      return "";
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clip(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
