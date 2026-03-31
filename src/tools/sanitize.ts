/**
 * Unicode 隐藏字符注入防护
 *
 * 参考：CC HackerOne #3086545 / embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/
 *
 * 攻击原理：攻击者在 MCP 工具返回结果或用户消息中嵌入不可见 Unicode 字符（如
 * Unicode Tag 字符 \uE0000-\uE007F、零宽字符等）来注入隐藏指令，AI 会执行但
 * 用户在界面上完全看不见。
 *
 * 本模块对工具返回结果和用户输入做统一清洗：
 * 1. NFKC 归一化（处理组合字符序列）
 * 2. 清除危险 Unicode 范围（零宽字符、方向控制、私有区等）
 * 3. 迭代直到稳定（防止嵌套编码绕过）
 */

const MAX_ITERATIONS = 10;

/**
 * 清洗单个字符串中的危险 Unicode 字符。
 * 迭代执行直到输出稳定或达到最大迭代次数。
 */
export function sanitizeUnicode(text: string): string {
  let current = text;
  let previous = "";
  let iterations = 0;

  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current;

    // 1. NFKC 归一化（处理组合字符序列）
    current = current.normalize("NFKC");

    // 2. 清除危险 Unicode 属性类（Cf=格式字符, Co=私有使用, Cn=未分配）
    //    注意：部分环境不支持 Unicode property escapes，所以下面也做了显式范围兜底
    try {
      current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "");
    } catch {
      // 环境不支持 \p{} 语法，跳过，依赖下面的显式范围
    }

    // 3. 显式清除已知危险范围（兜底，覆盖不支持 \p{} 的运行时）
    current = current
      .replace(/[\u200B-\u200F]/g, "")   // 零宽空格、LTR/RTL 标记
      .replace(/[\u202A-\u202E]/g, "")   // 方向格式字符
      .replace(/[\u2066-\u2069]/g, "")   // 方向隔离字符
      .replace(/[\uFEFF]/g, "")          // BOM
      .replace(/[\uE000-\uF8FF]/g, "");  // BMP 私有区（含 Unicode Tag 载体）
    // Unicode Tag 字符 U+E0000-U+E007F（补充平面，代理对形式）用 split+codePointAt 过滤
    if (current.includes("\uDB40")) {
      current = [...current].filter((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        return cp < 0xE0000 || cp > 0xE007F;
      }).join("");
    }

    iterations++;
  }

  return current;
}

/**
 * 对工具返回结果做 Unicode 清洗。
 * 超长结果只清洗前后各 4000 字符，中间保留原样（避免大文件性能问题）。
 */
export function sanitizeToolResult(result: string): string {
  if (result.length <= 8000) {
    return sanitizeUnicode(result);
  }
  // 超长：只清洗首尾，中间保留（攻击通常在首尾注入）
  const head = sanitizeUnicode(result.slice(0, 4000));
  const tail = sanitizeUnicode(result.slice(-4000));
  return head + result.slice(4000, -4000) + tail;
}

/**
 * 对用户输入做 Unicode 清洗（全量处理，用户消息通常不会太长）。
 */
export function sanitizeUserInput(text: string): string {
  return sanitizeUnicode(text);
}
