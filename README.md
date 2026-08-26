# @caesarloo/simple-svn-client

SVN CLI wrapper for Node.js — wraps the system `svn` executable. Designed for and shared by the
[vault-svn](https://github.com/caesarloo/obsidian-svn) and `ai-pm-tool` Obsidian plugins, but usable
in any Node.js project.

> ⚠️ **Requirements**
>
> This package does **not** bundle `svn`. It shells out to the system `svn` executable, which must be
> installed and available on `PATH` (or configured via `svnBinaryPath`):
>
> - **Windows**: [TortoiseSVN](https://tortoisesvn.net/) (check "command line client tools" during
>   install), [SlikSvn](https://sliksvn.com/download/) or VisualSVN Server binaries
> - **macOS**: `brew install subversion`
> - **Linux**: `apt install subversion` / `dnf install subversion`
>
> When `svn` is missing, methods throw an error listing the candidates it tried and install hints.

## Features

- Windows GBK output decoding with multi-encoding heuristic + mojibake repair (the differentiator)
- Automatic binary discovery: configured path → `PATH` (`where`/`which`) → common install locations
- Command-injection / path-traversal input validation; `--password` masking in debug logs
- High-level ops: `status` / `update` / `diff` / `add` / `delete` / `revert` / `resolve` / `commit`
  (with optional auto-add retry), `log` / `logRange` / `diffSummarize` / `cat`
- Domain ops: `diffFrontmatterFields` / `collectChanges` / `runSync` / `isSvnWorkingCopy`,
  frontmatter parsing, change-summary generation
- Zero Obsidian dependency; pure Node (node builtins + iconv-lite)

## Install

```bash
npm install @caesarloo/simple-svn-client
```

## Usage

```ts
import { SvnClient, runSync } from "@caesarloo/simple-svn-client";

const client = new SvnClient("C:/work/vault", { svnBinaryPath: "" });

if (await client.isAvailable()) {
  const entries = await client.status();
  const result = await client.update();
  const items = await client.collectChanges("5", "6");
}

// 完整同步流程（update + 变更收集）
const sync = await runSync("C:/work/vault", "产品需求");
console.log(sync.message, sync.snapshot);
```

### Error semantics

- `status` / `update` / `diff` / `add` / `delete` / `revert` / `resolve` / `commit` **throw** on
  failure, with the decoded `stderr` as the message.
- `log` / `logRange` / `diffSummarize` / `cat` return empty/`null` on failure (read-oriented,
  lenient).
- `execSvn` (low-level) never throws; check the returned `code`.
- `isAvailable()` returns `false` (no throw) when `svn` is missing.

## API

| Export | Description |
| --- | --- |
| `SvnClient` | High-level client; see below |
| `execSvn(args, cwd, timeoutMs?)` | Low-level exec, never throws, returns `{stdout, stderr, code}` |
| `SvnError` | Error with `stderr` + `code` |
| `isSvnWorkingCopy(cwd)` | Whether a directory is an SVN working copy |
| `runSync(cwd, repoDir)` | Full sync: availability → base revision → update → collect changes; auto-detects the real working-copy root via `svn info --show-item wc-root` (probes `cwd` then `cwd/repoDir`), so SVN checkouts living in a vault subdirectory sync correctly |
| `parseFrontmatter(text)` / `extractFrontmatterBlock(text)` | Simplified YAML frontmatter parsing |
| `generateSummaryWithFallback(entries, diffProvider?)` | Natural-language change summary + file list |
| `toSummaryDiffLines(lines)` | Adapt `DiffLine[]` to `SummaryDiffLine[]` |

### SvnClient methods

| Method | Description |
| --- | --- |
| `constructor(workingCopyPath, options?)` | `options: { svnBinaryPath?, enableDebugLog?, timeoutMs?, fileContentReader? }` (default timeout 60s, `0` = none; `fileContentReader: (relativePath) => Promise<Buffer \| null>` reads unversioned/added file content for diff preview — the client does **not** depend on Node `fs`) |
| `isAvailable()` / `ensureAvailable()` | Check `svn --version`; boolean vs throw |
| `getRevision()` | `svn info --show-item revision` → `string \| null` |
| `isWorkingCopy()` | `svn info` success check |
| `status()` | `svn status --xml` → `SvnStatusEntry[]` (sorted) |
| `update()` | `svn update` → parsed `UpdateResult` |
| `diff(file, compareWithPrevious?, updateStatus?)` | Single-file diff with normalization |
| `add/delete/revert/resolve(paths)` | Write ops (throw on failure) |
| `commit(paths, message, {autoAdd?})` | Commit; auto-add unversioned files when `autoAdd: true` |
| `log(limit?)` / `logRange(old, new)` | `svn log --xml` / `--xml -v` → `LogEntry[]` |
| `diffSummarize(old, new)` | `svn diff --summarize` → changed paths |
| `cat(rev, path)` | File content at revision → `string \| null` |
| `diffFrontmatterFields(path, old, new)` | Frontmatter field diffs between two revisions |
| `collectChanges(old, new)` | `{ items: ChangeItem[], changedFiles: string[] }` with author/revision attribution |

## Development

```bash
npm install
npm test        # jest
npm run typecheck
npm run build   # tsc → dist (also runs on `npm install` via prepare)
```

## License

MIT
