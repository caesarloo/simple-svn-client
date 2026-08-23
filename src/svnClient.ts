/**
 * @caesarloo/simple-svn-client · 统一 SVN 客户端
 *
 * 以 vault-svn 插件（obsidian-svn）的 SvnClient 为基座，合并 ai-pm-tool 的
 * 日志/区间/摘要/cat/自动 add 提交能力，形成两个插件共用的纯 Node 封装。
 *
 * 特性：
 * - 调系统 svn 命令行（不打包二进制），自动探测常见安装路径 + PATH
 * - Windows 下输出为 GBK，用 iconv-lite 多编码启发式解码 + mojibake 修复
 * - 命令注入/路径遍历输入校验、密码参数脱敏
 * - 失败抛错（含解码后的 stderr），XML 输出严格按 UTF-8 解析
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import { parseFrontmatter } from "./frontmatter";
import type { SvnStatusEntry, SvnStatusKind, SvnDiff, UpdateResult, UpdateEntry, DiffLine, LogEntry, ChangeItem, SnapshotInfo } from "./types";

const execFileAsync = promisify(execFile);
type SupportedEncoding = "utf8" | "gbk" | "gb18030" | "latin1";

/** 底层命令执行结果（不抛错，调用方检查 code） */
export interface SvnExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** svn 命令失败异常（携带原始 stderr 与退出码） */
export class SvnError extends Error {
  constructor(message: string, public stderr: string, public code: number) {
    super(message);
  }
}

