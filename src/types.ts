/**
 * @caesarloo/simple-svn-client · 共享类型定义
 * 纯 SVN 领域类型，无任何 Obsidian 依赖。
 */

/**
 * 工作副本状态种类（与 svn status --xml 的 wc-status item 映射）。
 *
 * v0.2.0 起不再丢弃或错映射冷门取值：
 * - 旧版把 `external` 错误映射为 `added`，现独立为 `external`；
 * - 旧版静默丢弃 `obstructed` / `incomplete` / `replaced` / `ignored`，现各自成值。
 * 需要旧行为的调用方可传 `SvnClientOptions.legacyStatusMapping: true`。
 */
export type SvnStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "conflict"
  | "untracked"
  | "missing"
  | "replaced"
  | "obstructed"
  | "incomplete"
  | "external"
  | "ignored";

/** 状态条目（status 输出解析结果） */
export interface SvnStatusEntry {
  path: string;
  fileName: string;
  folderPath: string;
  status: SvnStatusKind;
  /** 原始 wc-status item 值（未经映射），便于调用方自行判断 */
  rawItem?: string;
  /** props="modified"：仅属性被修改（此时 item 可能仍为 normal） */
  propertyModified?: boolean;
  /** tree-conflicted="true"：树冲突 */
  treeConflicted?: boolean;
  /** wc-status revision 属性 */
  revision?: string;
}

/** 差异行 */
export interface DiffLine {
  lineNumber: number;
  content: string;
  type: "added" | "deleted" | "unchanged";
}

/** 单文件差异（diff 输出解析结果） */
export interface SvnDiff {
  filePath: string;
  lines: DiffLine[];
  compareMode?: "working-copy" | "previous-revision" | "file-content";
}

/**
 * update 条目状态。
 * v0.2.0 起覆盖 svn 的真实输出列（内容列 + 属性列 + 树冲突列）：
 * `conflicted`(C) / `merged`(G) / `replaced`(R) / `existed`(E) / `blocked`(B) 不再被静默丢弃。
 */
export type UpdateEntryStatus =
  | "added"
  | "modified"
  | "deleted"
  | "conflicted"
  | "merged"
  | "replaced"
  | "existed"
  | "blocked"
  | "unchanged";

/** 更新反馈条目 */
export interface UpdateEntry {
  path: string;
  status: UpdateEntryStatus;
  /** 第二列属性更新（`" U   path"`） */
  propertyModified?: boolean;
  /** 第四列树冲突（`"   C path"`） */
  treeConflicted?: boolean;
  size?: number;
}

/** 冲突明细（update 带出的冲突，文本/树/属性三类） */
export interface UpdateConflict {
  path: string;
  kind: "text" | "tree" | "property";
  /** 原始状态行（便于排障） */
  raw: string;
}

/** 更新反馈（svn update 输出解析结果） */
export interface UpdateResult {
  entries: UpdateEntry[];
  /** 本次 update 带出的冲突（旧版恒为空数组，这是冲突「报成功」的根因之一） */
  conflicts: UpdateConflict[];
  summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
    conflicted: number;
    merged: number;
    replaced: number;
    propertyModified: number;
    totalSize?: number;
  };
}

/** 日志条目（svn log --xml 解析结果） */
export interface LogEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths: string[];
}

/** SVN 变更条目（两版本间 frontmatter 字段差异 + 提交者与版本号归属） */
export interface ChangeItem {
  file: string;
  field: string;
  base: string; // r旧
  work: string; // r新
  author: string;
  revision: string;
}

/** SVN 快照信息（面板底部展示） */
export interface SnapshotInfo {
  revision: string;
  date: string; // 最近同步时间（本地时区 ISO，Date 可解析）
  changedFiles: number;
}

/** 冲突条目（`SvnClient.findConflicts()` 返回值） */
export interface SvnConflict {
  path: string;
  /** 来源：status 状态位 / 树冲突状态位 / 文件内容冲突标记 */
  source: "status" | "tree" | "marker";
  detail?: string;
}
