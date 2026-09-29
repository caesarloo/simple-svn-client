/**
 * @caesarloo/simple-svn-client · 统一 SVN 客户端
 *
 * 以 vault-svn 插件（obsidian-svn）的 SvnClient 为基座，合并 ai-pm-tool 的
 * 日志/区间/摘要/cat/自动 add 提交能力，形成两个插件共用的纯 Node 封装。
 *
 * v0.2.0 的职责划分（v0.1.3 的单文件实现已拆分，便于用真实 svn 输出 fixture 单测）：
 * - `encoding.ts`：输出解码（无损 UTF-8 优先 + GBK 择优，不再猜测/改写正常文本）
 * - `errors.ts`：`SvnError` 与失败分类（kind / 退出码 / stderr）
 * - `exec.ts`：进程执行（候选探测与缓存、超时、缓冲上限、取消、日志注入）
 * - `parsers.ts`：纯函数解析器（status/update/diff/log/summarize）
 * - 本文件：客户端门面（命令编排、变更收集、冲突守卫、同步流程）
 *
 * 公共 API 向后兼容（消费者 ai-pm-tool 0.1.3 / obsidian-svn 0.1.0 的硬约束）：
 * `new SvnClient(path, options?)`、`timeoutMs: 0` 表示不设超时、`DiffLine.lineNumber` 恒为 number、
 * 写操作失败抛错、`commit` 返回 string、`autoAdd` 重试、`diff()` 第三参数取值不变；
 * 新增能力一律以「可选选项 / 新增方法 / 新增字段」形式出现。
 */
import { decodeSvnOutput, type SvnOutputEncoding } from "./encoding";
import { SvnError } from "./errors";
import { DEFAULT_MAX_BUFFER_BYTES, runSvn, type SvnExecOptions, type SvnLogger } from "./exec";
import { parseFrontmatter } from "./frontmatter";
import {
  normalizeDiffLines,
  parseDiffOutput,
  parseLogXml,
  parseStatusXml,
  parseSummarizeOutput,
  parseUpdateOutput,
  type SummarizeEntry,
} from "./parsers";
import type {
  ChangeItem,
  LogEntry,
  SnapshotInfo,
  SvnConflict,
  SvnDiff,
  SvnStatusEntry,
  UpdateConflict,
  UpdateResult,
} from "./types";

export { SvnError } from "./errors";
export type { SvnErrorKind } from "./errors";
export { execSvn, getBinaryCandidates, resolveBinaryCandidates, clearBinaryCandidatesCache } from "./exec";
export type { SvnExecResult, SvnLogger } from "./exec";
export type { SvnOutputEncoding } from "./encoding";
export type { SummarizeEntry } from "./parsers";

/** SvnClient 构造选项 */
export interface SvnClientOptions {
  /** svn 可执行文件路径；留空则自动探测 PATH + 常见安装路径（如 TortoiseSVN） */
  svnBinaryPath?: string;
  /** 是否输出调试日志（默认 false；等价于把 console 作为 logger） */
  enableDebugLog?: boolean;
  /** 单条命令超时（毫秒），默认 60000；传 0 表示不设超时 */
  timeoutMs?: number;
  /**
   * 文件内容读取器（相对工作副本路径 → 文件内容 Buffer | null）。
   * 用于未版本化/新增文件的 diff 预览，以及冲突标记扫描；未配置时前者抛错、后者跳过。
   * 提供此回调可避免客户端直接依赖 Node 内置 fs 模块（Obsidian 社区审核要求）。
   */
  fileContentReader?: (relativePath: string) => Promise<Buffer | null>;
  /** 日志器；默认 null（静默）。旧版无条件 console.warn/error，v0.2.0 起改为可注入 */
  logger?: SvnLogger | null;
  /** 输出编码；默认 "auto"（无损 UTF-8 优先 + GBK 回退）。cygwin/WSL 版 svn 可显式指定 "utf8" */
  outputEncoding?: SvnOutputEncoding;
  /** 单条命令输出缓冲上限（字节），默认 64MB */
  maxBufferBytes?: number;
  /** 取消信号（透传给 child_process） */
  signal?: AbortSignal;
  /**
   * 是否对 diff 结果做「忽略空白/分隔线差异」的归零化。
   * 默认 **false**：v0.1.3 默认开启会把 `-const a = f(x, y); / +const a=f(x,y);`
   * 这类真实修改报告为「无差异」。需要旧行为时显式设 true。
   */
  normalizeDiff?: boolean;
  /** 用 v0.1.3 的状态映射（external→added，丢弃 obstructed/incomplete/replaced/ignored） */
  legacyStatusMapping?: boolean;
  /** 每次 commit 前自动检查冲突（等价于 commit 传 assertNoConflicts: true） */
  assertNoConflictsOnCommit?: boolean;
}