/** 执行 svn 命令（不抛错）；仅普通文本输出（status/update/diff 等）按 Windows GBK 解码，--xml 与 cat 输出为 UTF-8 */
export function execSvn(args: string[], cwd: string, timeoutMs = 60000): Promise<SvnExecResult> {
  return new Promise((resolve) => {
    execFile(
      "svn",
      args,
      { cwd, encoding: "buffer" as "buffer", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (err, stdoutBuf, stderrBuf) => {
        const isXml = args.includes("--xml");
        const isCat = args[0] === "cat";
        const decode = (buf: Buffer) =>
          process.platform === "win32" && !isXml && !isCat ? iconv.decode(buf, "gbk") : buf.toString("utf8");
        const code = err ? (err as { code?: number }).code ?? 1 : 0;
        resolve({
          stdout: decode(stdoutBuf as Buffer),
          stderr: decode(stderrBuf as Buffer),
          code,
        });
      }
    );
  });
}

/** SvnClient 构造选项 */
export interface SvnClientOptions {
  /** svn 可执行文件路径；留空则自动探测 PATH + 常见安装路径（如 TortoiseSVN） */
  svnBinaryPath?: string;
  /** 是否输出调试日志（默认 false） */
  enableDebugLog?: boolean;
  /** 单条命令超时（毫秒），默认 60000；传 0 表示不设超时 */
  timeoutMs?: number;
}

/** commit 选项 */
export interface CommitOptions {
  /** 提交失败且提示文件未纳入版本控制时，自动 svn add 后重试一次（默认 false） */
  autoAdd?: boolean;
}

export class SvnClient {
  private readonly svnBinaryPath: string;
  private readonly enableDebugLog: boolean;
  private readonly timeoutMs: number;

  constructor(
    private readonly workingCopyPath: string,
    options: SvnClientOptions = {}
  ) {
    this.svnBinaryPath = options.svnBinaryPath ?? "";
    this.enableDebugLog = options.enableDebugLog ?? false;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  private debugLog(message: string, details?: unknown): void {
    if (!this.enableDebugLog) {
      return;
    }
    if (details === undefined) {
      console.debug(message);
      return;
    }
    console.debug(message, details);
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

  /** 目录是否为 SVN 工作副本（svn info 成功） */
  async isWorkingCopy(): Promise<boolean> {
    try {
      await this.run(["info"]);
      return true;
    } catch {
      return false;
    }
  }

  /** 工作副本状态（使用 XML 输出避免命令行编码导致的文件名乱码） */
  async status(): Promise<SvnStatusEntry[]> {
    const xml = await this.runRawUtf8(["status", "--xml"]);
    const entries = this.parseStatusXml(xml);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  /** svn update，返回解析后的更新结果；失败抛错 */
  async update(): Promise<UpdateResult> {
    const output = await this.run(["update"]);
    return this.parseUpdateOutput(output);
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
          output = await this.runRawUtf8(["diff", "--force", "-r", "PREV:COMMITTED", filePath]);
        } catch {
          try {
            output = await this.runRawUtf8(["diff", "--force", "-r", "0:COMMITTED", filePath]);
          } catch {
            output = await this.diffViaRepositoryUrl(filePath);
          }
        }
      }
    } else {
      try {
        output = await this.runRawUtf8(["diff", "--force", filePath]);
      } catch {
        // 新增/未纳入版本控制文件无法生成 svn diff，降级为直接显示文件内容
        return await this.buildFileContentDiff(filePath);
      }
    }

    return this.parseDiffOutput(filePath, output, compareWithPrevious ? "previous-revision" : "working-copy");
  }

  /** svn diff -r A:B --summarize：列出两个版本间变更的文件（跳过表头） */
  async diffSummarize(revOld: string, revNew: string): Promise<string[]> {
    const output = await this.run(["diff", "-r", `${revOld}:${revNew}`, "--summarize"]);
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[MADRC!~?]\s+\S/.test(l));
  }

  /** svn cat -r rev path：读取某版本的文件内容；失败返回 null */
  async cat(rev: string, filePath: string): Promise<string | null> {
    try {
      return await this.run(["cat", "-r", rev, filePath]);
    } catch {
      return null;
    }
  }

  /** svn log -l N --xml：最近 N 条提交（revision/author/date/message） */
  async log(limit = 20): Promise<LogEntry[]> {
    const xml = await this.runRawUtf8(["log", "-l", String(limit), "--xml"]);
    return this.parseLogXml(xml);
  }

  /** svn log -r OLD:NEW --xml -v：区间内全部提交，含变更路径 */
  async logRange(revOld: string, revNew: string): Promise<LogEntry[]> {
    const xml = await this.runRawUtf8(["log", "-r", `${revOld}:${revNew}`, "--xml", "-v"]);
    return this.parseLogXml(xml);
  }

  async add(paths: string[]): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    return await this.run(["add", "--force", ...paths]);
  }

  async delete(paths: string[]): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    return await this.run(["delete", ...paths]);
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
    args.push(...paths);
    return await this.run(args);
  }

  async resolve(paths: string[]): Promise<string> {
    if (!paths.length) {
      return "";
    }
    this.validatePaths(paths);
    return await this.run(["resolve", "--accept", "working", ...paths]);
  }

  /**
   * 提交（失败抛错）。
   * - 不能使用 `--` 分隔（会把 -m 也当作路径）；路径以 - 开头时加 ./ 前缀防被当选项
   * - autoAdd: 未纳入版本控制的新文件（E200009/W200005）自动 svn add 后重试一次
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

    const safePaths = paths.map((p) => (p.startsWith("-") ? "./" + p : p));
    const run = () => this.run(["commit", ...safePaths, "-m", message]);

    try {
      return await run();
    } catch (error) {
      if (options.autoAdd && /not under version control|E200009|W200005/i.test((error as Error).message)) {
        const statusOutput = await this.run(["status", ...safePaths]);
        const unversioned = statusOutput
          .split(/\r?\n/)
          .filter((l) => /^\?\s+/.test(l))
          .map((l) => l.replace(/^\?\s+/, "").trim())
          .filter(Boolean);
        if (unversioned.length > 0) {
          await this.run(["add", "--parents", ...unversioned]);
          return await run();
        }
      }
      throw error;
    }
  }

  /** 单个文件两个版本间的 frontmatter 字段差异（文件/字段/基线/工作区） */
  async diffFrontmatterFields(path: string, revOld: string, revNew: string): Promise<ChangeItem[]> {
    const baseText = await this.cat(revOld, path);
    const workText = await this.cat(revNew, path);
    if (baseText === null && workText === null) return [];
    if (baseText === null || workText === null) {
      // 文件新增或删除
      return [
        {
          file: path.split("/").pop() ?? path,
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
      v === null || v === undefined ? "" : Array.isArray(v) ? v.join("、") : String(v);
    for (const k of keys) {
      const b = fmt(base[k]);
      const w = fmt(work[k]);
      if (b !== w) {
        items.push({
          file: path.split("/").pop() ?? path,
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

  /** 汇总变更条目（两版本间全部变更，含提交者与版本号逐文件归属） */
  async collectChanges(
    revOld: string,
    revNew: string
  ): Promise<{ items: ChangeItem[]; changedFiles: string[] }> {
    const files = await this.diffSummarize(revOld, revNew);
    const items: ChangeItem[] = [];
    const changedFiles: string[] = [];
    // 提交者与版本号：用 -v 日志（含 changed paths）按文件路径精确归属
    const logs = await this.logRange(revOld, revNew);
    const logsDesc = [...logs].sort((a, b) => Number(b.revision) - Number(a.revision));
    for (const f of files) {
      const m = /^([MADRC!~?])\s+(.+)$/.exec(f);
      const filePath = m ? m[2].trim() : "";
      if (!filePath || filePath.startsWith(".")) continue;
      changedFiles.push(filePath);
      // 从含路径的日志中找影响该文件的最近提交
      let info: { revision: string; author: string } | null = null;
      for (const lg of logsDesc) {
        if (lg.paths.some((p) => p.endsWith(filePath))) {
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
  // 私有：命令执行
  // ------------------------------------------------------------------

  private maskSensitiveArgs(args: string[]): string[] {
    const safeArgs = [...args];
    const passwordIndex = safeArgs.indexOf("--password");
    if (passwordIndex >= 0 && passwordIndex + 1 < safeArgs.length) {
      safeArgs[passwordIndex + 1] = "******";
    }
    return safeArgs;
  }

  private getBinaryCandidates(): string[] {
    const configured = this.svnBinaryPath.trim();
    const candidates: string[] = [];

    if (configured) {
      candidates.push(configured);
    }

    if (!configured || configured.toLowerCase() !== "svn") {
      candidates.push("svn");
    }

    if (process.platform === "win32") {
      candidates.push(
        "C:/Program Files/TortoiseSVN/bin/svn.exe",
        "C:/Program Files/SlikSvn/bin/svn.exe",
        "C:/Program Files/VisualSVN Server/bin/svn.exe",
        "C:/Program Files (x86)/SlikSvn/bin/svn.exe",
        "C:/Program Files (x86)/CollabNet Subversion Client/svn.exe"
      );
    }

    return [...new Set(candidates)];
  }

  private async discoverFromSystemPath(): Promise<string[]> {
    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("where", ["svn"], {
          windowsHide: true,
          maxBuffer: 1024 * 1024
        });
        return (stdout ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }

      const { stdout } = await execFileAsync("which", ["svn"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      return (stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private isCommandName(binary: string): boolean {
    return !binary.includes("/") && !binary.includes("\\") && !binary.includes(":");
  }

  private async existsExecutable(binary: string): Promise<boolean> {
    if (this.isCommandName(binary)) {
      return true;
    }

    const normalized = binary.replace(/\\/g, "/");
    if (!path.isAbsolute(normalized)) {
      return false;
    }

    try {
      await access(normalized, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveBinaryCandidates(): Promise<string[]> {
    const baseCandidates = this.getBinaryCandidates();
    const discovered = await this.discoverFromSystemPath();
    const merged = [...baseCandidates, ...discovered];

    const deduped = merged.filter((item, index) => {
      const normalized = process.platform === "win32" ? item.toLowerCase() : item;
      return merged.findIndex((other) => (process.platform === "win32" ? other.toLowerCase() : other) === normalized) === index;
    });

    const available: string[] = [];
    for (const candidate of deduped) {
      if (await this.existsExecutable(candidate)) {
        available.push(candidate);
      }
    }

    return available;
  }

  private buildBinaryNotFoundError(candidates: string[]): Error {
    const message = [
      "未找到 svn 可执行文件。",
      `已尝试：${candidates.join(" | ")}`,
      "请在设置中配置 svn.exe 的绝对路径（例如 C:/Program Files/TortoiseSVN/bin/svn.exe）。",
      "若安装 TortoiseSVN，请在安装时勾选“Command line client tools”组件。"
    ].join(" ");
    return new Error(message);
  }

  /** 普通文本输出：多编码启发式解码（Windows GBK 兼容） */
  private async run(args: string[]): Promise<string> {
    const finalArgs = [...args];

    const safeArgs = this.maskSensitiveArgs(finalArgs);
    const binaries = await this.resolveBinaryCandidates();

    for (const binary of binaries) {
      this.debugLog("[svn-client] 执行命令", {
        binary,
        args: safeArgs,
        cwd: this.workingCopyPath
      });

      try {
        const { stdout } = await execFileAsync(binary, finalArgs, {
          cwd: this.workingCopyPath,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.timeoutMs || undefined,
          encoding: "buffer" as const
        });
        const decodedOutput = this.decodeBuffer(stdout as Buffer | string | undefined);

        this.debugLog("[svn-client] 命令执行成功", {
          binary,
          args: safeArgs,
          stdoutLength: decodedOutput.length
        });
        return decodedOutput;
      } catch (error) {
        const err = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string; code?: string | number };

        if (err.code === "ENOENT") {
          console.warn("[svn-client] svn 可执行文件未找到，尝试下一个候选", {
            binary,
            args: safeArgs,
            message: err.message
          });
          continue;
        }

        console.error("[svn-client] 命令执行失败", {
          binary,
          args: safeArgs,
          code: err.code,
          stderr: this.decodeBuffer(err.stderr),
          stdout: this.decodeBuffer(err.stdout),
          message: err.message
        });
        const message = this.decodeBuffer(err.stderr).trim() || err.message || "SVN 命令执行失败";
        throw new Error(message);
      }
    }

    console.error("[svn-client] 所有 svn 候选路径均不可用", {
      binaries,
      args: safeArgs,
      cwd: this.workingCopyPath
    });
    throw this.buildBinaryNotFoundError(binaries);
  }

  /** XML 输出：明确按 UTF-8 解码，不通过 repair 流程，避免 xml 标签被错误替换 */
  private async runRawUtf8(args: string[]): Promise<string> {
    const finalArgs = [...args];

    const binaries = await this.resolveBinaryCandidates();
    const safeArgs = this.maskSensitiveArgs(finalArgs);

    for (const binary of binaries) {
      this.debugLog("[svn-client] 执行命令 (raw utf8)", { binary, args: safeArgs, cwd: this.workingCopyPath });
      try {
        const { stdout } = await execFileAsync(binary, finalArgs, {
          cwd: this.workingCopyPath,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.timeoutMs || undefined,
          encoding: "buffer" as const
        });
        const text = iconv.decode(stdout, "utf8");
        this.debugLog("[svn-client] 命令执行成功 (raw utf8)", { binary, args: safeArgs, stdoutLength: text.length });
        return text;
      } catch (error) {
        const err = error as Error & { code?: string | number; stderr?: Buffer | string };
        if (err.code === "ENOENT") {
          console.warn("[svn-client] svn 可执行文件未找到 (raw utf8)，尝试下一个候选", { binary, args: safeArgs, message: err.message });
          continue;
        }
        console.error("[svn-client] 命令执行失败 (raw utf8)", { binary, args: safeArgs, code: err.code, message: err.message });
        const message = err.message || "SVN 命令执行失败";
        throw new Error(message);
      }
    }
    throw this.buildBinaryNotFoundError(binaries);
  }

  // ------------------------------------------------------------------
  // 私有：解析
  // ------------------------------------------------------------------

  private parseStatusXml(xml: string): SvnStatusEntry[] {
    const entries: SvnStatusEntry[] = [];
    if (!xml) return entries;
    // 匹配 <entry path="..."> ... <wc-status item="modified" .../>
    const entryRe = /<entry\s+path="([^"]+)">([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml))) {
      const pathAttr = m[1];
      const inner = m[2];
      const wcMatch = inner.match(/<wc-status[^>]*item="([^"]+)"/);
      const item = wcMatch ? wcMatch[1] : "";
      const normalizedPath = pathAttr.replace(/\\/g, "/");
      const splitIndex = normalizedPath.lastIndexOf("/");
      const fileName = splitIndex >= 0 ? normalizedPath.slice(splitIndex + 1) : normalizedPath;
      const folderPath = splitIndex >= 0 ? normalizedPath.slice(0, splitIndex) : "";
      const status = this.mapStatusFromItem(item);
      if (status) {
        entries.push({ path: normalizedPath, fileName, folderPath, status });
      }
    }
    return entries;
  }

  private mapStatusFromItem(item: string): SvnStatusKind | null {
    switch (item) {
      case "added":
      case "external":
        return "added";
      case "modified":
        return "modified";
      case "deleted":
        return "deleted";
      case "conflicted":
        return "conflict";
      case "unversioned":
        return "untracked";
      case "missing":
        return "missing";
      default:
        return null;
    }
  }

  private parseUpdateOutput(output: string): UpdateResult {
    const lines = output.split(/\r?\n/).filter(Boolean);
    const entries: UpdateEntry[] = [];
    const summary = {
      total: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      totalSize: 0
    };

    for (const line of lines) {
      const match = line.match(/^(A|U|D)\s+(.+)$/);
      if (match) {
        const [, status, p] = match;
        let statusType: UpdateEntry["status"] = "unchanged";

        switch (status) {
          case "A":
            statusType = "added";
            summary.added++;
            break;
          case "U":
            statusType = "modified";
            summary.modified++;
            break;
          case "D":
            statusType = "deleted";
            summary.deleted++;
            break;
        }

        entries.push({
          path: p.replace(/\\/g, "/"),
          status: statusType
        });
      }
    }

    summary.total = entries.length;
    return { entries, summary };
  }

  private parseDiffOutput(filePath: string, output: string, compareMode: "working-copy" | "previous-revision"): SvnDiff {
    const lines = output.split(/\r?\n/);
    const diffLines: DiffLine[] = [];
    const rawDiffLines: DiffLine[] = [];
    let currentLineNumber = 1;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }

      if (line.startsWith("Index: ") || line.startsWith("===")) {
        inHunk = false;
        continue;
      }

      if (line.startsWith("---") || line.startsWith("+++")) {
        continue;
      }

      if (!inHunk) {
        continue;
      }

      if (line.startsWith("+")) {
        const content = this.repairLikelyUtf8Mojibake(line.substring(1));
        const parsed: DiffLine = {
          lineNumber: currentLineNumber,
          content,
          type: "added"
        };
        diffLines.push(parsed);
        rawDiffLines.push(parsed);
        currentLineNumber++;
      } else if (line.startsWith("-")) {
        const content = this.repairLikelyUtf8Mojibake(line.substring(1));
        const parsed: DiffLine = {
          lineNumber: currentLineNumber,
          content,
          type: "deleted"
        };
        diffLines.push(parsed);
        rawDiffLines.push(parsed);
      } else if (line.startsWith(" ")) {
        const content = this.repairLikelyUtf8Mojibake(line.substring(1));
        const parsed: DiffLine = {
          lineNumber: currentLineNumber,
          content,
          type: "unchanged"
        };
        diffLines.push(parsed);
        rawDiffLines.push(parsed);
        currentLineNumber++;
      }
    }

    const normalizedDiffLines = this.normalizeDiffLines(diffLines);
    const hasRawChanges = rawDiffLines.some((line) => line.type === "added" || line.type === "deleted");
    const hasNormalizedChanges = normalizedDiffLines.some((line) => line.type === "added" || line.type === "deleted");

    if (hasRawChanges && !hasNormalizedChanges) {
      this.debugLog("[svn-client] 差异归一化后无实质变更，忽略纯格式差异", {
        filePath,
        rawLineCount: rawDiffLines.length,
        normalizedLineCount: normalizedDiffLines.length
      });
    }

    return {
      filePath,
      lines: normalizedDiffLines,
      compareMode
    };
  }

  private normalizeDiffLines(lines: DiffLine[]): DiffLine[] {
    const result: DiffLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const current = lines[i];
      const next = lines[i + 1];

      if ((current.type === "added" || current.type === "deleted") && this.isMarkdownSeparatorLine(current.content)) {
        continue;
      }

      if (this.isWhitespaceOnlyLine(current) && (current.type === "added" || current.type === "deleted")) {
        continue;
      }

      if (
        current.type === "deleted" &&
        next &&
        next.type === "added" &&
        this.normalizeForWhitespaceCompare(current.content) === this.normalizeForWhitespaceCompare(next.content)
      ) {
        result.push({
          lineNumber: current.lineNumber,
          content: next.content,
          type: "unchanged"
        });
        i += 1;
        continue;
      }

      result.push(current);
    }

    return this.cancelEquivalentDiffLines(result);
  }

  private cancelEquivalentDiffLines(lines: DiffLine[]): DiffLine[] {
    const deletedMap = new Map<string, number[]>();
    const addedMap = new Map<string, number[]>();
    const cancelled = new Set<number>();

    lines.forEach((line, index) => {
      if (line.type !== "added" && line.type !== "deleted") {
        return;
      }

      const key = this.normalizeForWhitespaceCompare(line.content);
      if (!key) {
        return;
      }

      if (line.type === "deleted") {
        const queue = deletedMap.get(key) ?? [];
        queue.push(index);
        deletedMap.set(key, queue);
        return;
      }

      const queue = addedMap.get(key) ?? [];
      queue.push(index);
      addedMap.set(key, queue);
    });

    deletedMap.forEach((deletedIndexes, key) => {
      const addedIndexes = addedMap.get(key) ?? [];
      const pairCount = Math.min(deletedIndexes.length, addedIndexes.length);
      for (let i = 0; i < pairCount; i++) {
        cancelled.add(deletedIndexes[i]);
        cancelled.add(addedIndexes[i]);
      }
    });

    return lines.filter((_, index) => !cancelled.has(index));
  }

  private normalizeForWhitespaceCompare(content: string): string {
    return content.replace(/\s+/g, "");
  }

  private repairLikelyUtf8Mojibake(content: string): string {
    if (!content) {
      return content;
    }

    const mojibakeHint = /[\u00C0-\u00FF]{2,}|(?:Ã.|Â.|æ.|ç.|å.|ä.|é.|è.|ï.)/.test(content);
    if (!mojibakeHint) {
      return content;
    }

    const repaired = this.safeRecode(content, "latin1", "utf8");
    if (!repaired || repaired === content) {
      return content;
    }

    const originalCjk = this.countCjk(content);
    const repairedCjk = this.countCjk(repaired);
    const originalReplacement = this.countReplacementChars(content);
    const repairedReplacement = this.countReplacementChars(repaired);

    if (repairedCjk > originalCjk && repairedReplacement <= originalReplacement) {
      return repaired;
    }

    return content;
  }

  private isMarkdownSeparatorLine(content: string): boolean {
    const trimmed = content.trim();
    return trimmed === "---";
  }

  private isWhitespaceOnlyLine(line: DiffLine): boolean {
    return this.normalizeForWhitespaceCompare(line.content).length === 0;
  }

  private async buildFileContentDiff(relativePath: string): Promise<SvnDiff> {
    const fullPath = path.join(this.workingCopyPath, relativePath);
    const fileBuffer = await readFile(fullPath);

    if (this.isLikelyBinaryFile(fileBuffer)) {
      throw new Error(`该文件可能为二进制文件，暂不支持文本预览：${relativePath}`);
    }

    const text = this.decodeBuffer(fileBuffer);
    const lines = text.split(/\r?\n/);

    const parsedLines: DiffLine[] = lines.map((content, index) => ({
      lineNumber: index + 1,
      content,
      type: "unchanged"
    }));

    return {
      filePath: relativePath,
      lines: parsedLines,
      compareMode: "file-content"
    };
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
    const workingCopyUrl = (await this.runRawUtf8(["info", "--show-item", "url"])).trim().replace(/\/+$/g, "");
    const revisionText = (await this.runRawUtf8(["info", "--show-item", "revision"])).trim();
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

    return await this.runRawUtf8([
      "diff",
      "--force",
      "-r",
      `${previousRevision}:${committedRevision}`,
      `${fileUrl}@${pegRevision}`
    ]);
  }

  private parseLogXml(xml: string): LogEntry[] {
    const out: LogEntry[] = [];
    const revs = xml.split(/<logentry\b/).slice(1);
    for (const revXml of revs) {
      const rev = /revision="(\d+)"/.exec(revXml)?.[1] ?? "";
      const author = /<author>([\s\S]*?)<\/author>/.exec(revXml)?.[1] ?? "";
      const date = /<date>([\s\S]*?)<\/date>/.exec(revXml)?.[1] ?? "";
      const msg = /<msg>([\s\S]*?)<\/msg>/.exec(revXml)?.[1] ?? "";
      // 注意：`<paths>` 包裹层也会被 <path[^>]*> 匹配，须排除其后紧跟 s 的 <paths>，
      // 避免捕获组吞进 <paths><path ...> 前缀
      const paths = [...(revXml.matchAll(/<path(?:\s[^>]*)?>([\s\S]*?)<\/path>/g) ?? [])].map((m) => m[1].trim());
      if (rev) out.push({ revision: rev, author, date, message: msg, paths });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 私有：输入校验
  // ------------------------------------------------------------------

  private validateInput(input: string, context: string): void {
    if (!input) {
      return;
    }

    // 检查是否包含危险字符或命令注入尝试
    const dangerousPatterns = [
      /[;&|`$<>\n\r]/g, // shell 元字符
      /\.\.\//g, // 路径遍历
      /\/\*|\*\//g, // 注释
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(input)) {
        this.debugLog("[svn-client] 输入校验拦截", {
          context,
          pattern: pattern.toString(),
          preview: input.slice(0, 120)
        });
        throw new Error(`输入验证失败：${context} 包含危险字符`);
      }
    }
  }

  private validatePaths(paths: string[]): void {
    for (const p of paths) {
      this.validateInput(p, `文件路径 "${p}"`);
    }
  }

  private validateCommitMessage(message: string): void {
    if (message.includes("\u0000")) {
      this.debugLog("[svn-client] 提交备注校验拦截", {
        reason: "包含空字符",
        messageLength: message.length
      });
      throw new Error("输入验证失败：提交备注包含非法字符");
    }

    if (this.hasInvalidControlChars(message, false)) {
      this.debugLog("[svn-client] 提交备注校验拦截", {
        reason: "包含非法控制字符",
        messageLength: message.length
      });
      throw new Error("输入验证失败：提交备注包含非法控制字符");
    }
  }

  // ------------------------------------------------------------------
  // 私有：编码解码
  // ------------------------------------------------------------------

  private decodeBuffer(input: Buffer | string | undefined): string {
    if (input === undefined) {
      return "";
    }
    if (typeof input === "string") {
      return input;
    }

    const utf8 = iconv.decode(input, "utf8");
    const gbk = iconv.decode(input, "gbk");
    const gb18030 = iconv.decode(input, "gb18030");
    const latin1 = iconv.decode(input, "latin1");

    const candidates: Array<{
      source: string;
      text: string;
      score: number;
      replacementCount: number;
      cjkCount: number;
      sample: string;
    }> = [
      { source: "utf8", text: utf8, score: this.getDecodeScore(utf8), replacementCount: this.countReplacementChars(utf8), cjkCount: this.countCjk(utf8), sample: utf8.slice(0, 60) },
      { source: "gbk", text: gbk, score: this.getDecodeScore(gbk), replacementCount: this.countReplacementChars(gbk), cjkCount: this.countCjk(gbk), sample: gbk.slice(0, 60) },
      { source: "gb18030", text: gb18030, score: this.getDecodeScore(gb18030), replacementCount: this.countReplacementChars(gb18030), cjkCount: this.countCjk(gb18030), sample: gb18030.slice(0, 60) },
      { source: "latin1", text: latin1, score: this.getDecodeScore(latin1), replacementCount: this.countReplacementChars(latin1), cjkCount: this.countCjk(latin1), sample: latin1.slice(0, 60) },
      { source: "repair:gbk->utf8", text: this.safeRecode(gbk, "gbk", "utf8"), score: 0, replacementCount: 0, cjkCount: 0, sample: "" },
      { source: "repair:gb18030->utf8", text: this.safeRecode(gb18030, "gb18030", "utf8"), score: 0, replacementCount: 0, cjkCount: 0, sample: "" }
    ];

    // 计算修复链的分数与统计
    for (const candidate of candidates) {
      if (candidate.source.startsWith("repair:")) {
        candidate.score = this.getDecodeScore(candidate.text);
        candidate.replacementCount = this.countReplacementChars(candidate.text);
        candidate.cjkCount = this.countCjk(candidate.text);
        candidate.sample = candidate.text.slice(0, 60);
      }
    }

    // 去重相同文本
    const uniqueCandidates = candidates.filter((candidate, index, array) => array.findIndex((other) => other.text === candidate.text) === index);

    // 优先 replacementCount 最低的候选，再在这些候选中按 cjkCount 降序选择
    const minReplacement = Math.min(...uniqueCandidates.map((c) => c.replacementCount));
    const filtered = uniqueCandidates.filter((c) => c.replacementCount === minReplacement);
    filtered.sort((a, b) => b.cjkCount - a.cjkCount || a.score - b.score);
    // 如果候选集中包含 utf8，则优先选择 utf8（在替换字符相同的已筛选集合中）
    const utf8Preferred = filtered.find((c) => c.source === "utf8");
    const best = utf8Preferred ?? filtered[0] ?? uniqueCandidates[0];

    let repaired = this.repairMojibakeLines(best.text);

    // 若最佳结果仍有 mojibake 或替换字符，进行全缓冲区修复尝试（跨多种编码组合）
    const repairedReplacementCount = this.countReplacementChars(repaired.text);
    if (this.hasMojibakeHint(repaired.text) || repairedReplacementCount > 0) {
      const pool: Array<{ name: SupportedEncoding; text: string }> = [
        { name: "utf8", text: utf8 },
        { name: "gbk", text: gbk },
        { name: "gb18030", text: gb18030 },
        { name: "latin1", text: latin1 }
      ];
      const fullCandidates: Array<{ source: string; text: string; replacement: number; score: number; cjk: number }> = [];
      // include originals
      for (const p of pool) {
        fullCandidates.push({ source: p.name, text: p.text, replacement: this.countReplacementChars(p.text), score: this.getDecodeScore(p.text), cjk: this.countCjk(p.text) });
      }
      // try pairwise recoding
      for (const from of pool) {
        for (const to of pool) {
          if (from.name === to.name) continue;
          try {
            const t = this.safeRecode(from.text, from.name, to.name);
            fullCandidates.push({ source: `${from.name}->${to.name}`, text: t, replacement: this.countReplacementChars(t), score: this.getDecodeScore(t), cjk: this.countCjk(t) });
          } catch {
            // ignore
          }
        }
      }
      // choose best: minimal replacement, then minimal score, then max cjk
      fullCandidates.sort((a, b) => {
        if (a.replacement !== b.replacement) return a.replacement - b.replacement;
        if (a.score !== b.score) return a.score - b.score;
        return b.cjk - a.cjk;
      });
      const fullBest = fullCandidates[0];
      if (fullBest && (fullBest.replacement < repairedReplacementCount || this.countCjk(fullBest.text) > this.countCjk(repaired.text))) {
        const secondPass = this.repairMojibakeLines(fullBest.text);
        this.debugLog("[svn-client] 全缓冲区修复选择", { fullBestSource: fullBest.source, fullBestReplacement: fullBest.replacement, fullBestCjk: fullBest.cjk, secondPassChanged: secondPass.changedCount });
        repaired = secondPass;
      }
    }

    return repaired.text;
  }

  private repairMojibakeLines(text: string): { text: string; changedCount: number; samples: Array<{ before: string; after: string }> } {
    if (!text) {
      return { text, changedCount: 0, samples: [] };
    }

    const lineBreak = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    let changedCount = 0;
    const samples: Array<{ before: string; after: string }> = [];

    const repairedLines = lines.map((line) => {
      if (!this.hasMojibakeHint(line) && this.countReplacementChars(line) === 0) {
        return line;
      }

      const attempts: Array<{ from: SupportedEncoding; to: SupportedEncoding }> = [
        { from: "gbk", to: "utf8" },
        { from: "gb18030", to: "utf8" },
        { from: "latin1", to: "utf8" }
      ];

      const candidates = attempts.map((a) => {
        const text = this.safeRecode(line, a.from, a.to);
        return {
          text,
          from: a.from,
          to: a.to,
          score: this.getDecodeScore(text),
          cjk: this.countCjk(text),
          replacement: this.countReplacementChars(text)
        };
      });

      // include original as candidate too for fair comparison
      candidates.push({ text: line, from: "utf8", to: "utf8", score: this.getDecodeScore(line), cjk: this.countCjk(line), replacement: this.countReplacementChars(line) });

      // choose candidate with minimal score; tie-breaker: maximal cjk, minimal replacement
      candidates.sort((a, b) => {
        if (a.replacement !== b.replacement) return a.replacement - b.replacement;
        if (a.score !== b.score) return a.score - b.score;
        return b.cjk - a.cjk;
      });

      const best = candidates[0];
      const originalScore = this.getDecodeScore(line);
      const originalCjk = this.countCjk(line);

      if (best.text !== line && (best.score <= originalScore || best.cjk >= originalCjk)) {
        changedCount += 1;
        if (samples.length < 3) {
          samples.push({ before: line.slice(0, 120), after: best.text.slice(0, 120) });
        }
        return best.text;
      }

      return line;
    });

    return {
      text: repairedLines.join(lineBreak),
      changedCount,
      samples
    };
  }

  private safeRecode(text: string, from: SupportedEncoding, to: SupportedEncoding): string {
    try {
      return iconv.decode(iconv.encode(text, from), to);
    } catch {
      return text;
    }
  }

  private getDecodeScore(text: string): number {
    const replacementCount = this.countReplacementChars(text);
    const controlCount = this.countInvalidControlChars(text, true);
    const mojibakeHints = (text.match(/[ÃÂÐÊÔ鍙鍚鍏闇璇璐锛锟閭闂]/g) ?? []).length;
    return replacementCount * 20 + controlCount * 5 + mojibakeHints * 3;
  }

  private hasInvalidControlChars(text: string, includeNull: boolean): boolean {
    return this.countInvalidControlChars(text, includeNull) > 0;
  }

  private countInvalidControlChars(text: string, includeNull: boolean): number {
    let count = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code === 0 && includeNull) {
        count += 1;
        continue;
      }
      if ((code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
        count += 1;
      }
    }
    return count;
  }

  private countReplacementChars(text: string): number {
    return (text.match(/\uFFFD/g) ?? []).length;
  }

  private hasMojibakeHint(text: string): boolean {
    return /(?:璐|闇€|鍙|閭|鎴|锛�|锟�|姹|鑳藉姏|閭欢)/.test(text);
  }

  private countCjk(text: string): number {
    return (text.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  }
}

/** 目录是否为 SVN 工作副本（顶层存在 .svn 或父级可查） */
export async function isSvnWorkingCopy(cwd: string): Promise<boolean> {
  const r = await execSvn(["info"], cwd, 15000);
  return r.code === 0;
}

/** 执行一次完整同步：① 检测可用 ② 取基线版本 ③ svn update ④ 收集变更 */
export async function runSync(
  cwd: string,
  _repoDir: string
): Promise<{
  snapshot: SnapshotInfo;
  changes: ChangeItem[];
  ok: boolean;
  message: string;
  revOld: string | null;
}> {
  const client = new SvnClient(cwd);
  if (!(await client.isAvailable())) {
    return {
      snapshot: { revision: "—", date: "", changedFiles: 0 },
      changes: [],
      ok: false,
      message: "本机未检测到 svn 命令，无法执行同步。请先安装 svn 命令行客户端（如 TortoiseSVN 勾选 Command line client tools）。",
      revOld: null,
    };
  }
  const revOld = await client.getRevision();
  if (!revOld) {
    return {
      snapshot: { revision: "—", date: "", changedFiles: 0 },
      changes: [],
      ok: false,
      message: "无法获取 SVN 版本号，确认仓库为 SVN 工作副本。",
      revOld: null,
    };
  }
  // 直接 update：仓库为 md 等纯文本文件，本地未提交变更不阻塞（svn 自动合并，冲突由客户端处理）
  let updOk = true;
  let updError = "";
  try {
    await client.update();
  } catch (error) {
    updOk = false;
    updError = (error as Error).message;
  }
  const revNew = (await client.getRevision()) ?? revOld;
  const { items, changedFiles } = await client.collectChanges(revOld, revNew);
  return {
    snapshot: {
      revision: revNew,
      date: new Date().toISOString(),
      changedFiles: changedFiles.length,
    },
    changes: items,
    ok: updOk,
    message: updOk ? `svn update 完成：r${revOld} → r${revNew}` : `svn update 异常：${updError}`,
    revOld,
  };
}
