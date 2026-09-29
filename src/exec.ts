/**
 * SVN 进程执行层（候选二进制探测 + 解码 + 错误分类）
 *
 * v0.2.0 变化：
 * - 二进制候选**只在首次解析时查一次**（旧版每条命令都 spawn 一次 `where svn`）；
 * - 统一走 `decodeSvnOutput`（含 XML/错误输出）——旧版 `runRawUtf8` 把 stderr 强制按 UTF-8 解读，
 *   中文 Windows 上 svn 的中文报错必然乱码；
 * - 输出缓冲上限统一为 64MB 且可配（旧版 executor 64MB / client 10MB 不一致）；
 * - 错误带 `kind`（超时 / 输出超限 / 未安装 / 非工作副本 / 冲突 / 认证 / 已取消），
 *   不再把所有失败压成 code=1 而无法分诊；
 * - 日志可注入（`logger`），默认静默——旧版无条件 `console.warn/error`；
 * - 支持 `AbortSignal` 取消。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeSvnOutput, type SvnOutputEncoding } from "./encoding";
import { SvnError, classifySvnError, normalizeExitCode } from "./errors";

const execFileAsync = promisify(execFile);

/** 底层命令执行结果（`execSvn` 不抛错，调用方检查 `code`） */
export interface SvnExecResult {
  stdout: string;
  stderr: string;
  /** 进程退出码；二进制缺失（ENOENT）统一归一为 127 */
  code: number;
  /** 失败时的诊断信息（Node 侧 message 或候选缺失说明）；成功时缺省 */
  error?: string;
}

/** 可注入日志器（默认 null = 静默） */
export interface SvnLogger {
  debug?(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
  error?(message: string, details?: unknown): void;
}

export interface SvnExecOptions {
  cwd: string;
  /** svn 可执行文件路径；留空则按候选顺序自动探测 */
  svnBinaryPath?: string;
  /** 输出编码；缺省 "auto"（无损 UTF-8 优先 + GBK 回退） */
  encoding?: SvnOutputEncoding;
  /** 单条命令超时（毫秒）；0 表示不设超时 */
  timeoutMs?: number;
  /** 输出缓冲上限（字节）；默认 64MB */
  maxBufferBytes?: number;
  logger?: SvnLogger | null;
  signal?: AbortSignal;
}

/** 默认输出缓冲上限（统一 executor 与 client 两套常量） */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const WIN32_BINARY_CANDIDATES = [
  "C:/Program Files/TortoiseSVN/bin/svn.exe",
  "C:/Program Files/SlikSvn/bin/svn.exe",
  "C:/Program Files/VisualSVN Server/bin/svn.exe",
  "C:/Program Files (x86)/SlikSvn/bin/svn.exe",
  "C:/Program Files (x86)/CollabNet Subversion Client/svn.exe",
];

/** 候选顺序：配置路径 → 裸名 svn → 常见安装路径（PATH 发现结果追加在后） */
export function getBinaryCandidates(configured = ""): string[] {
  const trimmed = configured.trim();
  const candidates: string[] = [];
  if (trimmed) {
    candidates.push(trimmed);
  }
  if (!trimmed || trimmed.toLowerCase() !== "svn") {
    candidates.push("svn");
  }
  if (process.platform === "win32") {
    candidates.push(...WIN32_BINARY_CANDIDATES);
  }
  return dedupeCaseInsensitive(candidates);
}

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = process.platform === "win32" ? item.toLowerCase() : item;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(item);
  }
  return out;
}

/**
 * 通过 `where`（Windows）/`which` 发现 PATH 中的 svn。
 *
 * 注意：`execFileAsync` 未指定 encoding 时 stdout 是 **string**；测试里可能注入 Buffer，
 * 因此两种形态都要兼容（旧版只当 string 处理，导致 Buffer 形态静默返回空）。
 */
export async function discoverFromSystemPath(): Promise<string[]> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = (await execFileAsync(command, ["svn"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })) as { stdout: string | Buffer };
    const text = typeof stdout === "string" ? stdout : decodeSvnOutput(stdout);
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const candidatesCache = new Map<string, Promise<string[]>>();

