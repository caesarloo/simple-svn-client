/**
 * @caesarloo/simple-svn-client · 入口
 *
 * 完整 SVN 领域层：底层执行、客户端封装、纯函数解析器、编码解码、
 * frontmatter 解析、变更收集、同步流程、摘要生成、冲突守卫。
 */
export { SvnClient, isSvnWorkingCopy, runSync } from "./svnClient";
export type {
  SvnClientOptions,
  CommitOptions,
  ResolveOptions,
  SvnResolveAccept,
  RunSyncResult,
} from "./svnClient";

export { SvnError, classifySvnError, normalizeExitCode } from "./errors";
export type { SvnErrorKind, SvnErrorOptions, ClassifySvnErrorInput } from "./errors";

export {
  decodeSvnOutput,
  isLosslessUtf8,
  countReplacementChars,
  countInvalidControlChars,
} from "./encoding";
export type { SvnOutputEncoding, DecodeSvnOutputOptions } from "./encoding";

export {
  execSvn,
  getBinaryCandidates,
  resolveBinaryCandidates,
  clearBinaryCandidatesCache,
  maskSensitiveArgs,
  buildBinaryNotFoundError,
  DEFAULT_MAX_BUFFER_BYTES,
} from "./exec";
export type { SvnExecResult, SvnLogger, SvnExecOptions } from "./exec";

export {
  parseStatusXml,
  parseUpdateOutput,
  parseUpdateLine,
  parseDiffOutput,
  normalizeDiffLines,
  parseLogXml,
  parseSummarizeOutput,
  decodeXmlEntities,
} from "./parsers";
export type { SummarizeEntry, ParseStatusXmlOptions, ParsedUpdateLine } from "./parsers";

export { extractFrontmatterBlock, parseFrontmatter } from "./frontmatter";
export { generateSummaryWithFallback, toSummaryDiffLines } from "./summary";
export type { SummaryDiffLine, SummaryDiffProvider } from "./summary";

export type {
  SvnStatusKind,
  SvnStatusEntry,
  DiffLine,
  SvnDiff,
  UpdateEntry,
  UpdateEntryStatus,
  UpdateConflict,
  UpdateResult,
  LogEntry,
  ChangeItem,
  SnapshotInfo,
  SvnConflict,
} from "./types";