/** resolve 的冲突解决策略（默认 working：保留工作区版本，会保留冲突标记） */
export type SvnResolveAccept =
  | "working"
  | "base"
  | "mine-conflict"
  | "theirs-conflict"
  | "mine-full"
  | "theirs-full";

export interface ResolveOptions {
  /**
   * `svn resolve --accept <策略>`；默认 `"working"`。
   * 注意：`working` 只是把冲突标记留在文件里并清除冲突状态位，**不是**「自动解决」。
   */
  accept?: SvnResolveAccept;
}

/** commit 选项 */
export interface CommitOptions {
  /** 提交失败且提示文件未纳入版本控制时，自动 svn add 后重试一次（默认 false） */
  autoAdd?: boolean;
  /** 提交前检查冲突（status + 文件内标记），命中即拒绝提交（默认 false） */
  assertNoConflicts?: boolean;
}

/** 冲突标记扫描：`<<<<<<<` / `=======` / `>>>>>>>` 出现在行首 */
const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7})/m;

/** 本地时区 ISO 时间戳（带偏移，`Date` 可解析；旧版用 UTC toISOString 而注释写「最近同步时间」） */
function localIsoTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}

export class SvnClient {
  private readonly svnBinaryPath: string;
  private readonly enableDebugLog: boolean;
  private readonly timeoutMs: number;
  private readonly fileContentReader: ((relativePath: string) => Promise<Buffer | null>) | null;
  private readonly logger: SvnLogger | null;
  private readonly encoding: SvnOutputEncoding;
  private readonly maxBufferBytes: number;
  private readonly normalizeDiff: boolean;
  private readonly legacyStatusMapping: boolean;
  private readonly assertNoConflictsOnCommit: boolean;
  private readonly signal?: AbortSignal;

  constructor(
    private readonly workingCopyPath: string,
    options: SvnClientOptions = {}
  ) {
    this.svnBinaryPath = options.svnBinaryPath ?? "";
    this.enableDebugLog = options.enableDebugLog ?? false;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fileContentReader = options.fileContentReader ?? null;
    this.logger = options.logger ?? (this.enableDebugLog ? console : null);
    this.encoding = options.outputEncoding ?? "auto";
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.normalizeDiff = options.normalizeDiff ?? false;
    this.legacyStatusMapping = options.legacyStatusMapping ?? false;
    this.assertNoConflictsOnCommit = options.assertNoConflictsOnCommit ?? false;
    this.signal = options.signal;
  }

  private debugLog(message: string, details?: unknown): void {
    if (!this.enableDebugLog) {
      return;
    }
    this.logger?.debug?.(message, details);
  }

  private execOptions(): SvnExecOptions {
    return {
      cwd: this.workingCopyPath,
      svnBinaryPath: this.svnBinaryPath,
      encoding: this.encoding,
      timeoutMs: this.timeoutMs,
      maxBufferBytes: this.maxBufferBytes,
      logger: this.logger,
      ...(this.signal ? { signal: this.signal } : {}),
    };
  }

  /** 执行一条 svn 命令并返回解码后的 stdout（失败抛 SvnError，带 kind 分类） */
  private async run(args: string[]): Promise<string> {
    return await runSvn(args, this.execOptions());
  }

