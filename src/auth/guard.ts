import { requireMFA, MFAError } from "./mfa.js";

/**
 * 将一个异步函数包装为「执行前必须通过 MFA」的版本。
 *
 * @param fn         原始函数
 * @param displayFn  展示 MFA 提示的回调（用于 QQBot / 终端双模式）
 *
 * @example
 * const safeDelete = withMFA(deleteFile, (msg) => sendToQQ(msg));
 * await safeDelete("/path/to/file");
 */
export function withMFA<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  displayFn?: (message: string) => void
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    await requireMFA(displayFn);
    return fn(...args);
  };
}

export { MFAError };
