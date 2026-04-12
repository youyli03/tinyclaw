/**
 * Schema 键名提取工具
 *
 * 递归遍历 Zod schema 的 .shape，生成所有叶节点的 dot-path 列表。
 * 用于 config get/set 的 tab 补全，无需手动维护键名列表。
 */

import { z } from "zod";
import { ConfigSchema } from "./schema.js";

/**
 * 递归遍历 Zod schema，生成所有叶节点的 dot-path。
 *
 * 处理规则：
 * - ZodObject     → 递归 .shape 中的每个字段
 * - ZodDefault    → unwrap 内层 schema 继续递归
 * - ZodOptional   → unwrap 内层 schema 继续递归
 * - ZodNullable   → unwrap 内层 schema 继续递归
 * - ZodArray      → 作为叶节点（不展开数组项）
 * - 其他          → 作为叶节点
 *
 * 中间路径（对象节点）也会包含在结果中，方便 `config get llm.backends` 等命令。
 */
export function schemaKeys(schema: z.ZodTypeAny, prefix = ""): string[] {
  const typeName = schema._def?.typeName as string | undefined;

  // 透明包装层，直接 unwrap
  if (
    typeName === "ZodDefault" ||
    typeName === "ZodOptional" ||
    typeName === "ZodNullable"
  ) {
    return schemaKeys(schema._def.innerType as z.ZodTypeAny, prefix);
  }

  // 对象：递归 shape
  if (typeName === "ZodObject") {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const keys: string[] = [];

    // 对象自身的路径也加入（方便 get 整个对象）
    if (prefix) keys.push(prefix);

    for (const [key, child] of Object.entries(shape)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      keys.push(...schemaKeys(child as z.ZodTypeAny, childPath));
    }
    return keys;
  }

  // 叶节点（包括 ZodArray、ZodString、ZodNumber、ZodBoolean、ZodEnum 等）
  if (prefix) return [prefix];
  return [];
}

/**
 * ConfigSchema 的全量 dot-path 列表（含默认值字段）。
 * 在模块加载时计算一次，后续直接引用。
 */
export const ALL_CONFIG_KEYS: string[] = schemaKeys(ConfigSchema);

/**
 * 获取指定 dot-path 对应的 Zod schema（用于类型检查和枚举提示）。
 * 返回 null 表示路径不存在于 schema 中。
 */
export function getSchemaAtPath(
  dotPath: string
): z.ZodTypeAny | null {
  const parts = dotPath.split(".");
  let cur: z.ZodTypeAny = ConfigSchema;

  for (const part of parts) {
    // unwrap 包装层
    while (true) {
      const tn = cur._def?.typeName as string | undefined;
      if (tn === "ZodDefault" || tn === "ZodOptional" || tn === "ZodNullable") {
        cur = cur._def.innerType as z.ZodTypeAny;
      } else {
        break;
      }
    }

    const tn = cur._def?.typeName as string | undefined;
    if (tn !== "ZodObject") return null;

    const shape = (cur as z.ZodObject<z.ZodRawShape>).shape;
    if (!(part in shape)) return null;
    cur = shape[part] as z.ZodTypeAny;
  }

  return cur;
}

/**
 * 推断 dot-path 对应字段的"逻辑类型"，用于 config set 值解析和提示。
 */
export type FieldType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; itemKind: "string" | "number" | "boolean" | "object" | "unknown" }
  | { kind: "object" }
  | { kind: "unknown" };

export function getFieldType(dotPath: string): FieldType {
  let schema = getSchemaAtPath(dotPath);
  if (!schema) return { kind: "unknown" };

  // unwrap 包装
  while (true) {
    const tn = schema._def?.typeName as string | undefined;
    if (tn === "ZodDefault" || tn === "ZodOptional" || tn === "ZodNullable") {
      schema = schema._def.innerType as z.ZodTypeAny;
    } else {
      break;
    }
  }

  const tn = schema._def?.typeName as string | undefined;
  if (tn === "ZodString") return { kind: "string" };
  if (tn === "ZodNumber") return { kind: "number" };
  if (tn === "ZodBoolean") return { kind: "boolean" };
  if (tn === "ZodEnum") {
    return { kind: "enum", values: (schema._def.values as string[]) ?? [] };
  }
  if (tn === "ZodArray") {
    const itemSchema = schema._def.type as z.ZodTypeAny;
    const itemTn = itemSchema._def?.typeName as string | undefined;
    const itemKind =
      itemTn === "ZodString" ? "string"
      : itemTn === "ZodNumber" ? "number"
      : itemTn === "ZodBoolean" ? "boolean"
      : itemTn === "ZodObject" ? "object"
      : "unknown";
    return { kind: "array", itemKind };
  }
  if (tn === "ZodObject") return { kind: "object" };
  return { kind: "unknown" };
}