  /** svn 是否可用（能执行 --version 即视为可用） */
  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureAvailable();
      return true;
    } catch {
      return false;
    }
  }

  /** 确保 svn 可用；不可用时抛错（含候选路径与安装指引） */
  async ensureAvailable(): Promise<void> {
    await this.run(["--version"]);
  }

  /** 当前工作副本版本号；非工作副本或 svn 不可用时返回 null */
  async getRevision(): Promise<string | null> {
    try {
      const output = await this.run(["info", "--show-item", "revision"]);
      const rev = output.trim();
      return rev || null;
    } catch {
      return null;
    }
  }

  /**
   * 工作副本根路径（`svn info --show-item wc-root`，svn 1.8+）。
   *
   * v0.2.0 修复：旧版走 `runRawUtf8`（强制 UTF-8），而 wc-root 返回的是**本地路径**——
   * 中文 Windows 上 svn 按 GBK 输出，强制 UTF-8 会得到含 U+FFFD 的不可用路径
   * （`runSync` 又会把它当作 cwd，最终误报「本机未检测到 svn」）。
   * 现走统一解码（无损 UTF-8 优先 + GBK 回退）。
   */
  async getWorkingCopyRoot(): Promise<string | null> {
    try {
      const output = await this.run(["info", "--show-item", "wc-root"]);
      const root = output.trim();
      return root || null;
    } catch {
      return null;
    }
  }

  /** 目录是否为 SVN 工作副本（svn info 成功） */
  async isWorkingCopy(): Promise<boolean> {
    try {
      await this.run(["info"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 工作副本状态（XML 输出，避免命令行编码导致的文件名乱码）。
   *
   * @param paths 可选：只查这些路径（v0.2.0 新增，向后兼容）
   */
  async status(paths?: string[]): Promise<SvnStatusEntry[]> {
    const args = ["status", "--xml"];
    if (paths && paths.length > 0) {
      this.validatePaths(paths);
      args.push(...this.safePathArgs(paths));
    }
    const xml = await this.run(args);
    const entries = parseStatusXml(xml, { legacyStatusMapping: this.legacyStatusMapping });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  /** svn update，返回解析后的更新结果（含冲突明细）；失败抛错 */
  async update(): Promise<UpdateResult> {
    const output = await this.run(["update"]);
    return parseUpdateOutput(output);
  }

  /** 单文件差异；新增文件降级为直接显示内容，已删除文件走仓库 URL 对比 */
  async diff(
    filePath: string,
    compareWithPrevious = false,
    updateStatus?: "added" | "modified" | "deleted" | "unchanged"
  ): Promise<SvnDiff> {
    this.validateInput(filePath, `文件路径 "${filePath}"`);

    if (updateStatus === "added") {
      return await this.buildFileContentDiff(filePath);
    }

    let output = "";
    if (compareWithPrevious) {
      if (updateStatus === "deleted") {
        output = await this.diffViaRepositoryUrl(filePath);
      } else {
        try {
          output = await this.run(["diff", "--force", "-r", "PREV:COMMITTED", this.safePathArg(filePath)]);
        } catch {
          try {
            output = await this.run(["diff", "--force", "-r", "0:COMMITTED", this.safePathArg(filePath)]);
          } catch {
            output = await this.diffViaRepositoryUrl(filePath);
          }
        }
      }
    } else {
      try {
        output = await this.run(["diff", "--force", this.safePathArg(filePath)]);
      } catch (cause) {
        // 未版本化/新增文件无法生成 svn diff → 降级为内容预览；
        // 但**不掩盖真因**：无 reader 时把原始错误一并带出（旧版会替换成「未配置 fileContentReader」）
        return await this.diffFallbackToFileContent(filePath, cause);
      }
    }

    const parsed = parseDiffOutput(filePath, output, compareWithPrevious ? "previous-revision" : "working-copy");
    if (!this.normalizeDiff) {
      return parsed;
    }
    return { ...parsed, lines: normalizeDiffLines(parsed.lines) };
  }

  /**
   * `svn diff -r A:B --summarize`：两个版本间变更的**文件相对路径**列表。
   *
   * v0.2.0 行为变更：旧版返回的是原始行（如 `"M       产品目录/需求A.md"`），
   * 与文档描述的「changed paths」不符；现返回纯路径。需要变更类型字符时用 `diffSummarizeEntries()`。
   */
  async diffSummarize(revOld: string, revNew: string): Promise<string[]> {
    const entries = await this.diffSummarizeEntries(revOld, revNew);
    return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
  }

  /** 同 `diffSummarize`，但保留变更类型字符与目录标记（v0.2.0 新增） */
  async diffSummarizeEntries(revOld: string, revNew: string): Promise<SummarizeEntry[]> {
    this.validateRevision(revOld);
    this.validateRevision(revNew);
    const output = await this.run(["diff", "-r", `${revOld}:${revNew}`, "--summarize"]);
    return parseSummarizeOutput(output);
  }

  /** `svn cat -r rev path`：读取某版本的文件内容；失败返回 null */
  async cat(rev: string, filePath: string): Promise<string | null> {
    try {
      this.validateRevision(rev);
      this.validateInput(filePath, `文件路径 "${filePath}"`);
      return await this.run(["cat", "-r", rev, this.safePathArg(filePath)]);
    } catch {
      return null;
    }
  }

  /** `svn log -l N --xml`：最近 N 条提交（revision/author/date/message/paths） */
  async log(limit = 20): Promise<LogEntry[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`log 的 limit 必须为正整数，收到：${limit}`);
    }
    const xml = await this.run(["log", "-l", String(limit), "--xml"]);
    return parseLogXml(xml);
  }

  /** `svn log -r OLD:NEW --xml -v`：区间内全部提交，含变更路径 */
  async logRange(revOld: string, revNew: string): Promise<LogEntry[]> {
    this.validateRevision(revOld);
    this.validateRevision(revNew);
    const xml = await this.run(["log", "-r", `${revOld}:${revNew}`, "--xml", "-v"]);
    return parseLogXml(xml);
  }

  async add(paths: string[]): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    // 注意：不使用 --force（旧版会把 ignored 文件一并加入；需要时由调用方显式处理）
    return await this.run(this.withNonInteractive(["add", ...this.safePathArgs(paths)]));
  }

  async delete(paths: string[]): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    return await this.run(this.withNonInteractive(["delete", ...this.safePathArgs(paths)]));
  }

  async revert(paths: string[], recursive = false): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    const args = ["revert"];
    if (recursive) {
      args.push("-R");
    }
    args.push(...this.safePathArgs(paths));
    return await this.run(this.withNonInteractive(args));
  }

  /**
   * `svn resolve`。
   *
   * 默认仍为 `--accept working`（保留工作区版本，**冲突标记会留在文件里**，不是自动解决）；
   * v0.2.0 起可用 `options.accept` 指定其他策略。
   */
  async resolve(paths: string[], options: ResolveOptions = {}): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    const accept = options.accept ?? "working";
    return await this.run(this.withNonInteractive(["resolve", "--accept", accept, ...this.safePathArgs(paths)]));
  }

  /**
   * 提交（失败抛错）。
   * - 不能使用 `--` 分隔（会把 -m 也当作路径）；路径以 - 开头时加 ./ 前缀防被当选项
   * - autoAdd: 未纳入版本控制的新文件（E200009/W200005）自动 svn add 后重试一次
   * - assertNoConflicts: 提交前检查冲突（status 命中 conflict 或文件内含冲突标记）并拒绝提交
   */
  async commit(paths: string[], message: string, options: CommitOptions = {}): Promise<string> {
    if (!paths.length) {
      throw new Error("未选择任何暂存文件，无法提交。");
    }
    if (!message.trim()) {
      throw new Error("提交备注不能为空。");
    }
    this.validatePaths(paths);
    this.validateCommitMessage(message);

    if (options.assertNoConflicts || this.assertNoConflictsOnCommit) {
      await this.assertNoConflicts(paths);
    }

    const safePaths = this.safePathArgs(paths);
    const run = () => this.run(this.withNonInteractive(["commit", ...safePaths, "-m", message]));

    try {
      return await run();
    } catch (error) {
      if (options.autoAdd && /not under version control|E200009|W200005/i.test((error as Error).message)) {
        const statusOutput = await this.run(this.withNonInteractive(["status", ...safePaths]));
        const unversioned = statusOutput
          .split(/\r?\n/)
          .filter((l) => /^\?\s+/.test(l))
          .map((l) => l.replace(/^\?\s+/, "").trim())
          .filter(Boolean);
        if (unversioned.length > 0) {
          await this.run(this.withNonInteractive(["add", "--parents", ...this.safePathArgs(unversioned)]));
          return await run();
        }
      }
      throw error;
    }
  }

  /**
   * 查找冲突（v0.2.0 新增）。
   *
   * 双保险（见《ZF03 冲突分析》§七/§八）：
   * ① `svn status` 的 conflict 状态位（可能被跨机同步的脏 `wc.db` 骗过）；
   * ② 文件内容里的冲突标记行扫描（需要 `fileContentReader`；传 `paths` 时只扫这些路径）。
   */
  async findConflicts(paths?: string[]): Promise<SvnConflict[]> {
    const conflicts: SvnConflict[] = [];
    const seen = new Set<string>();

    const entries = await this.status(paths);
    for (const entry of entries) {
      if (entry.status !== "conflict") {
        continue;
      }
      const source = entry.treeConflicted ? "tree" : "status";
      const key = `${source}|${entry.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        conflicts.push({ path: entry.path, source, ...(entry.rawItem ? { detail: entry.rawItem } : {}) });
      }
    }

    if (this.fileContentReader && paths && paths.length > 0) {
      for (const path of paths) {
        try {
          const buffer = await this.fileContentReader(path);
          if (!buffer) {
            continue;
          }
          const text = decodeSvnOutput(buffer, { encoding: this.encoding });
          if (CONFLICT_MARKER_RE.test(text)) {
            const key = `marker|${path}`;
            if (!seen.has(key)) {
              seen.add(key);
              conflicts.push({ path, source: "marker", detail: "文件内含冲突标记" });
            }
          }
        } catch {
          // 读取失败不阻断检查（交由后续 svn 命令报错）
        }
      }
    }

    return conflicts;
  }

  /** 是否存在未解决冲突（v0.2.0 新增） */
  async hasConflicts(paths?: string[]): Promise<boolean> {
    return (await this.findConflicts(paths)).length > 0;
  }

  /** 断言无冲突；存在时抛 `SvnError(kind:"conflict")`（v0.2.0 新增） */
  async assertNoConflicts(paths?: string[]): Promise<void> {
    const conflicts = await this.findConflicts(paths);
    if (conflicts.length === 0) {
      return;
    }
    const detail = conflicts.map((conflict) => `${conflict.path}（${conflict.source}）`).join("、");
    throw new SvnError(`存在未解决的冲突，请先解决后再提交：${detail}`, "", 1, { kind: "conflict" });
  }

  /** 单个文件两个版本间的 frontmatter 字段差异（文件/字段/基线/工作区） */
  async diffFrontmatterFields(path: string, revOld: string, revNew: string): Promise<ChangeItem[]> {
    const baseText = await this.cat(revOld, path);
    const workText = await this.cat(revNew, path);
    const fileName = path.split("/").filter(Boolean).pop() ?? path;

    if (baseText === null && workText === null) {
      // 两侧都读不到：文件在区间外不存在或读取失败。旧版静默返回 []（会被误读为「无差异」），
      // 这里保持返回 []，但调用方可通过 collectChanges 的 changedFiles 判断文件确实变更过。
      return [];
    }
    if (baseText === null || workText === null) {
      return [
        {
          file: fileName,
          field: baseText === null ? "文件新增" : "文件删除",
          base: baseText === null ? "—" : "存在",
          work: workText === null ? "—" : "存在",
          author: "",
          revision: "",
        },
      ];
    }
    const base = parseFrontmatter(baseText);
    const work = parseFrontmatter(workText);
    const keys = new Set([...Object.keys(base), ...Object.keys(work)]);
    const items: ChangeItem[] = [];
    const fmt = (v: unknown): string =>
      v === null || v === undefined
        ? ""
        : Array.isArray(v)
          ? v.join("、")
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
    for (const k of keys) {
      const b = fmt(base[k]);
      const w = fmt(work[k]);
      if (b !== w) {
        items.push({
          file: fileName,
          field: k,
          base: b || "（空）",
          work: w || "（空）",
          author: "",
          revision: "",
        });
      }
    }
    return items;
  }

  /**
   * 汇总变更条目（两版本间全部变更，含提交者与版本号逐文件归属）。
   *
   * v0.2.0 修复：
   * - 不再把 `.obsidian/app.json` 这类**点文件**当作「目录项」丢弃（旧版 `startsWith(".")` 会吞掉它们）；
   * - 目录变更项（`M  dir/`）不再产生 `file: ""` 的伪条目；
   * - 日志路径的 XML 实体已在解析层解码，含 `&` 的路径归属不再丢失。
   */
  async collectChanges(
    revOld: string,
    revNew: string
  ): Promise<{ items: ChangeItem[]; changedFiles: string[] }> {
    const summarizeEntries = await this.diffSummarizeEntries(revOld, revNew);
    const filePaths = summarizeEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);

    const items: ChangeItem[] = [];
    const changedFiles: string[] = [];

    // 提交者与版本号：用 -v 日志（含 changed paths）按文件路径精确归属
    const logs = await this.logRange(revOld, revNew);
    const logsDesc = [...logs].sort((a, b) => Number(b.revision) - Number(a.revision));

    const matchesLogPath = (logPath: string, relativePath: string): boolean => {
      const normalized = logPath.replace(/\\/g, "/").replace(/^\/+/, "");
      return normalized === relativePath || normalized.endsWith(`/${relativePath}`);
    };

    for (const filePath of filePaths) {
      if (!filePath || filePath === ".") {
        continue; // 工作副本根的整体属性变更
      }
      changedFiles.push(filePath);

      let info: { revision: string; author: string } | null = null;
      for (const lg of logsDesc) {
        if (lg.paths.some((p) => matchesLogPath(p, filePath))) {
          info = { revision: lg.revision, author: lg.author };
          break;
        }
      }

      const fields = await this.diffFrontmatterFields(filePath, revOld, revNew);
      for (const it of fields) {
        it.author = info?.author ?? "";
        it.revision = info?.revision ?? "";
        items.push(it);
      }
    }

    return { items, changedFiles };
  }

  // ------------------------------------------------------------------
  // 私有：参数处理
  // ------------------------------------------------------------------

  /** 追加 `--non-interactive`（放末尾，避免影响调用方对 args[0] 的断言/依赖） */
  private withNonInteractive(args: string[]): string[] {
    return [...args, "--non-interactive"];
  }

  /** 路径以 - 开头时加 ./ 前缀；含 @ 时补尾部 @（SVN 的 peg revision 分隔符） */
  private safePathArg(path: string): string {
    let result = path.startsWith("-") ? "./" + path : path;
    if (result.includes("@")) {
      // `path@` 表示空 peg revision：避免文件名里的 @ 被 svn 当作 `@REV`
      result += "@";
    }
    return result;
  }

  private safePathArgs(paths: string[]): string[] {
    return paths.map((p) => this.safePathArg(p));
  }

  // ------------------------------------------------------------------
  // 私有：编码/文件预览
  // ------------------------------------------------------------------

  private async buildFileContentDiff(relativePath: string): Promise<SvnDiff> {
    // 未版本化/新增文件的内容预览经注入的 fileContentReader 读取，避免直接依赖 Node 内置 fs 模块
    if (!this.fileContentReader) {
      throw new Error(`未配置文件内容读取器（fileContentReader），无法预览未版本化文件：${relativePath}`);
    }
    const fileBuffer = await this.fileContentReader(relativePath);
    if (fileBuffer === null) {
      throw new Error(`读取文件内容失败：${relativePath}`);
    }

    if (this.isLikelyBinaryFile(fileBuffer)) {
      throw new Error(`该文件可能为二进制文件，暂不支持文本预览：${relativePath}`);
    }

    const text = decodeSvnOutput(fileBuffer, { encoding: this.encoding });
    // 空文件应为 0 行（旧版 split 会产出 1 行空行，与实际不符）
    const lines = text === "" ? [] : text.split(/\r?\n/);

    const parsedLines = lines.map((content, index) => ({
      lineNumber: index + 1,
      content,
      type: "unchanged" as const,
    }));

    return { filePath: relativePath, lines: parsedLines, compareMode: "file-content" };
  }

  private async diffFallbackToFileContent(filePath: string, cause: unknown): Promise<SvnDiff> {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const causeError = cause instanceof SvnError ? cause : null;

    if (!this.fileContentReader) {
      throw new SvnError(
        `无法生成 SVN diff，且未配置文件内容读取器（fileContentReader），无法预览未版本化文件：${filePath}。原始错误：${causeMessage}`,
        causeError?.stderr ?? "",
        causeError?.code ?? 1,
        { kind: causeError?.kind ?? "unknown", cause }
      );
    }

    try {
      return await this.buildFileContentDiff(filePath);
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new SvnError(
        `${causeMessage}（文件内容预览亦失败：${fallbackMessage}）`,
        causeError?.stderr ?? "",
        causeError?.code ?? 1,
        { kind: causeError?.kind ?? "unknown", cause }
      );
    }
  }

  private isLikelyBinaryFile(buffer: Buffer): boolean {
    if (!buffer.length) {
      return false;
    }

    const sampleLength = Math.min(buffer.length, 8000);
    let suspiciousCount = 0;

    for (let i = 0; i < sampleLength; i += 1) {
      const value = buffer[i];
      if (value === 0) {
        return true;
      }
      const isAllowedControl = value === 9 || value === 10 || value === 13;
      if (!isAllowedControl && value < 32) {
        suspiciousCount += 1;
      }
    }

    return suspiciousCount / sampleLength > 0.1;
  }

  private async diffViaRepositoryUrl(p: string): Promise<string> {
    const workingCopyUrl = (await this.run(["info", "--show-item", "url"])).trim().replace(/\/+$/g, "");
    const revisionText = (await this.run(["info", "--show-item", "revision"])).trim();
    const committedRevision = Number.parseInt(revisionText, 10);

    if (!Number.isFinite(committedRevision) || committedRevision <= 0) {
      throw new Error(`无法解析当前工作副本版本号：${revisionText}`);
    }

    const previousRevision = Math.max(committedRevision - 1, 0);
    const pegRevision = Math.max(previousRevision, 1);
    const encodedPath = p
      .replace(/\\/g, "/")
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const fileUrl = `${workingCopyUrl}/${encodedPath}`;

    return await this.run(["diff", "--force", "-r", `${previousRevision}:${committedRevision}`, `${fileUrl}@${pegRevision}`]);
  }

  // ------------------------------------------------------------------
  // 私有：输入校验
  // ------------------------------------------------------------------

  /**
   * 路径/文本校验。
   *
   * v0.2.0 收窄到**真实风险面**：命令通过 `execFile` 执行（无 shell），因此 `& ; | $ \``
   * 等 shell 元字符并不构成注入——旧版一律拒绝，反而让 `a&b.md`、`a;b.md` 这类合法文件名
   * 无法提交（Windows 允许这些字符）。现只拒绝控制字符（NUL/CR/LF），
   * 参数注入由 `safePathArg`（`-` 前缀与 `@` 转义）负责。
   */
  private validateInput(input: string, context: string): void {
    if (!input) {
      return;
    }
    if (/[\u0000\r\n]/.test(input)) {
      this.debugLog("[svn-client] 输入校验拦截", { context, reason: "包含控制字符" });
      throw new Error(`输入验证失败：${context} 包含非法控制字符`);
    }
  }

  private validatePaths(paths: string[]): void {
    for (const p of paths) {
      this.validateInput(p, `文件路径 "${p}"`);
    }
  }

  /** 版本参数校验：BASE/HEAD/PREV/COMMITTED/数字/{日期} */
  private validateRevision(rev: string): void {
    const value = rev.trim();
    if (!/^(BASE|HEAD|PREV|COMMITTED|\d+|\{[^}]+\})$/.test(value)) {
      throw new Error(`版本参数非法：${rev}`);
    }
  }

  private validateCommitMessage(message: string): void {
    if (message.includes("\u0000")) {
      this.debugLog("[svn-client] 提交备注校验拦截", { reason: "包含空字符", messageLength: message.length });
      throw new Error("输入验证失败：提交备注包含非法字符");
    }
    // 允许换行与制表符（多行提交信息），其余 C0 控制符拒绝
    if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(message)) {
      this.debugLog("[svn-client] 提交备注校验拦截", { reason: "包含非法控制字符", messageLength: message.length });
      throw new Error("输入验证失败：提交备注包含非法控制字符");
    }
  }
}

