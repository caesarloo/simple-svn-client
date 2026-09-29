/**
 * SVN 输出解析器（纯函数，零 I/O、零 child_process）
 *
 * v0.2.0 从 svnClient.ts 的私有方法抽离并重写，目的：
 *   1. 可被真实 svn 输出 fixture 直接单测（旧版只能 mock 整个 child_process 间接测）；
 *   2. 修掉下列解析缺陷（每条都有对应 fixture 用例）：
 *      - update 只认 A/U/D → 现覆盖内容列/属性列/树冲突列（C/G/R/E/B）并产出冲突明细；
 *      - diff 把 hunk 内以 `--`/`++` 开头的内容行当 header 丢弃 → 现仅 hunk 外认 header；
 *      - log 的 author/msg/path 未做 XML 实体解码 → 现统一解码（含数字实体）；
 *      - log 的自闭合 `<path/>` 会把下一个 `<path>` 标签吞进内容 → 现先剔除自闭合标签；
 *      - status 只读 item 属性 → 现同时读 props / tree-conflicted / revision；
 *      - status 遇到截断 XML 会吞掉后一个 entry → 现按 logentry/entry 分段解析，绝不跨段。
 */
import type {
  DiffLine,
  LogEntry,
  SvnDiff,
  SvnStatusEntry,
  SvnStatusKind,
  UpdateConflict,
  UpdateEntry,
  UpdateEntryStatus,
  UpdateResult,
} from "./types";

// ---------------------------------------------------------------------------
// XML 实体
// ---------------------------------------------------------------------------

/** 解码 XML 实体（命名 + 数字）。`&amp;` 放最后，避免二次解码 `&amp;quot;` 之类的嵌套 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    })
    .replace(/&amp;/g, "&");
}

/** 取 `&lt;tag&gt;...&lt;/tag&gt;` 的文本内容（已 trim + entity 解码）；不存在返回 null */
function readXmlTag(scope: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(scope);
  if (!match) {
    return null;
  }
  return decodeXmlEntities(match[1]).trim();
}

// ---------------------------------------------------------------------------
// status --xml
// ---------------------------------------------------------------------------

/** wc-status item → SvnStatusKind（extended 模式） */
function mapItemToStatus(item: string): SvnStatusKind | null {
  switch (item) {
    case "added":
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
    case "replaced":
      return "replaced";
    case "obstructed":
      return "obstructed";
    case "incomplete":
      return "incomplete";
    case "external":
      return "external";
    case "ignored":
      return "ignored";
    default:
      return null;
  }
}

/** legacy 模式（v0.1.3 行为）：external→added，冷门取值丢弃 */
function mapItemToStatusLegacy(item: string): SvnStatusKind | null {
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

export interface ParseStatusXmlOptions {
  /** 使用 v0.1.3 的映射（external→added，丢弃 obstructed/incomplete/replaced/ignored） */
  legacyStatusMapping?: boolean;
}

/**
 * 解析 `svn status --xml`。
 *
 * 关键点：
 * - 按 `<entry` 分段解析，**绝不跨段**：即便前一个 entry 的 `</entry>` 缺失（截断输出），
 *   也不会把后一个 entry 的属性吞掉；
 * - `item="normal"` 时仍会检查 `props="modified"`（属性-only 修改）与 `tree-conflicted`。
 */
export function parseStatusXml(xml: string, options: ParseStatusXmlOptions = {}): SvnStatusEntry[] {
  const entries: SvnStatusEntry[] = [];
  if (!xml) {
    return entries;
  }

  const mapItem = options.legacyStatusMapping ? mapItemToStatusLegacy : mapItemToStatus;
  const chunks = xml.split(/<entry\b/).slice(1);

  for (const chunk of chunks) {
    const endIndex = chunk.indexOf("</entry>");
    const scope = endIndex >= 0 ? chunk.slice(0, endIndex) : chunk;

    const attrEnd = scope.indexOf(">");
    if (attrEnd < 0) {
      continue;
    }
    const attrText = scope.slice(0, attrEnd);
    const wcText = /<wc-status\b([^>]*?)\/?>/.exec(scope)?.[1] ?? "";

    const pathAttr = /\bpath="([^"]*)"/.exec(attrText)?.[1];
    if (pathAttr === undefined) {
      continue;
    }
    const path = decodeXmlEntities(pathAttr).replace(/\\/g, "/");
    if (!path) {
      continue;
    }

    const item = /\bitem="([^"]*)"/.exec(wcText)?.[1] ?? "";
    const props = /\bprops="([^"]*)"/.exec(wcText)?.[1] ?? "";
    const revision = /\brevision="([^"]*)"/.exec(wcText)?.[1];
    const treeConflicted = /\btree-conflicted="true"/.test(wcText);
    const propertyModified = props === "modified";

    let status = mapItem(item);
    if (status === null) {
      // item="normal"（或未知）时不再一律丢弃：属性修改与树冲突都是真实变更
      if (treeConflicted) {
        status = "conflict";
      } else if (propertyModified && !options.legacyStatusMapping) {
        status = "modified";
      }
    }
    if (status === null) {
      continue;
    }

    const splitIndex = path.lastIndexOf("/");
    const fileName = splitIndex >= 0 ? path.slice(splitIndex + 1) : path;
    const folderPath = splitIndex >= 0 ? path.slice(0, splitIndex) : "";

    const entry: SvnStatusEntry = { path, fileName, folderPath, status };
    if (item) {
      entry.rawItem = item;
    }
    if (propertyModified) {
      entry.propertyModified = true;
    }
    if (treeConflicted) {
      entry.treeConflicted = true;
    }
    if (revision !== undefined) {
      entry.revision = revision;
    }
    entries.push(entry);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * 宽格式：4 个状态列 + 空白 + 路径（svn 1.7+ 真实输出）。
 * 列 1/2 为内容与属性状态，列 3 为锁（空格/L），列 4 为树冲突（空格/C），
 * 另覆盖 shadowed（`"   A %s"` / `"   U %s"` / `"   D %s"`）、existed、blocked。
 */
