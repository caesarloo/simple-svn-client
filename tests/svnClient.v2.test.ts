/**
 * v0.2.0 修复项与新能力的端到端用例（mock child_process，聚焦客户端层行为）。
 *
 * 覆盖来源：《ZF03 冲突分析》§七/§八 + 两路源码审计发现的缺陷，逐条锁定：
 * - 中文报错/路径不再乱码（旧版 runRawUtf8 强制 UTF-8）
 * - update 带冲突时 runSync 不再报「完成且无冲突」
 * - collectChanges 不再吞掉点文件（.obsidian/app.json）、目录项不再产生伪条目
 * - 冲突守卫 API（status 状态位 + 文件内容标记双保险）
 * - @ 路径 peg revision 转义、shell 元字符不再误伤
 * - 候选探测缓存、PATH 发现、错误分类（超时/输出超限）、日志注入、无 AbortSignal 依赖
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import { SvnClient, clearBinaryCandidatesCache, execSvn, runSync } from "../src/index";

jest.mock("node:child_process", () => {
  const { promisify } = jest.requireActual("node:util") as typeof import("node:util");
  const execFile = jest.fn();
  (execFile as unknown as { [promisify.custom]: unknown })[promisify.custom] = function (
    file: string,
    args: string[],
    options: unknown
  ): Promise<{ stdout: Buffer | string; stderr: Buffer | string }> {
    return new Promise((resolve, reject) => {
      (execFile as unknown as jest.Mock)(file, args, options, (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  };
  return { execFile };
});

const mockExecFile = execFile as unknown as jest.Mock;

interface Route {
  match: (args: string[]) => boolean;
  stdout?: Buffer | string;
  stderr?: string | Buffer;
  code?: number;
}

/** where/which 返回空字符串（真实契约是 string，不是 Buffer），其余按 routes 分发 */
function mockRoutes(routes: Route[]): void {
  mockExecFile.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void) => {
    if (bin === "where" || bin === "which") {
      cb(null, "", "");
      return;
    }
    const route = routes.find((r) => r.match(args));
    if (!route) {
      const err = new Error(`unexpected svn args: ${args.join(" ")}`) as Error & { code?: number };
      err.code = 1;
      cb(err, Buffer.from(""), Buffer.from(""));
      return;
    }
    if (route.code && route.code !== 0) {
      const stderrBuf = typeof route.stderr === "string" ? Buffer.from(route.stderr, "utf8") : (route.stderr ?? Buffer.from(""));
      const err = new Error(`Command failed: svn ${args.join(" ")}`) as Error & { code?: number; stderr?: Buffer };
      err.code = route.code;
      err.stderr = stderrBuf;
      cb(err, Buffer.from(""), stderrBuf);
      return;
    }
    const out = route.stdout ?? "";
    cb(null, out, typeof route.stderr === "string" ? Buffer.from(route.stderr, "utf8") : (route.stderr ?? Buffer.from("")));
  });
}

function mockEnOent(): void {
  mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: string }, stdout: Buffer, stderr: Buffer) => void) => {
    const err = new Error("spawn svn ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    cb(err, Buffer.from(""), Buffer.from(""));
  });
}

/** 顺序队列 mock（用于 runSync 这类多命令流程） */
function mockQueue(queue: Array<{ stdout: string; stderr?: string | Buffer; code?: number }>): void {
  mockExecFile.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void) => {
    if (bin === "where" || bin === "which") {
      cb(null, "", "");
      return;
    }
    const item = queue.shift();
    if (!item) {
      const err = new Error(`unexpected svn args: ${args.join(" ")}`) as Error & { code?: number };
      err.code = 1;
      cb(err, Buffer.from(""), Buffer.from(""));
      return;
    }
    if (item.code && item.code !== 0) {
      const stderrBuf = typeof item.stderr === "string" ? Buffer.from(item.stderr, "utf8") : (item.stderr ?? Buffer.from(""));
      const err = new Error(`Command failed: svn ${args.join(" ")}`) as Error & { code?: number; stderr?: Buffer };
      err.code = item.code;
      err.stderr = stderrBuf;
      cb(err, Buffer.from(""), stderrBuf);
      return;
    }
    cb(null, item.stdout, Buffer.from(""));
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
  clearBinaryCandidatesCache();
});