/** 目录是否为 SVN 工作副本（委托 SvnClient，保持同一二进制探测与解码逻辑） */
export async function isSvnWorkingCopy(cwd: string): Promise<boolean> {
  return new SvnClient(cwd).isWorkingCopy();
}

/** 同步流程结果 */
export interface RunSyncResult {
  snapshot: SnapshotInfo;
  changes: ChangeItem[];
  ok: boolean;
  message: string;
  revOld: string | null;
  /** 本次 update 带出的冲突（v0.2.0 新增字段，向后兼容） */
  conflicts: UpdateConflict[];
}

/**
 * 执行一次完整同步：① 检测可用 ② 取基线版本 ③ svn update ④ 收集变更。
 *
 * v0.2.0 修复：
 * - `repoDir` 传绝对路径时不再拼成 `cwd/C:/abs/repo`（旧版静默回退 cwd 且无提示）；
 * - update 带出冲突时不再报「完成且无冲突」：`ok` 置 false 并在 message 中给出冲突数；
 * - `snapshot.date` 使用本地时区 ISO（旧版是 UTC，而注释写「最近同步时间」）；
 * - svn 不可用的提示同时给出「工作副本路径可能不存在」这一可能（Node 对两者都报 ENOENT）。
 */
export async function runSync(cwd: string, repoDir = ""): Promise<RunSyncResult> {
  const isAbsolute = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
  const joinDir = (base: string, sub: string): string => {
    if (isAbsolute(sub)) {
      return sub.replace(/\\/g, "/");
    }
    return `${base.replace(/[\\/]+$/, "")}/${sub.replace(/^[\\/]+/, "")}`;
  };

  // 探测真实工作副本根：cwd → cwd/repoDir（repoDir 提供时），首个成功的路径作为执行基准
  const probePaths = repoDir ? [cwd, joinDir(cwd, repoDir)] : [cwd];
  let baseCwd = cwd;
  for (const p of probePaths) {
    const root = await new SvnClient(p).getWorkingCopyRoot();
    if (root) {
      baseCwd = root;
      break;
    }
  }

  const client = new SvnClient(baseCwd);
  const emptySnapshot = (): SnapshotInfo => ({ revision: "—", date: localIsoTimestamp(), changedFiles: 0 });

  if (!(await client.isAvailable())) {
    return {
      snapshot: emptySnapshot(),
      changes: [],
      ok: false,
      message:
        "本机未检测到 svn 命令，无法执行同步。请先安装 svn 命令行客户端（如 TortoiseSVN 勾选 Command line client tools）；" +
        `若已安装，请确认工作副本路径存在且可访问：${baseCwd}`,
      revOld: null,
      conflicts: [],
    };
  }

  const revOld = await client.getRevision();
  if (!revOld) {
    return {
      snapshot: emptySnapshot(),
      changes: [],
      ok: false,
      message: "无法获取 SVN 版本号，确认仓库为 SVN 工作副本。",
      revOld: null,
      conflicts: [],
    };
  }

  // 直接 update：仓库为 md 等纯文本文件，本地未提交变更不阻塞
  // （svn 自动合并；冲突不会让 update 失败，故必须显式读取冲突，见下方 conflicts 处理）
  let updOk = true;
  let updError = "";
  let updateResult: UpdateResult | null = null;
  try {
    updateResult = await client.update();
  } catch (error) {
    updOk = false;
    updError = (error as Error).message;
  }

  const revNew = (await client.getRevision()) ?? revOld;
  let items: ChangeItem[] = [];
  let changedFiles: string[] = [];
  try {
    ({ items, changedFiles } = await client.collectChanges(revOld, revNew));
  } catch (error) {
    updOk = false;
    const collectMsg = (error as Error).message;
    updError = updError ? `${updError}；变更收集失败：${collectMsg}` : `变更收集失败：${collectMsg}`;
  }

  const conflicts = updateResult?.conflicts ?? [];
  const conflictSuffix = conflicts.length > 0 ? `（存在 ${conflicts.length} 个冲突，需人工解决）` : "";
  if (conflicts.length > 0) {
    updOk = false;
  }

  return {
    snapshot: {
      revision: revNew,
      date: localIsoTimestamp(),
      changedFiles: changedFiles.length,
    },
    changes: items,
    ok: updOk,
    message: updOk
      ? `svn update 完成：r${revOld} → r${revNew}`
      : updError
        ? `svn update 异常：${updError}`
        : `svn update 完成但存在冲突：r${revOld} → r${revNew}${conflictSuffix}`,
    revOld,
    conflicts,
  };
}
