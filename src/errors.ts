/**
 * SVN 错误类型与分类（纯函数，零 I/O）
 *
 * v0.2.0 新增 `kind` 分类，修掉旧版「所有失败都压成 code=1、超时与输出超限无法区分」的问题。
 * 向后兼容：构造签名仍为 `new SvnError(message, stderr, code)`，`code` 仍是进程退出码（数字），
 * `stderr` 仍是解码后的错误文本。
 */

/** 失败种类：便于调用方分诊（超时 / 未安装 / 非工作副本 / 冲突 / 认证 / 输出超限 / 已取消） */
export type SvnErrorKind =
  | "notFound"
  | "notWorkingCopy"
  | "conflict"
  | "auth"
  | "timeout"
  | "outputLimit"
  | "aborted"
  | "unknown";

export interface SvnErrorOptions {
  kind?: SvnErrorKind;
  cause?: unknown;
}

export class SvnError extends Error {
  readonly name = "SvnError";
  /** 失败种类（分诊用；`code` 仍是进程退出码） */
  readonly kind: SvnErrorKind;
  /** 原始错误（Node execFile 错误对象） */
  readonly cause?: unknown;

  constructor(message: string, public stderr = "", public code = 1, options: SvnErrorOptions = {}) {
    super(message);
    this.kind = options.kind ?? "unknown";
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 各类失败的 stderr 判据（Apache Subversion 错误码为稳定契约） */
const KIND_PATTERNS: Array<{ kind: SvnErrorKind; pattern: RegExp }> = [
  { kind: "notWorkingCopy", pattern: /E155007|E155010|is not a working copy|不是工作副本/i },
  { kind: "conflict", pattern: /E155015|remains in conflict|E155027|conflict/i },
  { kind: "auth", pattern: /E170001|E215004|Authentication failed|authorization failed|认证失败/i },
];

export interface ClassifySvnErrorInput {
  stderr?: string;
  /** Node execFile 的错误对象（用于识别超时/输出超限/取消） */
  raw?: { killed?: boolean; signal?: string | null; code?: string | number; message?: string };
}

/**
 * 依据 Node 错误对象与已解码 stderr 判定失败种类。
 * 超时 / 输出超限 / 取消优先于 stderr 文本判据（它们没有 svn 侧的 stderr）。
 */
export function classifySvnError(input: ClassifySvnErrorInput): SvnErrorKind {
  const raw = input.raw;
  const errCode = raw?.code;
  const message = raw?.message ?? "";

  if (errCode === "ABORT_ERR" || raw?.signal === "SIGABRT") {
    return "aborted";
  }
  if (
    errCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer|stdout maxBuffer/i.test(message)
  ) {
    return "outputLimit";
  }
  if (
    errCode === "ETIMEDOUT" ||
    raw?.killed === true ||
    /timed out|timeout/i.test(message)
  ) {
    return "timeout";
  }
  if (errCode === "ENOENT") {
    return "notFound";
  }

  const stderr = input.stderr ?? "";
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(stderr)) {
      return kind;
    }
  }
  return "unknown";
}

/** 把 Node 的 `err.code`（可能是字符串，如 "ENOENT"）归一化为数字退出码 */
export function normalizeExitCode(errCode: unknown): number {
  if (typeof errCode === "number" && Number.isFinite(errCode)) {
    return errCode;
  }
  // ENOENT（二进制缺失 / cwd 无效）按「命令不可执行」语义归一
  if (errCode === "ENOENT") {
    return 127;
  }
  return 1;
}
