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
      description:
        "Return the current browser session status (mode, connection state, current URL and title)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "navigate",
      description: "Navigate to the given URL and return the final URL and page title",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Target URL (must include a protocol prefix such as https://)",
          },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle", "commit"],
            description: "Wait condition, defaults to domcontentloaded",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "screenshot",
      description:
        "Take a screenshot of the current page, save it to a local file and return its path",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Custom save path (absolute); a filename is generated when omitted",
          },
          fullPage: {
            type: "boolean",
            description:
              "Whether to capture the full page including the scrolled-out part, default false",
          },
        },
      },
    },
    {
      name: "get_text",
      description: "Extract the visible text of the current page or of a specified element",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "CSS selector; when omitted, article, #js_content and body are tried in order",
          },
        },
      },
    },
    {
      name: "click",
      description: "Click the element matching the CSS selector",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector (e.g. button.submit, a[href='/login'])",
          },
        },
        required: ["selector"],
      },
    },
    {
      name: "type",
      description: "Fill text into the given input field",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector (the input field)" },
          text: { type: "string", description: "Text to enter" },
          clear: { type: "boolean", description: "Whether to clear the field first, default true" },
        },
        required: ["selector", "text"],
      },
    },
    {
      name: "scroll",
      description: "Scroll the whole page or a specified element",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["down", "up", "left", "right"],
            description: "Scroll direction, defaults to down",
          },
          px: { type: "number", description: "Number of pixels to scroll, defaults to 500" },
          selector: {
            type: "string",
            description:
              "Selector of the element to scroll; the whole page is scrolled when omitted",
          },
        },
      },
    },
    {
      name: "evaluate",
      description:
        "Execute JavaScript in the current page context and return the result (JSON-serialized)",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code to execute (an expression or an IIFE)",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "use_cdp",
      description:
        "Switch to CDP mode and connect to a Chromium instance already running on this " +
        "machine (run openclaw-browser-session.sh start first)",
      inputSchema: {
        type: "object",
        properties: {
          cdpPort: { type: "number", description: "CDP debugging port, defaults to 9222" },
        },
      },
    },
    {
      name: "attach_openclaw",
      description:
        "Activate the relay connection of the OpenClaw browser extension (requires use_cdp " +
        "first, or an already active CDP mode). " +
        "The gateway token is read from ~/.openclaw/openclaw.json automatically and can " +
        "also be passed explicitly.",
      inputSchema: {
        type: "object",
        properties: {
          cdpPort: {
            type: "number",
            description:
              "CDP port, defaults to 9222 (switches mode automatically when not in CDP)",
          },
          relayPort: { type: "number", description: "OpenClaw relay port, defaults to 18792" },
          gatewayToken: {
            type: "string",
            description: "Gateway auth token; read from openclaw.json when omitted",
          },
        },
      },
    },
  ],
}));

// ── 工具执行 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // 每次工具调用都重置 idle 计时器（仅对有效工具调用计时）
  session.touch();

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
