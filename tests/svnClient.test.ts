import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SvnClient, execSvn, parseFrontmatter, isSvnWorkingCopy, runSync, generateSummaryWithFallback } from "../src/index";

jest.mock("node:child_process", () => {
  const { promisify } = jest.requireActual("node:util") as typeof import("node:util");
  const execFile = jest.fn();
  // 真实 child_process.execFile 内置 [util.promisify.custom]，resolve {stdout, stderr} 对象；
  // jest.fn() 没有该符号，promisify 默认只取第二个回调参数（Buffer），会导致
  // `const { stdout } = await execFileAsync(...)` 解构出 undefined。这里补上同一契约。
  (execFile as unknown as { [promisify.custom]: unknown })[promisify.custom] = function (
    file: string,
    args: string[],
    options: unknown
  ): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      (execFile as unknown as jest.Mock)(file, args, options, (err: Error | null, stdout: Buffer, stderr: Buffer) => {
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

/** 让 mock 以 Buffer 形式回调成功结果 */
function mockSuccess(stdout: Buffer | string, stderr: Buffer | string = Buffer.from("")): void {
  mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
    cb(null, Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"), Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, "utf8"));
  });
}

/** 按 args 分发的智能 mock：where/which 返回空（避免 PATH 发现干扰），其余走 routes */
function mockRoutes(routes: Array<{ match: (args: string[]) => boolean; stdout: Buffer | string; stderr?: string; code?: number }>): void {
  mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
    if (_bin === "where" || _bin === "which") {
      cb(null, Buffer.from(""), Buffer.from(""));
      return;
    }
    const route = routes.find((r) => r.match(args));
    if (!route) {
      const err = new Error(`unexpected svn args: ${args.join(" ")}`) as Error & { code?: number; stderr?: Buffer };
      cb(err, Buffer.from(""), Buffer.from("unexpected"));
      return;
    }
    if (route.code && route.code !== 0) {
      const err = new Error(`Command failed: svn ${args.join(" ")}`) as Error & { code?: number; stderr?: Buffer };
      err.code = route.code;
      err.stderr = Buffer.from(route.stderr ?? "", "utf8");
      cb(err, Buffer.from(""), Buffer.from(route.stderr ?? "", "utf8"));
      return;
    }
    const out = Buffer.isBuffer(route.stdout) ? route.stdout : Buffer.from(route.stdout, "utf8");
    cb(null, out, Buffer.from(route.stderr ?? "", "utf8"));
  });
}

/** 让 mock 回调 ENOENT（二进制候选探测失败场景） */
function mockEnOent(): void {
  mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: string }, stdout: Buffer, stderr: Buffer) => void) => {
    const err = new Error("spawn svn ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    cb(err, Buffer.from(""), Buffer.from(""));
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("parseFrontmatter（frontmatter.ts）", () => {
  test("无 frontmatter 返回空对象", () => {
    expect(parseFrontmatter("普通文本\n没有 frontmatter")).toEqual({});
  });

  test("解析键值对、数字、布尔、日期", () => {
    const fm = parseFrontmatter(`---
项目状态: 进行中
预估工作量: 3
重点项目: true
计划上线日期: 2026-08-30
---
正文`);
    expect(fm["项目状态"]).toBe("进行中");
    expect(fm["预估工作量"]).toBe(3);
    expect(fm["重点项目"]).toBe(true);
    expect(fm["计划上线日期"]).toBe("2026-08-30");
  });

  test("解析列表与内联列表", () => {
    const fm = parseFrontmatter(`---
项目经理:
  - 张三
  - 李四
干系人: [王五, 赵六]
---`);
    expect(fm["项目经理"]).toEqual(["张三", "李四"]);
    expect(fm["干系人"]).toEqual(["王五", "赵六"]);
  });

  test("解析多行块", () => {
    const fm = parseFrontmatter(`---
进展说明: |-
  第一行
  第二行
---`);
    expect(fm["进展说明"]).toBe("第一行\n第二行");
  });
});

describe("execSvn（svnClient.ts 底层）", () => {
  test("成功时返回 code=0 与解码后的 stdout", async () => {
    mockSuccess("Revision: 5");
    const r = await execSvn(["info"], "c:/work");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Revision: 5");
    expect(mockExecFile).toHaveBeenCalledWith("svn", ["info"], expect.objectContaining({ cwd: "c:/work" }), expect.any(Function));
  });

  test("失败时返回非 0 code 与 stderr（不抛错）", async () => {
    mockRoutes([{ match: () => true, stdout: "", stderr: "svn: E155007: not a working copy", code: 1 }]);
    const r = await execSvn(["info"], "c:/work");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E155007");
  });
});

describe("SvnClient 解析与命令执行", () => {
  test("status 解析 XML 并排序（含未版本化映射）", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "status",
        stdout: `<?xml version="1.0"?>
<status>
<target path=".">
<entry path="b.md"><wc-status item="modified" props="none"/></entry>
<entry path="a.md"><wc-status item="added"/></entry>
<entry path="c.md"><wc-status item="unversioned"/></entry>
<entry path="d.md"><wc-status item="normal"/></entry>
</target>
</status>`,
      },
    ]);
    const client = new SvnClient("c:/work");
    const entries = await client.status();
    expect(entries.map((e) => e.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(entries.find((e) => e.path === "a.md")?.status).toBe("added");
    expect(entries.find((e) => e.path === "c.md")?.status).toBe("untracked");
    expect(entries.find((e) => e.path === "d.md")).toBeUndefined();
  });

  test("update 解析 A/U/D 行与统计", async () => {
    mockRoutes([
      { match: (a) => a[0] === "update", stdout: "Updating 'c:/work':\nA 新增.md\nU 修改.md\nD 删除.md\nUpdated to revision 8." },
    ]);
    const client = new SvnClient("c:/work");
    const result = await client.update();
    expect(result.summary).toEqual({ total: 3, added: 1, modified: 1, deleted: 1, totalSize: 0 });
    expect(result.entries.map((e) => e.status)).toEqual(["added", "modified", "deleted"]);
  });

  test("log 解析 XML（revision/author/date/message/paths）", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "log",
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="6">
<author>caesarloo</author>
<date>2026-08-01T10:00:00.000000Z</date>
<paths>
<path action="M">/产品需求/需求A.md</path>
</paths>
<msg>更新进展</msg>
</logentry>
</log>`,
      },
    ]);
    const client = new SvnClient("c:/work");
    const entries = await client.log(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].revision).toBe("6");
    expect(entries[0].author).toBe("caesarloo");
    expect(entries[0].message).toBe("更新进展");
    expect(entries[0].paths).toEqual(["/产品需求/需求A.md"]);
  });

  test("diffFrontmatterFields 对比两个版本的字段差异", async () => {
    mockRoutes([
      {
        match: (a) => a[0] === "cat" && a.includes("5"),
        stdout: "---\n项目状态: 未开始\n---\n正文",
      },
      {
        match: (a) => a[0] === "cat" && a.includes("6"),
        stdout: "---\n项目状态: 进行中\n---\n正文",
      },
    ]);
    const client = new SvnClient("c:/work");
    const items = await client.diffFrontmatterFields("需求A.md", "5", "6");
    expect(items.length).toBeGreaterThan(0);
    const field = items.find((i) => i.field === "项目状态");
    expect(field?.file).toBe("需求A.md");
    expect(field?.base).toBe("未开始");
    expect(field?.work).toBe("进行中");
  });

  test("cat 返回文件内容，失败返回 null", async () => {
    mockRoutes([
      { match: (a) => a[0] === "cat" && a.includes("BASE") && a.includes("a.md"), stdout: "文件内容" },
      { match: (a) => a[0] === "cat", stdout: "", stderr: "svn: E170000: 目标版本不存在", code: 1 },
    ]);
    const client = new SvnClient("c:/work");
    expect(await client.cat("BASE", "a.md")).toBe("文件内容");
    expect(await client.cat("BASE", "missing.md")).toBeNull();
  });

  test("commit 校验：空路径/空备注抛错", async () => {
    const client = new SvnClient("c:/work");
    await expect(client.commit([], "msg")).rejects.toThrow("未选择任何暂存文件");
    await expect(client.commit(["a.md"], "  ")).rejects.toThrow("提交备注不能为空");
  });

  test("commit 输入校验：危险字符抛错", async () => {
    const client = new SvnClient("c:/work");
    await expect(client.commit(["a.md;rm -rf"], "msg")).rejects.toThrow("输入验证失败");
  });

  test("commit autoAdd：E200009 时自动 add 后重试一次", async () => {
    let commitCalls = 0;
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
      if (args[0] === "where" || args[0] === "which") {
        cb(null, Buffer.from(""), Buffer.from(""));
        return;
      }
      if (args[0] === "commit") {
        commitCalls += 1;
        if (commitCalls === 1) {
          const err = new Error("Command failed: svn commit") as Error & { code?: number; stderr?: Buffer };
          err.code = 1;
          err.stderr = Buffer.from("svn: E200009: '新增.md' is not under version control", "utf8");
          cb(err, Buffer.from(""), Buffer.from("svn: E200009: '新增.md' is not under version control", "utf8"));
          return;
        }
        cb(null, Buffer.from("Committed revision 9.\n"), Buffer.from(""));
        return;
      }
      if (args[0] === "status") {
        cb(null, Buffer.from("?       新增.md\n"), Buffer.from(""));
        return;
      }
      if (args[0] === "add") {
        cb(null, Buffer.from("A        新增.md\n"), Buffer.from(""));
        return;
      }
      const err = new Error(`unexpected svn args: ${args.join(" ")}`) as Error & { code?: number };
      cb(err, Buffer.from(""), Buffer.from("unexpected"));
    });
    const client = new SvnClient("c:/work");
    const output = await client.commit(["新增.md"], "提交", { autoAdd: true });
    expect(output).toContain("Committed revision 9");
    expect(commitCalls).toBe(2);
  });

  test("ensureAvailable：找不到任何候选二进制时抛引导错误", async () => {
    mockEnOent();
    const client = new SvnClient("c:/work", { svnBinaryPath: "C:/nonexistent/svn.exe" });
    await expect(client.ensureAvailable()).rejects.toThrow("未找到 svn 可执行文件");
  });
});

describe("isSvnWorkingCopy / runSync（同步流程）", () => {
  test("isSvnWorkingCopy 根据 info 退出码判断", async () => {
    mockRoutes([{ match: (a) => a[0] === "info", stdout: "Path: c:/work" }]);
    expect(await isSvnWorkingCopy("c:/work")).toBe(true);
    mockRoutes([{ match: (a) => a[0] === "info", stdout: "", stderr: "svn: E155007: not a working copy", code: 1 }]);
    expect(await isSvnWorkingCopy("c:/work")).toBe(false);
  });

  test("runSync：svn 不可用时返回 ok=false 与提示", async () => {
    mockEnOent();
    const result = await runSync("c:/work", "产品需求");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未检测到 svn 命令");
    expect(result.snapshot.revision).toBe("—");
  });

  test("runSync：非工作副本时返回 ok=false", async () => {
    mockRoutes([
      { match: (a) => a[0] === "--version", stdout: "svn, version 1.14.2" },
      { match: () => true, stdout: "", stderr: "svn: E155007: not a working copy", code: 1 },
    ]);
    const result = await runSync("c:/work", "产品需求");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("无法获取 SVN 版本号");
  });

  test("runSync：完整同步成功返回快照与变更", async () => {
    // 顺序队列：where/which 返回空，其余按调用顺序消费
    const queue: Array<{ stdout: string; stderr?: string; code?: number }> = [
      { stdout: "svn, version 1.14.2" }, // --version
      { stdout: "5" }, // info（revOld）
      { stdout: "Updated to revision 6." }, // update
      { stdout: "6" }, // info（revNew）
      { stdout: "M       产品需求/需求A.md\n" }, // diff --summarize
      {
        stdout: `<?xml version="1.0"?>
<log>
<logentry revision="6">
<author>caesarloo</author>
<date>2026-08-01T10:00:00.000000Z</date>
<paths>
<path action="M">/产品需求/需求A.md</path>
</paths>
<msg>更新进展</msg>
</logentry>
</log>`,
      }, // log --xml -v
      { stdout: "---\n项目状态: 未开始\n---\n正文" }, // cat r5
      { stdout: "---\n项目状态: 进行中\n---\n正文" }, // cat r6
    ];
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
      if (_bin === "where" || _bin === "which") {
        cb(null, Buffer.from(""), Buffer.from(""));
        return;
      }
      const item = queue.shift();
      if (!item) {
        cb(new Error(`unexpected svn args: ${args.join(" ")}`), Buffer.from(""), Buffer.from(""));
        return;
      }
      if (item.code && item.code !== 0) {
        const err = new Error(`Command failed: svn ${args.join(" ")}`) as Error & { code?: number; stderr?: Buffer };
        err.code = item.code;
        err.stderr = Buffer.from(item.stderr ?? "", "utf8");
        cb(err, Buffer.from(""), Buffer.from(item.stderr ?? "", "utf8"));
        return;
      }
      cb(null, Buffer.from(item.stdout, "utf8"), Buffer.from(item.stderr ?? "", "utf8"));
    });
    const result = await runSync("c:/work", "产品需求");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("svn update 完成：r5 → r6");
    expect(result.revOld).toBe("5");
    expect(result.snapshot.revision).toBe("6");
    expect(result.snapshot.changedFiles).toBeGreaterThan(0);
    expect(result.changes.length).toBeGreaterThan(0);
    const field = result.changes.find((c) => c.field === "项目状态");
    expect(field?.base).toBe("未开始");
    expect(field?.work).toBe("进行中");
    expect(field?.author).toBe("caesarloo");
    expect(field?.revision).toBe("6");
  });
});

describe("generateSummaryWithFallback（summary.ts）", () => {
  test("无变更时返回「无变更」", async () => {
    expect(await generateSummaryWithFallback([])).toBe("无变更");
  });

  test("有变更时生成摘要与文件清单", async () => {
    const entries = [
      { path: "产品需求/需求A.md", fileName: "需求A.md", folderPath: "产品需求", status: "modified" as const },
      { path: "产品需求/需求B.md", fileName: "需求B.md", folderPath: "产品需求", status: "added" as const },
    ];
    const summary = await generateSummaryWithFallback(entries);
    expect(summary).toContain("修改1个文件");
    expect(summary).toContain("新增1个文件");
    expect(summary).toContain("## 修改文件");
    expect(summary).toContain("- 产品需求/需求A.md");
    expect(summary).toContain("## 新增文件");
  });

  test("提供 diffProvider 时提取主题生成内容短语", async () => {
    const entries = [
      { path: "产品需求/需求A.md", fileName: "需求A.md", folderPath: "产品需求", status: "modified" as const },
    ];
    const summary = await generateSummaryWithFallback(entries, async () => [
      { content: "# 需求A 标题", type: "added" as const },
    ]);
    expect(summary).toContain("需求A 标题");
  });
});
