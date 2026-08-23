/**
 * @caesarloo/simple-svn-client · 入口
 * 完整 SVN 领域层：底层执行、客户端封装、frontmatter 解析、变更收集、同步流程、摘要生成。
 */
export { SvnClient, execSvn, SvnError, isSvnWorkingCopy, runSync } from "./svnClient";
export type { SvnClientOptions, CommitOptions, SvnExecResult } from "./svnClient";
export { extractFrontmatterBlock, parseFrontmatter } from "./frontmatter";
export { generateSummaryWithFallback, toSummaryDiffLines } from "./summary";
export type { SummaryDiffLine, SummaryDiffProvider } from "./summary";
export type {
  SvnStatusKind,
  SvnStatusEntry,
  DiffLine,
  SvnDiff,
  UpdateEntry,
  UpdateResult,
  LogEntry,
  ChangeItem,
  SnapshotInfo,
} from "./types";
