/**
 * BrowserSession — 持久化 Playwright 浏览器会话管理
 *
 * 两种模式：
 *   headless — 自行启动 Chromium（无头），使用系统 /usr/bin/chromium-browser
 *   cdp      — 连接到外部已运行的 Chromium（通过 CDP 协议），用于接入 OpenClaw 扩展
 *
 * 单例 session 随 MCP server 进程存活，工具调用时懒初始化。
 * idle 超时：最后一次工具调用后 IDLE_TIMEOUT_MS 内无新调用则自动关闭浏览器（仅 headless）。
 */

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

export type BrowserMode = "headless" | "cdp";

const CHROMIUM_PATH = process.env["CHROMIUM_PATH"] ?? "/usr/bin/chromium-browser";

/** headless 模式的浏览器 idle 超时（默认 10 分钟） */
const IDLE_TIMEOUT_MS = Number(process.env["BROWSER_IDLE_TIMEOUT_MS"] ?? 10 * 60 * 1000);

export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  mode: BrowserMode = "headless";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** 重置 idle 计时器；每次工具调用后调用 */
  touch(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    // 仅 headless 模式启用 idle 超时（CDP 模式管理外部浏览器，不自动关闭）
    if (this.mode === "headless" && this.browser) {
      this.idleTimer = setTimeout(() => {
        console.error(`[browser] idle timeout (${IDLE_TIMEOUT_MS / 1000}s), closing browser`);
        void this.close();
      }, IDLE_TIMEOUT_MS);
    }
  }

  /** 确保 headless 会话已启动，若已有则直接返回 */
  async ensureSession(): Promise<void> {
    if (this.browser && this.page) return;

    this.browser = await chromium.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.mode = "headless";
  }

  /**
   * 切换到 CDP 模式：连接到本机已运行的 Chromium（CDP 端口）。
   * 自动关闭当前 headless 会话（若存在）。
   */
  async switchToCdp(cdpPort = 9222): Promise<void> {
    // 关闭旧的 headless 会话（CDP 模式下不 close，以免关掉外部浏览器）
    if (this.mode === "headless" && this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
    }

    const versionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
    const versionRes = await fetch(versionUrl);
    if (!versionRes.ok) {
      throw new Error(`CDP 端口 ${cdpPort} 无响应，请先启动 Chromium（openclaw-browser-session.sh start）`);
    }
    const { webSocketDebuggerUrl } = (await versionRes.json()) as { webSocketDebuggerUrl: string };

    this.browser = await chromium.connectOverCDP(webSocketDebuggerUrl);
    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? await this.browser.newContext();
    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();
    this.mode = "cdp";
  }

  /** 获取当前页面（懒初始化 headless 会话） */
  async getPage(): Promise<Page> {
    await this.ensureSession();
    if (!this.page) throw new Error("无可用页面");
    return this.page;
  }

  /** 获取当前 BrowserContext（懒初始化） */
  async getContext(): Promise<BrowserContext> {
    await this.ensureSession();
    if (!this.context) throw new Error("无可用 BrowserContext");
    return this.context;
  }

  /** 关闭浏览器，仅在 headless 模式下实际 close（CDP 模式不关闭外部浏览器） */
  async close(): Promise<void> {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.mode === "headless" && this.browser) {
      await this.browser.close().catch(() => {});
    } else if (this.mode === "cdp" && this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  /** 是否已连接 */
  get connected(): boolean {
    return this.browser !== undefined && (this.browser.isConnected?.() ?? true);
  }
}

export const session = new BrowserSession();
