/**
 * tinyclaw 统一日志系统
 *
 * 格式: [YYYY-MM-DD HH:MM:SS] [LEVEL] [module] message
 * 支持 LOG_LEVEL 环境变量过滤, 长消息自动截断
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  silent: "SILENT",
};

const DEFAULT_MAX_LEN = 300;

let globalLevel: LogLevel = resolveLogLevel();

function resolveLogLevel(): LogLevel {
  const raw =
    process.env.TINYCLAW_LOG_LEVEL ||
    process.env.LOG_LEVEL ||
    "info";
  const normalized = raw.toLowerCase().trim();
  if (normalized in LEVEL_ORDER) return normalized as LogLevel;
  return "info";
}

/** 运行时修改全局日志级别(如 cron runner 临时静默) */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function truncate(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, maxLen)}...(截断,总长 ${msg.length})`;
}

export interface Logger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(module: string, opts?: { maxLen?: number }): Logger {
  const maxLen = opts?.maxLen ?? DEFAULT_MAX_LEN;

  function log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;

    const body = truncate([msg, ...args.map(String)].join(" "), maxLen);
    const line = `[${ts()}] [${LEVEL_LABEL[level]}] [${module}] ${body}`;

    // 使用原始 console 避免被 monkey-patch 递归
    const saved = (console as unknown as Record<string, unknown>)["_orig"] as
      | { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void }
      | undefined;
    const orig = saved ?? {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
    };

    switch (level) {
      case "error":
        orig.error(line);
        break;
      case "warn":
        orig.warn(line);
        break;
      case "debug":
      case "trace":
        (orig.debug ?? orig.log)(line);
        break;
      default:
        orig.log(line);
    }
  }

  return {
    trace(msg, ...args) {
      log("trace", msg, args);
    },
    debug(msg, ...args) {
      log("debug", msg, args);
    },
    info(msg, ...args) {
      log("info", msg, args);
    },
    warn(msg, ...args) {
      log("warn", msg, args);
    },
    error(msg, ...args) {
      log("error", msg, args);
    },
  };
}

/**
 * 全局 console → Logger 桥接
 * 使未迁移的旧 console.log/warn/error 也能获得统一格式
 * 调用前保存原始 console 引用,避免 Logger 内部递归
 */
export function initGlobalLogger(): void {
  // 保存原始 console 方法供 Logger 内部使用
  const orig = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  (console as unknown as Record<string, unknown>)["_orig"] = orig;

  const logger = createLogger("global");

  console.log = (...a: unknown[]) => logger.info(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logger.error(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => logger.warn(a.map(String).join(" "));
  console.info = (...a: unknown[]) => logger.info(a.map(String).join(" "));
  console.debug = (...a: unknown[]) => logger.debug(a.map(String).join(" "));
}