const UPDATE_LINE_WIDE = /^([ ADUGCERB!?])([ ADUGCERB!?])([ ADUGCERB!?L])([ ADUGCERB!?])\s+(.+)$/;
/** 窄格式：单状态字符 + 空白 + 路径（兼容简化/旧式输出） */
const UPDATE_LINE_NARROW = /^([ADUGCERB!?])\s+(.+)$/;

const COLUMN1_STATUS: Record<string, UpdateEntryStatus> = {
  A: "added",
  D: "deleted",
  U: "modified",
  C: "conflicted",
  G: "merged",
  R: "replaced",
  E: "existed",
  B: "blocked",
};

const COLUMN4_STATUS: Record<string, UpdateEntryStatus> = {
  A: "added", // shadowed add
  U: "modified", // shadowed update
  D: "deleted", // shadowed delete
  C: "conflicted", // 树冲突
  E: "existed",
  B: "blocked",
};

export interface ParsedUpdateLine {
  col1: string;
  col2: string;
  col3: string;
  col4: string;
  path: string;
}

/** 解析单行 update 输出；非状态行（Updating/Updated to/Summary of …）返回 null */
export function parseUpdateLine(line: string): ParsedUpdateLine | null {
  const wide = UPDATE_LINE_WIDE.exec(line);
  if (wide) {
    return { col1: wide[1], col2: wide[2], col3: wide[3], col4: wide[4], path: wide[5] };
  }
  const narrow = UPDATE_LINE_NARROW.exec(line);
  if (narrow) {
    return { col1: narrow[1], col2: "", col3: "", col4: "", path: narrow[2] };
  }
  return null;
}

/**
 * 解析 `svn update` 文本输出。
 *
 * 覆盖 svn 的真实状态列：内容列（A/U/D/C/G/R/E/B）、属性列（`" U   path"`）、
 * 树冲突列（`"   C path"`）；并汇总冲突明细 —— 冲突不会再"消失"。
 */
