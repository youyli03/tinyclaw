/**
 * tinyclaw Browser MCP Server
 *
 * 提供 10 个工具（agent 侧名前缀 mcp_browser_*）：
 *   status           — 当前会话状态
 *   navigate         — 导航到 URL
 *   screenshot       — 截图保存到本地
 *   get_text         — 提取页面文本
 *   click            — 点击元素
 *   type             — 输入文本
 *   scroll           — 滚动页面或元素
 *   evaluate         — 执行 JS
 *   use_cdp          — 切换到 CDP 模式（接管外部 Chromium）
 *   attach_openclaw  — 激活 OpenClaw 扩展附件
 *
 * 启动方式：bun run /path/to/mcp-servers/browser/index.ts
 * 配置方式：mcp.toml [servers.browser]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { session } from "./session.ts";

// ── 截图输出目录 ───────────────────────────────────────────────────────────────
const OUTPUT_DIR =
  process.env["BROWSER_OUTPUT_DIR"] ??
  join(homedir(), ".tinyclaw", "agents", "default", "workspace", "tmp", "mcp-output", "browser");

async function ensureOutputDir(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

// ── OpenClaw 配置 ──────────────────────────────────────────────────────────────
const OPENCLAW_CONFIG_PATH =
  process.env["OPENCLAW_CONFIG"] ?? join(homedir(), ".openclaw", "openclaw.json");
const EXT_ID =
  process.env["EXT_ID"] ?? "ofmgifgocipoelhmclndbdlbcgjibmfh";

async function loadOpenclawToken(): Promise<string> {
  try {
    const text = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(text) as { gateway?: { auth?: { token?: string } } };
    return cfg?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "browser", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── 工具列表 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "status",
      description: "返回当前浏览器会话状态（模式、是否连接、当前 URL 和标题）",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "navigate",
      description: "导航到指定 URL，返回最终 URL 和页面标题",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "目标 URL（需包含 https:// 等协议前缀）" },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle", "commit"],
            description: "等待条件，默认 domcontentloaded",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "screenshot",
      description: "对当前页面截图，保存到本地文件并返回绝对路径",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "自定义保存路径（绝对路径），不填则自动生成文件名" },
          fullPage: { type: "boolean", description: "是否截取完整页面（含滚动部分），默认 false" },
        },
      },
    },
    {
      name: "get_text",
      description: "提取当前页面或指定元素的可见文本内容",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS 选择器，不填则依次尝试 article、#js_content、body",
          },
        },
      },
    },
    {
      name: "click",
      description: "点击符合 CSS 选择器的元素",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器（如 button.submit、a[href='/login']）" },
        },
        required: ["selector"],
      },
    },
    {
      name: "type",
      description: "向指定输入框填入文本",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器（输入框）" },
          text: { type: "string", description: "要输入的文本" },
          clear: { type: "boolean", description: "输入前是否先清空，默认 true" },
        },
        required: ["selector", "text"],
      },
    },
    {
      name: "scroll",
      description: "滚动整个页面或指定元素",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["down", "up", "left", "right"],
            description: "滚动方向，默认 down",
          },
          px: { type: "number", description: "滚动像素数，默认 500" },
          selector: {
            type: "string",
            description: "要滚动的元素选择器，不填则滚动整个页面",
          },
        },
      },
    },
    {
      name: "evaluate",
      description: "在当前页面上下文中执行 JavaScript，返回执行结果（JSON 序列化）",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JS 代码（表达式或 IIFE）" },
        },
        required: ["code"],
      },
    },
    {
      name: "use_cdp",
      description: "切换到 CDP 模式，连接到本机已启动的 Chromium（需先运行 openclaw-browser-session.sh start）",
      inputSchema: {
        type: "object",
        properties: {
          cdpPort: { type: "number", description: "CDP 调试端口，默认 9222" },
        },
      },
    },
    {
      name: "attach_openclaw",
      description:
        "激活 OpenClaw 浏览器扩展的 relay 连接（需先 use_cdp 或已处于 CDP 模式）。" +
        "自动读取 ~/.openclaw/openclaw.json 中的 gateway token，也可手动传入。",
      inputSchema: {
        type: "object",
        properties: {
          cdpPort: { type: "number", description: "CDP 端口，默认 9222（未处于 CDP 模式时自动切换）" },
          relayPort: { type: "number", description: "OpenClaw relay 端口，默认 18792" },
          gatewayToken: { type: "string", description: "Gateway auth token，不填则从 openclaw.json 读取" },
        },
      },
    },
  ],
}));

// ── 工具执行 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      // ── status ────────────────────────────────────────────────────────
      case "status": {
        if (!session.connected) {
          return ok({ mode: session.mode, connected: false });
        }
        const page = await session.getPage();
        return ok({
          mode: session.mode,
          connected: true,
          url: page.url(),
          title: await page.title(),
        });
      }

      // ── navigate ──────────────────────────────────────────────────────
      case "navigate": {
        const url = String(args["url"] ?? "");
        const waitUntil = (args["waitUntil"] as "load" | "domcontentloaded" | "networkidle" | "commit" | undefined) ?? "domcontentloaded";
        const page = await session.getPage();
        await page.goto(url, { waitUntil });
        return ok({ url: page.url(), title: await page.title() });
      }

      // ── screenshot ────────────────────────────────────────────────────
      case "screenshot": {
        await ensureOutputDir();
        const fullPage = Boolean(args["fullPage"] ?? false);
        const savePath =
          args["path"]
            ? String(args["path"])
            : join(OUTPUT_DIR, `screenshot-${Date.now()}.png`);
        const page = await session.getPage();
        await page.screenshot({ path: savePath, fullPage });
        return ok({ savedTo: savePath });
      }

      // ── get_text ──────────────────────────────────────────────────────
      case "get_text": {
        const page = await session.getPage();
        const selector = args["selector"] ? String(args["selector"]) : undefined;

        let text: string;
        if (selector) {
          text = (await page.locator(selector).first().innerText({ timeout: 10000 }).catch(() => "")) ?? "";
        } else {
          // 依次尝试 article → #js_content → body
          const candidates = ["article", "#js_content", "body"];
          text = "";
          for (const sel of candidates) {
            const t = await page.locator(sel).first().innerText({ timeout: 5000 }).catch(() => null);
            if (t && t.trim().length > 0) {
              text = t;
              break;
            }
          }
        }
        return ok({ text: text.trim() });
      }

      // ── click ─────────────────────────────────────────────────────────
      case "click": {
        const selector = String(args["selector"] ?? "");
        const page = await session.getPage();
        await page.locator(selector).first().click({ timeout: 10000 });
        return ok({ ok: true });
      }

      // ── type ──────────────────────────────────────────────────────────
      case "type": {
        const selector = String(args["selector"] ?? "");
        const text = String(args["text"] ?? "");
        const clear = args["clear"] !== false; // 默认 true
        const page = await session.getPage();
        const locator = page.locator(selector).first();
        if (clear) await locator.fill(text, { timeout: 10000 });
        else await locator.type(text, { timeout: 10000 });
        return ok({ ok: true });
      }

      // ── scroll ────────────────────────────────────────────────────────
      case "scroll": {
        const direction = (args["direction"] as string | undefined) ?? "down";
        const px = Number(args["px"] ?? 500);
        const selector = args["selector"] ? String(args["selector"]) : undefined;
        const page = await session.getPage();

        const [dx, dy] = direction === "right" ? [px, 0]
          : direction === "left" ? [-px, 0]
          : direction === "up" ? [0, -px]
          : [0, px];

        if (selector) {
          await page.locator(selector).first().evaluate(
            (el, [x, y]) => el.scrollBy(x as number, y as number),
            [dx, dy],
          );
        } else {
          await page.evaluate(([x, y]) => window.scrollBy(x as number, y as number), [dx, dy]);
        }
        return ok({ ok: true, direction, px });
      }

      // ── evaluate ──────────────────────────────────────────────────────
      case "evaluate": {
        const code = String(args["code"] ?? "");
        const page = await session.getPage();
        const result = await page.evaluate((c) => {
          // eslint-disable-next-line no-eval
          return eval(c);
        }, code);
        return ok({ result: JSON.stringify(result) });
      }

      // ── use_cdp ───────────────────────────────────────────────────────
      case "use_cdp": {
        const cdpPort = Number(args["cdpPort"] ?? 9222);
        await session.switchToCdp(cdpPort);
        const page = await session.getPage();
        return ok({ mode: "cdp", connected: true, url: page.url(), title: await page.title() });
      }

      // ── attach_openclaw ───────────────────────────────────────────────
      case "attach_openclaw": {
        const cdpPort = Number(args["cdpPort"] ?? 9222);
        const relayPort = Number(args["relayPort"] ?? 18792);
        const gatewayToken =
          args["gatewayToken"] ? String(args["gatewayToken"]) : await loadOpenclawToken();

        // 若当前不是 CDP 模式，先切换
        if (session.mode !== "cdp") {
          await session.switchToCdp(cdpPort);
        }

        const ctx = await session.getContext();
        ctx.setDefaultTimeout(15000);

        let attachResult: { ok: boolean; error?: string } = {
          ok: false,
          error: "attach message not sent",
        };

        // 获取当前主页面 URL，供 forceAttach 选 tab 用
        const mainPage = await session.getPage();
        const mainUrl = mainPage.url();

        for (let attempt = 0; attempt < 3; attempt++) {
          const optionsPage = await ctx.newPage();
          try {
            await optionsPage.goto(`chrome-extension://${EXT_ID}/options.html`, {
              waitUntil: "domcontentloaded",
            });

            if (gatewayToken) {
              await optionsPage.locator("#port").fill(String(relayPort));
              await optionsPage.locator("#token").fill(gatewayToken);
              await optionsPage.getByRole("button", { name: /save/i }).click();
            }

            attachResult = await optionsPage.evaluate(
              ([targetUrl]) =>
                new Promise<{ ok: boolean; error?: string }>((resolve) => {
                  const timer = setTimeout(
                    () => resolve({ ok: false, error: "sendMessage timeout" }),
                    5000,
                  );
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (chrome as any).tabs.query({ currentWindow: true }, (tabs: any[]) => {
                    const target =
                      tabs.find((t: any) => t.url === targetUrl) ??
                      tabs.find(
                        (t: any) =>
                          !String(t.url ?? "").startsWith("chrome://") &&
                          !String(t.url ?? "").startsWith("chrome-extension://"),
                      );
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (chrome as any).runtime.sendMessage(
                      { type: "forceAttach", tabId: target?.id ?? null },
                      (response: any) => {
                        clearTimeout(timer);
                        const lastError = (chrome as any).runtime.lastError;
                        if (lastError) {
                          resolve({ ok: false, error: lastError.message });
                          return;
                        }
                        resolve(response ?? { ok: false, error: "no response" });
                      },
                    );
                  });
                }),
              [mainUrl],
            ) as { ok: boolean; error?: string };

            await optionsPage.close().catch(() => {});
            if (attachResult.ok) break;
          } catch (err) {
            await optionsPage.close().catch(() => {});
            attachResult = { ok: false, error: String(err) };
          }
        }

        return ok({
          ok: attachResult.ok,
          message: attachResult.ok
            ? "OpenClaw 扩展已成功附加"
            : `附加失败：${attachResult.error ?? "unknown"}`,
        });
      }

      default:
        return err(`未知工具：${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

// ── 响应辅助 ───────────────────────────────────────────────────────────────────
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── 优雅退出 ───────────────────────────────────────────────────────────────────
async function shutdown() {
  await session.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── 启动 ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