/** 解析候选列表（按「配置路径 + 平台」缓存，避免每条命令都 spawn 一次 where/which） */
export function resolveBinaryCandidates(configured = ""): Promise<string[]> {
  const key = `${process.platform}|${configured.trim()}`;
  const cached = candidatesCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const base = getBinaryCandidates(configured);
    const discovered = await discoverFromSystemPath();
    // 配置路径为空时，裸名 svn 与 PATH 发现结果通常同源；仍按「裸名 → 硬编码 → PATH」合并去重
    return dedupeCaseInsensitive([...base, ...discovered]);
  })();
  candidatesCache.set(key, pending);
  return pending;
}

/** 清空候选缓存（测试与「安装 svn 后重试」场景用） */
export function clearBinaryCandidatesCache(): void {
  candidatesCache.clear();
}

/** 日志脱敏：`--password <值>` 打码 */
export function maskSensitiveArgs(args: string[]): string[] {
  const safeArgs = [...args];
  const index = safeArgs.indexOf("--password");
  if (index >= 0 && index + 1 < safeArgs.length) {
    safeArgs[index + 1] = "******";
  }
  return safeArgs;
}

/** 构造「找不到 svn」错误（Node 对「二进制缺失」与「cwd 无效」都报 ENOENT，无法区分，故两类可能都提示） */
export function buildBinaryNotFoundError(candidates: string[], cwd: string): string {
  const hasBareName = candidates.some((c) => !c.includes("/") && !c.includes("\\") && !c.includes(":"));
  return [
    "未找到 svn 可执行文件。",
    `已尝试：${candidates.join(" | ")}`,
    hasBareName
      ? "请确认已安装 svn 命令行工具并位于 PATH（Windows: TortoiseSVN 安装时勾选“Command line client tools”，或安装 SlikSvn/VisualSVN）。"
      : "请检查上述候选路径是否正确、svn 是否安装在该位置。",
    `当前工作副本路径：${cwd}（若该路径不存在，svn 也会报相同错误，请一并检查）`,
  ].join(" ");
}

interface ExecFailureOptions {
  args: string[];
  timeoutMs: number;
  maxBufferBytes: number;
  binary: string;
}

function buildFailureMessage(kind: string, stderr: string, rawMessage: string, options: ExecFailureOptions): string {
  const svnText = stderr.trim();
  if (svnText) {
    return svnText;
  }
  const command = `svn ${options.args.join(" ")}`;
  switch (kind) {
    case "timeout":
      return `SVN 命令超时（${options.timeoutMs}ms）：${command}`;
    case "outputLimit":
      return `SVN 输出超过缓冲上限（${options.maxBufferBytes} 字节）：${command}`;
    case "aborted":
      return `SVN 命令已取消：${command}`;
    case "notFound":
      return buildBinaryNotFoundError([options.binary], "");
    default:
      return rawMessage || `SVN 命令执行失败：${command}`;
  }
}

interface RawExecError {
  code?: string | number;
  message?: string;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  killed?: boolean;
  signal?: string | null;
}

async function execOnce(
  binary: string,
  args: string[],
  options: SvnExecOptions & { maxBufferBytes: number; timeoutMs: number }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = (await execFileAsync(binary, args, {
    cwd: options.cwd,
    windowsHide: true,
    maxBuffer: options.maxBufferBytes,
    timeout: options.timeoutMs || undefined,
    encoding: "buffer" as const,
    signal: options.signal,
  })) as { stdout: Buffer; stderr: Buffer };
  return {
    stdout: decodeSvnOutput(stdout, { encoding: options.encoding }),
    stderr: decodeSvnOutput(stderr, { encoding: options.encoding }),
  };
}

function normalizeOptions(options: SvnExecOptions) {
  return {
    ...options,
    timeoutMs: options.timeoutMs ?? 60000,
    maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };
}

/**
 * 执行 svn 命令并**不抛错**，返回结构化结果（`execSvn` 与内部候选回退共用）。
 */
