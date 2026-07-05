import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // 全局忽略 vendored 前端库和工具脚本
  {
    ignores: ["src/web/frontend/**", "src/tools/scripts/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      // ---- P0: 自动修复 ----
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // ---- P1: 代码质量 ----
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "@typescript-eslint/no-empty-object-type": "warn",

      // ---- P2: 最佳实践（暂 warn，后续清理） ----
      "no-debugger": "error",
      "no-console": "off",
      "no-process-exit": "off",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-control-regex": "warn",
      "preserve-caught-error": "warn",
    },
  },
  {
    // CLI 命令文件：允许 console 和 process.exit
    files: ["src/cli/**/*.ts", "src/commands/**/*.ts"],
    rules: {
      "no-console": "off",
      "no-process-exit": "off",
    },
  },
  {
    // 核心逻辑文件：warn console 和 process.exit
    files: [
      "src/core/**/*.ts",
      "src/memory/**/*.ts",
      "src/llm/**/*.ts",
      "src/tools/**/*.ts",
    ],
    rules: {
      "no-console": "warn",
      "no-process-exit": "warn",
    },
  },
  {
    // 测试文件（未来）：允许顶层 await
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
