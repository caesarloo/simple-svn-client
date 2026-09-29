/**
 * frontmatter 解析测试。
 *
 * v0.2.0 修正两处会误导字段对比的缺陷：引号未剥离、缩进嵌套冒充顶层键。
 */
import { extractFrontmatterBlock, parseFrontmatter } from "../src/index";

describe("extractFrontmatterBlock", () => {
  test("常规块 / BOM / 无尾随换行 / 无 frontmatter", () => {
    expect(extractFrontmatterBlock("---\nk: v\n---\n正文")).toBe("k: v");
    expect(extractFrontmatterBlock("\uFEFF---\nk: v\n---\n")).toBe("k: v");
    expect(extractFrontmatterBlock("---\nk: v\n---")).toBe("k: v");
    expect(extractFrontmatterBlock("普通文本")).toBeNull();
    expect(extractFrontmatterBlock("---\n---\n")).toBeNull();
  });
});

describe("parseFrontmatter", () => {
  test("带引号的值被剥离引号（旧版把引号留在值里，导致字段对比误报）", () => {
    const fm = parseFrontmatter(`---
desc: "包含: 冒号的值"
name: '单引号'
escaped: "含 \\" 转义引号"
---
正文`);
    expect(fm["desc"]).toBe("包含: 冒号的值");
    expect(fm["name"]).toBe("单引号");
    expect(fm["escaped"]).toBe('含 " 转义引号');
  });

  test("缩进嵌套不再冒充顶层键（旧版会凭空多出一个顶层键）", () => {
    const fm = parseFrontmatter(`---
nested:
  k: v
  n: 2
---
`);
    expect(fm["nested"]).toEqual({ k: "v", n: 2 });
    expect(fm["k"]).toBeUndefined();
    expect(fm["n"]).toBeUndefined();
  });

  test("列表 / 内联列表 / 块标量 / 日期 / 数字 / 布尔 保持既有语义", () => {
    const fm = parseFrontmatter(`---
项目经理:
  - 张三
  - 李四
干系人: [王五, 赵六]
进展说明: |-
  第一行
  第二行
计划上线日期: 2026-08-30
预估工作量: 3
重点项目: true
关闭: false
空值: ~
---
正文`);
    expect(fm["项目经理"]).toEqual(["张三", "李四"]);
    expect(fm["干系人"]).toEqual(["王五", "赵六"]);
    expect(fm["进展说明"]).toBe("第一行\n第二行");
    expect(fm["计划上线日期"]).toBe("2026-08-30");
    expect(fm["预估工作量"]).toBe(3);
    expect(fm["重点项目"]).toBe(true);
    expect(fm["关闭"]).toBe(false);
    expect(fm["空值"]).toBeNull();
  });

  test("CRLF frontmatter", () => {
    const fm = parseFrontmatter("---\r\n状态: 进行中\r\n计数: 7\r\n---\r\n正文");
    expect(fm["状态"]).toBe("进行中");
    expect(fm["计数"]).toBe(7);
  });

  test("值中含 # 与冒号不被截断", () => {
    const fm = parseFrontmatter(`---
url: https://x.com/a#b
time: 2026-09-29 14:54:16
---
`);
    expect(fm["url"]).toBe("https://x.com/a#b");
    expect(fm["time"]).toBe("2026-09-29 14:54:16");
  });

  test("无 frontmatter 返回空对象", () => {
    expect(parseFrontmatter("普通文本\n没有 frontmatter")).toEqual({});
  });
});