describe("编码：中文报错与中文路径（旧版 runRawUtf8 强制 UTF-8 会乱码）", () => {
  test("status（XML 通道）失败时，GBK 中文 stderr 被正确解码", async () => {
    const gbkStderr = iconv.encode("svn: E155007: 不是工作副本", "gbk");
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: Buffer; code?: number }, stdout: Buffer, stderr: Buffer) => void) => {
      if (bin === "where" || bin === "which") {
        cb(null as never, Buffer.from(""), Buffer.from(""));
        return;
      }
      const err = new Error("Command failed: svn status --xml") as Error & { stderr?: Buffer; code?: number };
      err.code = 1;
      err.stderr = gbkStderr;
      cb(err, Buffer.from(""), gbkStderr);
    });

    const client = new SvnClient("c:/work");
    const message = await client.status().then(
      () => "",
      (error: Error) => error.message
    );
    expect(message).toContain("不是工作副本");
    expect(message).not.toContain("\uFFFD");
  });

  test("execSvn 的 stderr 同样按 GBK 解码（与 SvnClient 同一条解码通道）", async () => {
    const gbkStderr = iconv.encode("svn: E155007: 不是工作副本", "gbk");
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: Buffer; code?: number }, stdout: Buffer, stderr: Buffer) => void) => {
      if (bin === "where" || bin === "which") {
        cb(null as never, Buffer.from(""), Buffer.from(""));
        return;
      }
      const err = new Error("Command failed") as Error & { stderr?: Buffer; code?: number };
      err.code = 1;
      err.stderr = gbkStderr;
      cb(err, Buffer.from(""), gbkStderr);
    });

    const result = await execSvn(["info"], "c:/work");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("不是工作副本");
    expect(result.stderr).not.toContain("\uFFFD");
  });

  test("wc-root 返回 GBK 中文路径时被正确还原（旧版会得到含 U+FFFD 的不可用路径）", async () => {
    const gbkRoot = iconv.encode("C:\\wc\\周会材料", "gbk");
    mockExecFile.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
      if (bin === "where" || bin === "which") {
        cb(null, Buffer.from(""), Buffer.from(""));
        return;
      }
      if (args[0] === "info") {
        cb(null, gbkRoot, Buffer.from(""));
        return;
      }
      cb(null, Buffer.from("svn, version 1.14.2"), Buffer.from(""));
    });

    const client = new SvnClient("c:/wc");
    expect(await client.getWorkingCopyRoot()).toBe("C:\\wc\\周会材料");
  });
});