export async function execSvnResult(args: string[], options: SvnExecOptions): Promise<SvnExecResult> {
  const resolved = normalizeOptions(options);
  const binaries = await resolveBinaryCandidates(resolved.svnBinaryPath ?? "");
  const safeArgs = maskSensitiveArgs(args);
  let lastFailure: SvnExecResult | null = null;

  for (const binary of binaries) {
    resolved.logger?.debug?.("[svn-client] 执行命令", { binary, args: safeArgs, cwd: resolved.cwd, encoding: resolved.encoding });
    try {
      const { stdout, stderr } = await execOnce(binary, args, resolved);
      resolved.logger?.debug?.("[svn-client] 命令执行成功", { binary, args: safeArgs, stdoutLength: stdout.length });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const err = error as RawExecError;
      if (err.code === "ENOENT") {
        resolved.logger?.warn?.("[svn-client] svn 可执行文件未找到，尝试下一个候选", { binary, message: err.message });
        lastFailure = { stdout: "", stderr: "", code: 127, error: `未找到可执行文件：${binary}` };
        continue;
      }
      const stderr = decodeSvnOutput(err.stderr, { encoding: resolved.encoding });
      const stdout = decodeSvnOutput(err.stdout, { encoding: resolved.encoding });
      const code = normalizeExitCode(err.code);
      resolved.logger?.error?.("[svn-client] 命令执行失败", { binary, args: safeArgs, code, stderr });
      return { stdout, stderr, code, error: err.message ?? "SVN 命令执行失败" };
    }
  }

  return lastFailure ?? { stdout: "", stderr: "", code: 127, error: "未找到 svn 可执行文件" };
}

/**
 * 执行 svn 命令并**在失败时抛 `SvnError`**（带 `kind` 分类），成功返回解码后的 stdout。
 */
export async function runSvn(args: string[], options: SvnExecOptions): Promise<string> {
  const resolved = normalizeOptions(options);
  const binaries = await resolveBinaryCandidates(resolved.svnBinaryPath ?? "");
  const safeArgs = maskSensitiveArgs(args);

  for (const binary of binaries) {
    resolved.logger?.debug?.("[svn-client] 执行命令", { binary, args: safeArgs, cwd: resolved.cwd, encoding: resolved.encoding });
    try {
      const { stdout } = await execOnce(binary, args, resolved);
      resolved.logger?.debug?.("[svn-client] 命令执行成功", { binary, args: safeArgs, stdoutLength: stdout.length });
      return stdout;
    } catch (error) {
      const err = error as RawExecError;
      if (err.code === "ENOENT") {
        // 二进制缺失（或 cwd 无效）→ 回退下一候选
        resolved.logger?.warn?.("[svn-client] svn 可执行文件未找到，尝试下一个候选", { binary, message: err.message });
        continue;
      }
      const stderr = decodeSvnOutput(err.stderr, { encoding: resolved.encoding });
      const kind = classifySvnError({ stderr, raw: err });
      const message = buildFailureMessage(kind, stderr, err.message ?? "", {
        args,
        timeoutMs: resolved.timeoutMs,
        maxBufferBytes: resolved.maxBufferBytes,
        binary,
      });
      resolved.logger?.error?.("[svn-client] 命令执行失败", { binary, args: safeArgs, kind, code: normalizeExitCode(err.code), stderr });
      throw new SvnError(message, stderr.trim(), normalizeExitCode(err.code), { kind, cause: err });
    }
  }

  throw new SvnError(buildBinaryNotFoundError(binaries, resolved.cwd), "", 127, { kind: "notFound" });
}

/**
 * 底层执行入口（公开 API）：**不抛错**，返回 `{ stdout, stderr, code }`。
 * 与 `SvnClient` 共用候选探测与解码，故「svn 只装在 TortoiseSVN 目录」时同样可用。
 */
export function execSvn(args: string[], cwd: string, timeoutMs = 60000): Promise<SvnExecResult> {
  return execSvnResult(args, { cwd, timeoutMs });
}
