/**
 * @caesarloo/svn-client · 共享类型定义
 * 纯 SVN 领域类型，无任何 Obsidian 依赖。
 */

/** 工作副本状态种类（与 svn status --xml 的 wc-status item 映射） */
export type SvnStatusKind = "added" | "modified" | "deleted" | "conflict" | "untracked" | "missing";

/** 状态条目（status 输出解析结果） */
export interface SvnStatusEntry {
  path: string;
  fileName: string;
  folderPath: string;
  status: SvnStatusKind;
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

/** 更新反馈条目 */
export interface UpdateEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  size?: number;
}

/** 更新反馈（svn update 输出解析结果） */
export interface UpdateResult {
  entries: UpdateEntry[];
  summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
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
  date: string; // 最近同步时间
  changedFiles: number;
}