export function parseUpdateOutput(output: string): UpdateResult {
  const entries: UpdateEntry[] = [];
  const conflicts: UpdateConflict[] = [];
  const summary = {
    total: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    conflicted: 0,
    merged: 0,
    replaced: 0,
    propertyModified: 0,
    totalSize: 0,
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseUpdateLine(line);
    if (!parsed) {
      continue;
    }

    // 属性列：U = 属性更新，M = 属性修改，C = 属性冲突
    const propertyModified = parsed.col2 === "U" || parsed.col2 === "M" || parsed.col2 === "C";
    const treeConflicted = parsed.col4 === "C";

    let status: UpdateEntryStatus | null = COLUMN4_STATUS[parsed.col4] ?? COLUMN1_STATUS[parsed.col1] ?? null;
    if (status === null && propertyModified) {
      // 属性-only 修改（内容列空、属性列 U）：v0.1.3 会整行丢弃
      status = "modified";
    }
    if (status === null) {
      continue;
    }

    const entry: UpdateEntry = { path: parsed.path.replace(/\\/g, "/"), status };
    if (propertyModified) {
      entry.propertyModified = true;
    }
    if (treeConflicted) {
      entry.treeConflicted = true;
    }
    entries.push(entry);

    if (parsed.col1 === "C") {
      conflicts.push({ path: entry.path, kind: "text", raw: line });
    }
    if (parsed.col2 === "C") {
      conflicts.push({ path: entry.path, kind: "property", raw: line });
    }
    if (treeConflicted) {
      conflicts.push({ path: entry.path, kind: "tree", raw: line });
    }

    switch (status) {
      case "added":
        summary.added += 1;
        break;
      case "modified":
        summary.modified += 1;
        break;
      case "deleted":
        summary.deleted += 1;
        break;
      case "conflicted":
        summary.conflicted += 1;
        break;
      case "merged":
        summary.merged += 1;
        break;
      case "replaced":
        summary.replaced += 1;
        break;
      default:
        break;
    }
    if (propertyModified) {
      summary.propertyModified += 1;
    }
  }

  summary.total = entries.length;
  return { entries, conflicts, summary };
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * 解析单文件 `svn diff` 输出。
 *
 * 与 v0.1.3 的差别：header（`Index:` / `===` / `---` / `+++`）只在 **hunk 之外**被跳过，
 * hunk 内以 `--` / `++` 开头的内容行不再被当 header 丢弃。
 */
export function parseDiffOutput(
  filePath: string,
  output: string,
  compareMode: "working-copy" | "previous-revision"
): SvnDiff {
  const diffLines: DiffLine[] = [];
  let currentLineNumber = 1;
  let inHunk = false;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      // 解析 hunk 头「@@ -a,b +c,d @@」的新文件起始行号（+c）；兼容省略 ,count 的单行形式
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      const startLine = hunkMatch
        ? Number.parseInt(hunkMatch[2], 10)
        : Number.parseInt(/^@@ -(\d+)/.exec(line)?.[1] ?? "1", 10);
      currentLineNumber = Number.isFinite(startLine) ? startLine : 1;
      continue;
    }

    if (!inHunk) {
      // hunk 之外的头部与命令回显一律跳过（含 Index:/===/---/+++ 与空行）
      continue;
    }

    if (line.startsWith("Index: ")) {
      // 多文件 diff：下一个文件的头部，结束当前 hunk
      inHunk = false;
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      continue;
    }

    if (line.startsWith("+")) {
      diffLines.push({ lineNumber: currentLineNumber, content: line.slice(1), type: "added" });
      currentLineNumber += 1;
    } else if (line.startsWith("-")) {
      diffLines.push({ lineNumber: currentLineNumber, content: line.slice(1), type: "deleted" });
    } else if (line.startsWith(" ")) {
      diffLines.push({ lineNumber: currentLineNumber, content: line.slice(1), type: "unchanged" });
      currentLineNumber += 1;
    }
    // 其他行（hunk 内不应出现）忽略
  }

  return { filePath, lines: diffLines, compareMode };
}

function normalizeForWhitespaceCompare(content: string): string {
  return content.replace(/\s+/g, "");
}

function isWhitespaceOnly(line: DiffLine): boolean {
  return normalizeForWhitespaceCompare(line.content).length === 0;
}

function isMarkdownSeparatorLine(content: string): boolean {
  return content.trim() === "---";
}

/** 取消「内容去空白后等价」的增删对（返回未被取消的行） */
function cancelEquivalentDiffLines(lines: DiffLine[]): DiffLine[] {
  const deletedMap = new Map<string, number[]>();
  const addedMap = new Map<string, number[]>();
  const cancelled = new Set<number>();

  lines.forEach((line, index) => {
    if (line.type !== "added" && line.type !== "deleted") {
      return;
    }
    const key = normalizeForWhitespaceCompare(line.content);
    if (!key) {
      return;
    }
    const map = line.type === "deleted" ? deletedMap : addedMap;
    const queue = map.get(key) ?? [];
    queue.push(index);
    map.set(key, queue);
  });

  deletedMap.forEach((deletedIndexes, key) => {
    const addedIndexes = addedMap.get(key) ?? [];
    const pairCount = Math.min(deletedIndexes.length, addedIndexes.length);
    for (let i = 0; i < pairCount; i += 1) {
      cancelled.add(deletedIndexes[i]);
      cancelled.add(addedIndexes[i]);
    }
  });

  return lines.filter((_line, index) => !cancelled.has(index));
}

