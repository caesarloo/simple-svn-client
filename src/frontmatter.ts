/**
 * frontmatter 解析工具（简化 YAML，支持 键:值 / 键: 列表 / 键: |- 多行块）
 * 从 ai-pm-tool 的 notes/parser.ts 迁出，供 svn 文件内容对比（diffFrontmatterFields）等场景共用。
 */

/** 从 Markdown 文本提取 frontmatter 区块（不含 --- 行），无则返回 null */
export function extractFrontmatterBlock(text: string): string | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

/** 标量类型转换：布尔 / 数字 / 其余字符串（列表项与内联列表共用） */
function parseScalar(s: string): string | number | boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s; // 日期保持字符串
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

/** 简化 YAML 解析：返回扁平对象（键 -> string | number | boolean | string[] | null） */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const block = extractFrontmatterBlock(text);
  if (!block) return {};
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([^:#][^:]*):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1].trim();
    let val = m[2].trim();
    i++;

    if (val === "" || val === "null" || val === "~") {
      // 空值：可能是列表或块
      if (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const items: (string | number | boolean)[] = [];
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          items.push(parseScalar(lines[i].replace(/^\s*-\s+/, "").trim()));
          i++;
        }
        out[key] = items;
      } else if (i < lines.length && /^\s*[|>][+-]?\s*$/.test(lines[i])) {
        // 多行块
        i++;
        const chunk: string[] = [];
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          chunk.push(lines[i].trim());
          i++;
        }
        out[key] = chunk.join("\n");
      } else {
        out[key] = null;
      }
    } else if (/^\s*[|>][+-]?\s*$/.test(val)) {
      const chunk: string[] = [];
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        chunk.push(lines[i].trim());
        i++;
      }
      out[key] = chunk.join("\n");
    } else if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
      // 日期（YYYY-MM-DD，可带时间）保持字符串，避免 Number() 产生 NaN
      out[key] = val;
    } else if (/^-?\d+$/.test(val)) {
      out[key] = Number(val);
    } else if (val === "true" || val === "false") {
      out[key] = val === "true";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      // 内联列表写法：[a, b, c]
      const inner = val.slice(1, -1);
      out[key] = inner
        .split(",")
        .map((s) => parseScalar(s.trim().replace(/^["']|["']$/g, "")))
        .filter((s) => s !== "");
    } else {
      out[key] = val;
    }
  }
  return out;
}