describe("update / runSync：冲突不再静默", () => {
  test("update 解析出冲突条目", async () => {
    mockRoutes([{ match: (a) => a[0] === "update", stdout: "Updating '.':\nC    a.md\n   C tree.md\nUpdated to revision 7." }]);
    const result = await new SvnClient("c:/work").update();
    expect(result.conflicts.map((c) => c.kind)).toEqual(["text", "tree"]);
    expect(result.summary.conflicted).toBe(2);
  });

  test("runSync：update 带出冲突时 ok=false，message 说明冲突数", async () => {
    mockQueue([
      { stdout: "c:/work" }, // wc-root 探测
      { stdout: "svn, version 1.14.2" }, // --version
      { stdout: "5" }, // info revOld
      { stdout: "C    conflicted.md\nUpdated to revision 6." }, // update（svn 冲突时退出码为 0）
      { stdout: "6" }, // info revNew
      { stdout: "" }, // diff --summarize
      { stdout: "<log></log>" }, // log -v
    ]);
    const result = await runSync("c:/work");
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([{ path: "conflicted.md", kind: "text", raw: "C    conflicted.md" }]);
    expect(result.message).toContain("冲突");
  });

  test("runSync：repoDir 为绝对路径时不再拼成 cwd/C:/...（旧版静默回退 cwd）", async () => {
    const seenCwds: string[] = [];
    mockExecFile.mockImplementation((bin: string, _args: string[], opts: unknown, cb: (err: Error & { code?: string }, stdout: Buffer, stderr: Buffer) => void) => {
      if (bin === "where" || bin === "which") {
        cb(null as never, Buffer.from(""), Buffer.from(""));
        return;
      }
      seenCwds.push((opts as { cwd: string }).cwd);
      const err = new Error("spawn svn ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      cb(err, Buffer.from(""), Buffer.from(""));
    });
    await runSync("c:/wc", "C:/abs/repo");
    expect(seenCwds).toContain("C:/abs/repo");
    expect(seenCwds.some((cwd) => cwd.includes("c:/wc/C:"))).toBe(false);
  });

  test("runSync：snapshot.date 为本地时区 ISO，且 Date 可解析", async () => {
    mockEnOent();
    const result = await runSync("c:/work");
    expect(result.snapshot.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Number.isNaN(Date.parse(result.snapshot.date))).toBe(false);
  });
});

describe("collectChanges：点文件、目录项与含 & 的路径", () => {
  test("点文件被纳入、目录项不产生伪条目、XML 实体路径的提交者归属不丢", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "diff",
        stdout: ["M       .obsidian/app.json", "M       产品目录/", "M       产品&需求/需求A.md", ""].join("\n"),
      },
      {
        match: (a) => a[0] === "log",
        stdout:
          '<log><logentry revision="6"><author>张三</author><paths>' +
          '<path action="M">/产品&amp;需求/需求A.md</path>' +
          "</paths><msg>m</msg></logentry></log>",
      },
      {
        match: (a) => a[0] === "cat" && a.some((p) => p.includes("需求A.md")) && a.includes("5"),
        stdout: "---\n项目状态: 未开始\n---\n正文",
      },
      {
        match: (a) => a[0] === "cat" && a.some((p) => p.includes("需求A.md")),
        stdout: "---\n项目状态: 进行中\n---\n正文",
      },
      { match: (a) => a[0] === "cat", stdout: '{"app": 1}' }, // 点文件无 frontmatter → 不产生字段条目
    ]);

    const { items, changedFiles } = await new SvnClient("c:/work").collectChanges("5", "6");
    // 目录项（产品目录/）被跳过；点文件保留（旧版 startsWith(".") 会连它一起吞掉）
    expect(changedFiles).toEqual([".obsidian/app.json", "产品&需求/需求A.md"]);
    expect(items.every((item) => item.file !== "")).toBe(true);
    const field = items.find((item) => item.field === "项目状态");
    expect(field?.author).toBe("张三");
    expect(field?.revision).toBe("6");
  });
});

describe("冲突守卫 API（status 状态位 + 文件内容标记双保险）", () => {
  test("status 命中 conflicted → hasConflicts/assertNoConflicts", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "status",
        stdout: '<status><target path="."><entry path="c.md"><wc-status item="conflicted" props="none"/></entry></target></status>',
      },
    ]);
    const client = new SvnClient("c:/work");
    expect(await client.hasConflicts()).toBe(true);
    expect(await client.findConflicts()).toEqual([{ path: "c.md", source: "status", detail: "conflicted" }]);
    await expect(client.assertNoConflicts()).rejects.toThrow("存在未解决的冲突");
  });

  test("status 未报冲突但文件内含标记 → 仍被发现（脏 wc.db 场景）", async () => {
    mockRoutes([{ match: (a) => a[0] === "status", stdout: '<status><target path="."></target></status>' }]);
    const client = new SvnClient("c:/work", {
      fileContentReader: async () => Buffer.from("<<<<<<< .mine\n内容\n=======\n>>>>>>> .theirs\n", "utf8"),
    });
    expect(await client.findConflicts(["x.md"])).toEqual([
      { path: "x.md", source: "marker", detail: "文件内含冲突标记" },
    ]);
  });

  test("commit 传 assertNoConflicts 时命中冲突即拒绝，且不发起 commit", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "status",
        stdout: '<status><target path="."><entry path="c.md"><wc-status item="conflicted"/></entry></target></status>',
      },
    ]);
    const client = new SvnClient("c:/work");
    await expect(client.commit(["c.md"], "msg", { assertNoConflicts: true })).rejects.toThrow("存在未解决的冲突");
    expect(mockExecFile.mock.calls.some((call) => call[1][0] === "commit")).toBe(false);
  });

  test("构造选项 assertNoConflictsOnCommit 全局生效", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "status",
        stdout: '<status><target path="."><entry path="c.md"><wc-status item="conflicted"/></entry></target></status>',
      },
    ]);
    const client = new SvnClient("c:/work", { assertNoConflictsOnCommit: true });
    await expect(client.commit(["c.md"], "msg")).rejects.toThrow("存在未解决的冲突");
  });
});

