import * as fs from "node:fs";

/**
 * 文件权限安全检查工具。
 *
 * 用于校验 secrets.toml / config.toml 等含敏感凭证的文件权限是否过宽
 * (group / other 可读)。POSIX 平台生效,Windows 跳过。
 */

export interface FilePermCheckResult {
  /** 权限是否安全(仅 owner 可访问) */
  ok: boolean;
  /** 当前文件 mode 的低 9 位(八进制),文件不存在或非 POSIX 时为 null */
  mode: number | null;
  /** 人类可读说明 */
  msg: string;
}

const IS_POSIX = process.platform !== "win32";

/**
 * 检查文件权限是否安全(group / other 无任何权限位)。
 *
 * 安全标准:`mode & 0o077 === 0`,即只有 owner 可读写。
 *
 * @param filePath 目标文件路径
 * @returns 检查结果;文件不存在或非 POSIX 平台时 ok=true(不阻塞)
 */
export function checkSecureFilePerm(filePath: string): FilePermCheckResult {
  if (!IS_POSIX) {
    return { ok: true, mode: null, msg: "非 POSIX 平台,跳过权限检查" };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { ok: true, mode: null, msg: "文件不存在,跳过" };
  }
  const mode = st.mode & 0o777;
  const groupOther = mode & 0o077;
  if (groupOther === 0) {
    return { ok: true, mode, msg: `权限安全(${mode.toString(8).padStart(3, "0")})` };
  }
  return {
    ok: false,
    mode,
    msg: `权限过宽(${mode.toString(8).padStart(3, "0")}),group/other 可访问敏感文件`,
  };
}

/**
 * 检查文件权限,过宽时告警;autoFix=true 时尝试 chmod 0600 修正。
 *
 * @param filePath 目标文件路径
 * @param label    日志中显示的文件别名(如 "secrets.toml")
 * @param autoFix  过宽时是否自动 chmod 0600(默认 false,仅告警)
 */
export function ensureSecureFilePerm(filePath: string, label: string, autoFix = false): void {
  const result = checkSecureFilePerm(filePath);
  if (result.ok) return;

  if (autoFix && result.mode !== null) {
    try {
      fs.chmodSync(filePath, 0o600);
      console.warn(
        `[tinyclaw] ⚠️  ${label} 权限过宽(${result.mode.toString(8).padStart(3, "0")}),已自动修正为 600`
      );
      return;
    } catch (err) {
      console.warn(
        `[tinyclaw] ⚠️  ${label} 权限过宽,自动修正失败:${err}\n` +
          `   请手动执行:chmod 600 ${filePath}`
      );
      return;
    }
  }

  console.warn(
    `[tinyclaw] ⚠️  安全警告:${label} ${result.msg}\n` +
      `   建议执行:chmod 600 ${filePath}\n` +
      `   (可在 config.toml 设置 [auth.secret_guard] autoChmod = true 让 tinyclaw 自动修正)`
  );
}