/**
 * 归零化（可选，`SvnClientOptions.normalizeDiff = true` 时启用）：
 * 丢弃 markdown 分隔线与纯空白的增删、并把「仅空白不同」的增删对合并为 unchanged。
 *
 * 注意：v0.1.3 **默认**做这套归零化，会把 `-const a = f(x, y); / +const a=f(x,y);`
 * 这样的真实修改报告为「无差异」；v0.2.0 起默认关闭，需要旧行为时显式开启。
 */
export function normalizeDiffLines(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    const next = lines[i + 1];

    if ((current.type === "added" || current.type === "deleted") && isMarkdownSeparatorLine(current.content)) {
      continue;
    }
    if (isWhitespaceOnly(current) && (current.type === "added" || current.type === "deleted")) {
      continue;
    }
    if (
      current.type === "deleted" &&
      next &&
      next.type === "added" &&
      normalizeForWhitespaceCompare(current.content) === normalizeForWhitespaceCompare(next.content)
    ) {
      result.push({ lineNumber: current.lineNumber, content: next.content, type: "unchanged" });
      i += 1;
      continue;
    }
    result.push(current);
  }

  return cancelEquivalentDiffLines(result);
}

// ---------------------------------------------------------------------------
// log --xml
// ---------------------------------------------------------------------------

/**
 * 解析 `svn log --xml`（兼容 -v 的 `<paths>`）。
 *
 * - 按 `<logentry` 分段，截断的条目不会吞掉下一个条目；
 * - author/date/msg/path 统一做实体解码（旧版只对 status 的 path 解码，
 *   导致提交信息里的 `&`/`<` 原样显示，且含 `&` 的路径无法与变更清单匹配、提交者归属丢失）；
 * - 自闭合 `<path .../>` 先剔除，避免把后续 `<path>` 标签吞进内容；
 * - 无 `revision` 属性的条目丢弃。
 */
export function parseLogXml(xml: string): LogEntry[] {
  const out: LogEntry[] = [];
  if (!xml) {
    return out;
  }

  const chunks = xml.split(/<logentry\b/).slice(1);
  for (const chunk of chunks) {
    const endIndex = chunk.indexOf("</logentry>");
    const scope = endIndex >= 0 ? chunk.slice(0, endIndex) : chunk;

    const revision = /revision="(\d+)"/.exec(scope)?.[1];
    if (!revision) {
      continue;
    }

    const paths: string[] = [];
    const pathsBlock = /<paths>([\s\S]*?)<\/paths>/.exec(scope)?.[1] ?? "";
    const withoutSelfClosing = pathsBlock.replace(/<path\b[^>]*\/>/g, "");
    const pathRe = /<path\b[^>]*>([\s\S]*?)<\/path>/g;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRe.exec(withoutSelfClosing))) {
      const value = decodeXmlEntities(pathMatch[1]).trim();
      if (value) {
        paths.push(value);
      }
    }

    out.push({
      revision,
      author: readXmlTag(scope, "author") ?? "",
      date: readXmlTag(scope, "date") ?? "",
      message: readXmlTag(scope, "msg") ?? "",
      paths,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// diff --summarize
// ---------------------------------------------------------------------------

export interface SummarizeEntry {
  /** 变更类型字符：M/A/D/R/C/!/~ */
  action: string;
  path: string;
  /** 该条目是否为目录（svn diff --summarize 对目录变更会带尾斜杠） */
  isDirectory: boolean;
}

/**
 * 解析 `svn diff --summarize` 的行（旧版在 svnClient 里用一条正则过滤，且未区分目录项，
 * 导致目录属性项被当成文件、进而生成 `file:""` 的伪条目）。
 */
export function parseSummarizeOutput(output: string): SummarizeEntry[] {
  const entries: SummarizeEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const match = /^([MADRC!~?])\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const action = match[1];
    const rawPath = match[2].trim();
    const isDirectory = rawPath.endsWith("/") || rawPath.endsWith("\\");
    const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) {
      continue;
    }
    entries.push({ action, path: normalized, isDirectory });
  }
  return entries;
}
