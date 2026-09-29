# @caesarloo/simple-svn-client

[English](#english) | [中文](#中文)

---

## English

A pure-Node SVN client: wraps the system `svn` executable with Windows-safe output decoding, strict
XML parsing, conflict guards and a typed domain layer. Shared by the
[vault-svn](https://github.com/caesarloo/obsidian-svn) and `ai-pm-tool` Obsidian plugins, but usable
in any Node.js project.

### What it does

- Wraps the system `svn` executable (no bundled binary), with automatic discovery of common install
  locations and a cached candidate list.
- Decodes Windows output safely: lossless UTF-8 first, GBK fallback, explicit override when needed —
  Chinese file paths, commit messages and error text survive round-trips.
- Parses `status` / `update` / `diff` / `log` output into typed structures, including the update
  columns most wrappers drop: property updates, tree conflicts, and `C`/`G`/`R`/`E` statuses.
- Detects unresolved conflicts **before** committing, from both `svn status` and the conflict markers
  inside file content.
- Reports failures as a typed `SvnError` with a `kind` (timeout / output limit / not-found / conflict /
  auth …) instead of a single opaque exit code.

### Install

```bash
npm install @caesarloo/simple-svn-client
```

The `svn` command line client must be installed and on `PATH` (or pointed to via `svnBinaryPath`).
On Windows, TortoiseSVN works if "command line client tools" is selected during installation;
SlikSvn or VisualSVN Server binaries work too.

Verify:

```bash
node -e "require('@caesarloo/simple-svn-client').execSvn(['--version'], process.cwd()).then(r => console.log(r.code, r.stdout.trim()))"
```

### Usage

```ts
import { SvnClient, runSync } from "@caesarloo/simple-svn-client";

const client = new SvnClient("<path-to-working-copy>", {
  // Optional: read file content yourself (keeps this package free of `fs`)
  fileContentReader: async (relativePath) => myVaultAdapter.readBinary(relativePath),
});

if (await client.isAvailable()) {
  const entries = await client.status();          // typed entries, sorted
  const update = await client.update();           // includes `conflicts`
  const diff = await client.diff("notes/a.md");   // normalized line numbers
}

// Full sync: availability → base revision → update → collect changes
const sync = await runSync("<path-to-working-copy>", "requirements");
console.log(sync.ok, sync.message, sync.snapshot);

// Conflict guard: refuse to commit while anything is unresolved
await client.assertNoConflicts(paths);            // throws SvnError(kind: "conflict")
await client.commit(paths, "message", { autoAdd: true, assertNoConflicts: true });
```

Common operations: `status`, `update`, `diff`, `diffSummarize`, `log`, `logRange`, `cat`, `add`,
`delete`, `revert`, `resolve`, `commit`, `diffFrontmatterFields`, `collectChanges`, `runSync`.

### Configuration

`new SvnClient(workingCopyPath, options?)` — every option is optional; the defaults suit Obsidian-style
vaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `svnBinaryPath` | `""` | Explicit `svn` path; empty means auto-discovery (configured path → bare `svn` → common install paths → `PATH`) |
| `enableDebugLog` | `false` | Use `console` as the logger |
| `logger` | `null` | Injectable logger (`debug`/`warn`/`error`); `null` keeps the client silent |
| `timeoutMs` | `60000` | Per-command timeout; `0` disables the timeout |
| `maxBufferBytes` | `64 MiB` | Output buffer limit per command |
| `outputEncoding` | `"auto"` | `auto` \| `utf8` \| `gbk` \| `gb18030` \| `latin1`; set explicitly for cygwin/WSL svn builds |
| `fileContentReader` | `null` | `(relativePath) => Promise<Buffer \| null>`; used for unversioned-file previews and conflict-marker scans |
| `signal` | – | `AbortSignal` to cancel running commands |
| `normalizeDiff` | `false` | When `true`, collapses whitespace-only changes and Markdown separator edits (the 0.1.x default) |
| `legacyStatusMapping` | `false` | Restores the 0.1.x status mapping (`external` → `added`, dropping rare statuses) |
| `assertNoConflictsOnCommit` | `false` | Check conflicts before every `commit` |

### Error handling

Write operations throw; read helpers (`cat`, `getRevision`, `getWorkingCopyRoot`, `isWorkingCopy`,
`isAvailable`) return `null`/`false`. `execSvn` never throws — check the returned `code`
(`127` = executable missing). Every thrown `SvnError` carries `stderr`, `code` and `kind`
(`notFound` \| `notWorkingCopy` \| `conflict` \| `auth` \| `timeout` \| `outputLimit` \| `aborted` \| `unknown`).

### Boundaries

- Does **not** bundle or download `svn`; the system client must be present.
- Does **not** implement the Subversion protocol — it is a CLI wrapper, not a library binding.
- Does **not** resolve conflicts automatically. `resolve()` defaults to `--accept working`, which
  *keeps* the conflict markers in the file; only use it when you intend to keep the working version.
- Does **not** read or write files by itself — the caller injects `fileContentReader`
  (this is what keeps the package free of Node's `fs`, as required for Obsidian community review).
- Does **not** merge revisions or rewrite history; it only exposes what `svn` reports.

### License

MIT

---

## 中文

纯 Node 的 SVN 客户端：封装系统 `svn` 可执行文件，附带 Windows 安全解码、严格 XML 解析、冲突守卫
与类型化领域层。由 [vault-svn](https://github.com/caesarloo/obsidian-svn) 与 `ai-pm-tool` 两个
Obsidian 插件共用，也可用于任意 Node.js 项目。

### 它做什么

- 封装系统 `svn` 可执行文件（不打包二进制），自动探测常见安装位置并缓存候选列表。
- 安全解码 Windows 输出：无损 UTF-8 优先、GBK 回退、必要时可显式指定 —— 中文路径、提交信息与
  报错文本都不会被改写。
- 把 `status` / `update` / `diff` / `log` 的输出解析成类型化结构，并覆盖多数封装会丢掉的 update
  状态列：属性更新、树冲突，以及 `C`/`G`/`R`/`E` 等状态。
- 提交前检查未解决的冲突：同时查 `svn status` 与文件内容里的冲突标记（两重保险）。
- 失败以类型化 `SvnError` 抛出，带 `kind`（超时 / 输出超限 / 未安装 / 冲突 / 认证 …），而不是
  一个无法分诊的退出码。

### 安装

```bash
npm install @caesarloo/simple-svn-client
```

需要已安装 `svn` 命令行客户端并位于 `PATH`（或用 `svnBinaryPath` 指定）。Windows 上装 TortoiseSVN
时需勾选 "command line client tools"，也可用 SlikSvn / VisualSVN Server 的二进制。

验证：

```bash
node -e "require('@caesarloo/simple-svn-client').execSvn(['--version'], process.cwd()).then(r => console.log(r.code, r.stdout.trim()))"
```

### 使用

```ts
import { SvnClient, runSync } from "@caesarloo/simple-svn-client";

const client = new SvnClient("<工作副本路径>", {
  // 可选：由调用方读文件内容（本包因此不依赖 fs）
  fileContentReader: async (relativePath) => myVaultAdapter.readBinary(relativePath),
});

if (await client.isAvailable()) {
  const entries = await client.status();          // 类型化条目，已排序
  const update = await client.update();           // 含 conflicts
  const diff = await client.diff("notes/a.md");   // 行号已对齐
}

// 完整同步：检测可用 → 取基线版本 → update → 收集变更
const sync = await runSync("<工作副本路径>", "产品需求");
console.log(sync.ok, sync.message, sync.snapshot);

// 冲突守卫：有未解决冲突时拒绝提交
await client.assertNoConflicts(paths);            // 抛 SvnError(kind: "conflict")
await client.commit(paths, "提交备注", { autoAdd: true, assertNoConflicts: true });
```

常用操作：`status`、`update`、`diff`、`diffSummarize`、`log`、`logRange`、`cat`、`add`、`delete`、
`revert`、`resolve`、`commit`、`diffFrontmatterFields`、`collectChanges`、`runSync`。

### 配置

`new SvnClient(workingCopyPath, options?)` —— 全部选项可选，缺省值适配 Obsidian 式 vault。

| 键 | 缺省 | 含义 |
| --- | --- | --- |
| `svnBinaryPath` | `""` | 显式指定 `svn` 路径；留空则自动探测（配置路径 → 裸名 `svn` → 常见安装路径 → `PATH`） |
| `enableDebugLog` | `false` | 把 `console` 作为日志器 |
| `logger` | `null` | 可注入日志器（`debug`/`warn`/`error`）；`null` 表示静默 |
| `timeoutMs` | `60000` | 单条命令超时；`0` 表示不设超时 |
| `maxBufferBytes` | `64 MiB` | 单条命令输出缓冲上限 |
| `outputEncoding` | `"auto"` | `auto` \| `utf8` \| `gbk` \| `gb18030` \| `latin1`；cygwin/WSL 版 svn 建议显式指定 |
| `fileContentReader` | `null` | `(relativePath) => Promise<Buffer \| null>`；用于未版本化文件预览与冲突标记扫描 |
| `signal` | – | `AbortSignal`，用于取消正在执行的命令 |
| `normalizeDiff` | `false` | 设为 `true` 时归并「仅空白不同」与 Markdown 分隔线改动（0.1.x 的默认行为） |
| `legacyStatusMapping` | `false` | 恢复 0.1.x 的状态映射（`external` → `added`，丢弃冷门状态） |
| `assertNoConflictsOnCommit` | `false` | 每次 `commit` 前自动检查冲突 |

### 错误处理

写操作抛错；读取类方法（`cat`、`getRevision`、`getWorkingCopyRoot`、`isWorkingCopy`、`isAvailable`）
返回 `null`/`false`。`execSvn` 从不抛错 —— 检查返回的 `code`（`127` = 可执行文件缺失）。
抛出的 `SvnError` 带 `stderr`、`code` 与 `kind`
（`notFound` \| `notWorkingCopy` \| `conflict` \| `auth` \| `timeout` \| `outputLimit` \| `aborted` \| `unknown`）。

### 边界（明确不做）

- **不**打包或下载 `svn`；必须由系统提供命令行客户端。
- **不**实现 Subversion 协议 —— 它是 CLI 封装，不是库级绑定。
- **不**自动解决冲突。`resolve()` 默认 `--accept working`，会把冲突标记**留在文件里**；
  只有确实打算保留工作区版本时才用它。
- **不**自行读写文件 —— 由调用方注入 `fileContentReader`（这也是本包完全不依赖 Node `fs`、
  满足 Obsidian 社区审核要求的原因）。
- **不**做版本合并或历史改写；只如实反映 `svn` 报告的内容。

### License

MIT