describe("参数处理：peg revision 与选项注入", () => {
  test("含 @ 的路径补尾部 @（避免被当 peg revision）；含 - 前缀加 ./", async () => {
    mockRoutes([{ match: () => true, stdout: "ok" }]);
    const client = new SvnClient("c:/work");
    await client.add(["user@host.md", "-x.md", "a b@c.md", "普通.md"]);
    const addArgs = mockExecFile.mock.calls.find((call) => call[1][0] === "add")?.[1] as string[];
    expect(addArgs).toContain("user@host.md@");
    expect(addArgs).toContain("./-x.md");
    expect(addArgs).toContain("a b@c.md@");
    expect(addArgs).toContain("普通.md");
  });

  test("写操作追加 --non-interactive（避免无凭据时等待输入到超时）", async () => {
    mockRoutes([{ match: () => true, stdout: "ok" }]);
    const client = new SvnClient("c:/work");
    await client.delete(["a.md"]);
    await client.revert(["a.md"]);
    await client.resolve(["a.md"]);
    for (const command of ["delete", "revert", "resolve"]) {
      const args = mockExecFile.mock.calls.find((call) => call[1][0] === command)?.[1] as string[];
      expect(args).toContain("--non-interactive");
    }
  });

  test("resolve 默认策略仍为 --accept working，可显式指定其他策略", async () => {
    mockRoutes([{ match: () => true, stdout: "ok" }]);
    const client = new SvnClient("c:/work");
    await client.resolve(["a.md"]);
    await client.resolve(["a.md"], { accept: "theirs-full" });
    const calls = mockExecFile.mock.calls.filter((call) => call[1][0] === "resolve").map((call) => call[1] as string[]);
    expect(calls[0]).toEqual(expect.arrayContaining(["resolve", "--accept", "working"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["resolve", "--accept", "theirs-full"]));
  });

  test("add 不再使用 --force（旧版会把 ignored 文件一并加入）", async () => {
    mockRoutes([{ match: () => true, stdout: "ok" }]);
    await new SvnClient("c:/work").add(["dir"]);
    const args = mockExecFile.mock.calls.find((call) => call[1][0] === "add")?.[1] as string[];
    expect(args).not.toContain("--force");
  });

  test("cat 校验版本参数（非法版本返回 null，不把参数丢给 svn）", async () => {
    mockRoutes([{ match: () => true, stdout: "内容" }]);
    const client = new SvnClient("c:/work");
    expect(await client.cat("not-a-rev", "a.md")).toBeNull();
    expect(await client.cat("HEAD", "a.md")).toBe("内容");
  });

  test("log 拒绝非正整数 limit", async () => {
    mockRoutes([{ match: () => true, stdout: "<log></log>" }]);
    const client = new SvnClient("c:/work");
    await expect(client.log(0)).rejects.toThrow("limit 必须为正整数");
    await expect(client.log(1.5)).rejects.toThrow("limit 必须为正整数");
  });
});

describe("diff：header 判定与归零化开关", () => {
  const diffText = [
    "Index: a.md",
    "=".repeat(67),
    "--- a.md\t(revision 1)",
    "+++ a.md\t(working copy)",
    "@@ -1,2 +1,2 @@",
    " keep",
    "--x",
    "++y",
  ].join("\n");

  test("hunk 内 --/++ 开头的内容行保留；normalizeDiff 默认关闭不消解真实修改", async () => {
    mockRoutes([{ match: (a) => a[0] === "diff", stdout: diffText }]);
    const result = await new SvnClient("c:/work").diff("a.md");
    expect(result.lines.map((l) => [l.type, l.content])).toEqual([
      ["unchanged", "keep"],
      ["deleted", "-x"],
      ["added", "+y"],
    ]);
  });

  test("normalizeDiff: true 时才做「忽略空白」归并", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "diff",
        stdout: ["Index: a.md", "=".repeat(67), "--- a.md\t(revision 1)", "+++ a.md\t(working copy)", "@@ -1 +1 @@", "-const a = 1;", "+const a=1;"].join("\n"),
      },
    ]);
    const plain = await new SvnClient("c:/work").diff("a.md");
    expect(plain.lines.filter((l) => l.type !== "unchanged")).toHaveLength(2);
    const normalized = await new SvnClient("c:/work", { normalizeDiff: true }).diff("a.md");
    expect(normalized.lines.filter((l) => l.type !== "unchanged")).toHaveLength(0);
  });

  test("diff 失败且无 fileContentReader 时，错误信息同时包含真因（旧版只剩「未配置」）", async () => {
    mockRoutes([{ match: (a) => a[0] === "diff", stdout: "", stderr: "svn: E155010: not found", code: 1 }]);
    const client = new SvnClient("c:/work");
    await expect(client.diff("新增.md")).rejects.toThrow("未配置文件内容读取器");
    await expect(client.diff("新增.md")).rejects.toThrow("E155010");
  });

  test("diffSummarize 返回纯路径，diffSummarizeEntries 保留类型字符与目录标记", async () => {
    mockRoutes([{ match: (a) => a[0] === "diff", stdout: "M       产品/需求A.md\nM       产品/\n" }]);
    const client = new SvnClient("c:/work");
    expect(await client.diffSummarize("5", "6")).toEqual(["产品/需求A.md"]);
    expect(await client.diffSummarizeEntries("5", "6")).toEqual([
      { action: "M", path: "产品/需求A.md", isDirectory: false },
      { action: "M", path: "产品", isDirectory: true },
    ]);
  });
});

describe("执行层：错误分类、候选缓存、PATH 发现、日志注入", () => {
  test("超时 / 输出超限 / 普通失败被区分为不同 kind", async () => {
    const makeImpl =
      (code: string | number | undefined, killed: boolean, message: string) =>
      (bin: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: string | number; killed?: boolean }, stdout: Buffer, stderr: Buffer) => void) => {
        if (bin === "where" || bin === "which") {
          cb(null as never, Buffer.from(""), Buffer.from(""));
          return;
        }
        const err = new Error(message) as Error & { code?: string | number; killed?: boolean };
        if (code !== undefined) {
          err.code = code;
        }
        err.killed = killed;
        cb(err, Buffer.from(""), Buffer.from(""));
      };

    mockExecFile.mockImplementation(makeImpl(undefined, true, "Command failed: svn update"));
    await expect(new SvnClient("c:/work").update()).rejects.toMatchObject({ kind: "timeout" });

    mockExecFile.mockImplementation(makeImpl("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", false, "stdout maxBuffer length exceeded"));
    await expect(new SvnClient("c:/work").update()).rejects.toMatchObject({ kind: "outputLimit" });

    mockExecFile.mockImplementation(makeImpl(undefined, false, "Command failed: svn update"));
    await expect(new SvnClient("c:/work").update()).rejects.toMatchObject({ kind: "unknown" });
  });

  test("SvnError 带 name 与 kind（旧版 name 是 'Error'，日志无法区分）", async () => {
    mockRoutes([{ match: () => true, stdout: "", stderr: "svn: E155007: not a working copy", code: 1 }]);
    try {
      await new SvnClient("c:/work").update();
      throw new Error("应当抛错");
    } catch (error) {
      const svnError = error as Error & { name: string; kind: string };
      expect(svnError.name).toBe("SvnError");
      expect(svnError.kind).toBe("notWorkingCopy");
    }
  });

  test("execSvn：ENOENT 时 code 为 number 127（旧版是字符串 \"ENOENT\"），且不抛错", async () => {
    mockEnOent();
    const result = await execSvn(["--version"], "c:/work");
    expect(typeof result.code).toBe("number");
    expect(result.code).toBe(127);
    expect(result.error).toBeTruthy();
  });

  test("候选解析按配置缓存：多次命令只 spawn 一次 where", async () => {
    let whereCalls = 0;
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
      if (bin === "where" || bin === "which") {
        whereCalls += 1;
        cb(null, Buffer.from(""), Buffer.from(""));
        return;
      }
      cb(null, Buffer.from("svn, version 1.14.2"), Buffer.from(""));
    });
    const client = new SvnClient("c:/work");
    await client.ensureAvailable();
    await client.getRevision();
    await client.isWorkingCopy();
    expect(whereCalls).toBe(1);
  });

  test("PATH 发现：where 返回字符串（真实契约）时结果进入候选（旧测试传 Buffer 掩盖了该路径）", async () => {
    const tried: string[] = [];
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void) => {
      if (bin === "where") {
        cb(null, "C:\\Tools\\svn.exe\n", "");
        return;
      }
      if (bin === "which") {
        cb(null, "/usr/bin/svn\n", "");
        return;
      }
      tried.push(bin);
      if (bin === "C:\\Tools\\svn.exe") {
        cb(null, Buffer.from("svn, version 1.14.2"), Buffer.from(""));
        return;
      }
      const err = new Error(`spawn ${bin} ENOENT`) as Error & { code?: string };
      err.code = "ENOENT";
      cb(err, Buffer.from(""), Buffer.from(""));
    });
    await expect(new SvnClient("c:/work").ensureAvailable()).resolves.toBeUndefined();
    expect(tried).toContain("C:\\Tools\\svn.exe");
  });

  test("默认静默：不写 console；注入 logger 时收到 debug 与 error", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockEnOent();
    await new SvnClient("c:/work").isAvailable();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    mockRoutes([{ match: () => true, stdout: "", stderr: "svn: E155007: x", code: 1 }]);
    const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    await expect(new SvnClient("c:/work", { logger }).update()).rejects.toThrow();
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  test("enableDebugLog 仍等价于把 console 作为 logger（向后兼容）", async () => {
    const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
    mockRoutes([{ match: () => true, stdout: "ok" }]);
    await new SvnClient("c:/work", { enableDebugLog: true }).isWorkingCopy();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("文件内容预览", () => {
  test("空文件为 0 行（旧版会产出 1 行空行）", async () => {
    mockRoutes([{ match: (a) => a[0] === "diff", stdout: "", stderr: "svn: E155010: not found", code: 1 }]);
    const client = new SvnClient("c:/work", { fileContentReader: async () => Buffer.from("") });
    const result = await client.diff("空文件.md");
    expect(result.compareMode).toBe("file-content");
    expect(result.lines).toEqual([]);
  });

  test("二进制候选被拒绝预览", async () => {
    mockRoutes([{ match: (a) => a[0] === "diff", stdout: "", stderr: "svn: E155010: not found", code: 1 }]);
    const client = new SvnClient("c:/work", { fileContentReader: async () => Buffer.from([0x00, 0x01, 0x02, 0x00]) });
    await expect(client.diff("a.png")).rejects.toThrow("可能为二进制文件");
  });
});
