#!/usr/bin/env python3
"""
通用 GDB MCP Server
支持双后端：
  - pygdbmi：GDB 作为后台子进程，通过 GDB/MI 协议通信（全自动）
  - tmux：GDB 在 tmux 窗格中运行，用户可见（人机协作）
"""

import subprocess
import time
import shutil
import os
from dataclasses import dataclass, field
from typing import Optional, Literal
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "gdb",
    instructions=(
        "通用 GDB 调试 MCP Server。"
        "工作流程：先调用 gdb_start 加载 ELF，再调用 gdb_connect 连接 target，"
        "然后使用 gdb_set_breakpoint / gdb_continue / gdb_step / gdb_read_registers 进行调试，"
        "最后调用 gdb_stop 结束会话。"
        "支持 pygdbmi（后台自动）和 tmux（用户可见）两种后端。"
    ),
)

GDB_BINARIES: dict[str, list[str]] = {
    "rv64": ["/usr/bin/gdb-multiarch", "/opt/riscv/bin/riscv64-unknown-elf-gdb"],
    "rv32": ["/opt/rv32im/bin/riscv32-unknown-elf-gdb", "/usr/bin/gdb-multiarch"],
    "auto": ["/usr/bin/gdb-multiarch", "/opt/riscv/bin/riscv64-unknown-elf-gdb", "/opt/rv32im/bin/riscv32-unknown-elf-gdb"],
}


def pick_gdb(arch: str) -> str:
    candidates = GDB_BINARIES.get(arch, GDB_BINARIES["auto"])
    for path in candidates:
        if shutil.which(path) or os.path.isfile(path):
            return path
    raise RuntimeError(f"未找到可用的 GDB（arch={arch}）。候选路径：{candidates}")


@dataclass
class GdbSession:
    backend: Literal["pygdbmi", "tmux"]
    elf_path: str
    gdb_bin: str
    arch: str
    connected: bool = False
    controller: Optional[object] = field(default=None, repr=False)
    tmux_target: str = ""


_session: Optional[GdbSession] = None


def _require_session() -> GdbSession:
    if _session is None:
        raise RuntimeError("没有活跃的 GDB 会话，请先调用 gdb_start。")
    return _session


# ── pygdbmi 后端 ──────────────────────────────────────────────────────────────

def _pygdbmi_exec(cmd: str, timeout: float = 10.0) -> str:
    sess = _require_session()
    responses = sess.controller.write(cmd, timeout_sec=timeout)
    return _format_mi_responses(responses)


def _format_mi_responses(responses: list) -> str:
    lines = []
    for r in responses:
        msg_type = r.get("type", "")
        msg = r.get("message", "") or ""
        payload = r.get("payload", "")
        if msg_type == "console":
            if payload:
                lines.append(str(payload).rstrip())
        elif msg_type == "log":
            if payload:
                lines.append(f"[log] {str(payload).rstrip()}")
        elif msg_type == "notify":
            lines.append(f"[{msg}] {payload}")
        elif msg_type == "result":
            if msg == "error":
                err = payload.get("msg", str(payload)) if isinstance(payload, dict) else str(payload)
                lines.append(f"ERROR: {err}")
            elif msg == "done":
                if payload:
                    lines.append(_format_payload(payload))
            else:
                lines.append(f"[{msg}] {payload}")
        elif msg_type == "output":
            if payload:
                lines.append(str(payload).rstrip())
    result = "\n".join(l for l in lines if l)
    return result if result else "(无输出)"


def _format_payload(payload: object) -> str:
    if not payload:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        return ", ".join(f"{k}={v}" for k, v in payload.items())
    return str(payload)


# ── tmux 后端 ─────────────────────────────────────────────────────────────────

def _tmux_send(cmd: str) -> None:
    sess = _require_session()
    subprocess.run(["tmux", "send-keys", "-t", sess.tmux_target, cmd, "Enter"], check=True)


def _tmux_capture(lines: int = 50, wait: float = 0.8) -> str:
    sess = _require_session()
    time.sleep(wait)
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", sess.tmux_target, "-p", f"-{lines}"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "(tmux capture 失败)"


def _backend_exec(cmd: str, wait: float = 0.8) -> str:
    sess = _require_session()
    if sess.backend == "pygdbmi":
        return _pygdbmi_exec(cmd)
    else:
        _tmux_send(cmd)
        return _tmux_capture(wait=wait)


def _do_stop() -> None:
    global _session
    if _session is None:
        return
    sess = _session
    try:
        if sess.backend == "pygdbmi" and sess.controller is not None:
            try:
                sess.controller.write("quit", timeout_sec=3)
            except Exception:
                pass
            try:
                sess.controller.exit()
            except Exception:
                pass
        elif sess.backend == "tmux":
            _tmux_send("quit")
            time.sleep(0.5)
    finally:
        _session = None


# ── 工具定义 ──────────────────────────────────────────────────────────────────

@mcp.tool(description=(
    "启动 GDB 调试会话并加载 ELF 符号文件。\n"
    "arch: 'rv32' | 'rv64' | 'auto'（默认 rv64）\n"
    "backend: 'pygdbmi'（后台自动，默认）| 'tmux'（用户可见窗口）\n"
    "tmux_session: tmux 后端时指定 session 名（默认 'gdb'），窗格名固定为 'gdb'\n"
    "若已有活跃会话会先自动停止旧会话。"
))
def gdb_start(
    elf_path: str,
    arch: str = "rv64",
    backend: str = "pygdbmi",
    tmux_session: str = "gdb",
) -> str:
    global _session
    if _session is not None:
        try:
            _do_stop()
        except Exception:
            pass

    gdb_bin = pick_gdb(arch)
    arch_str = "riscv:rv32" if arch == "rv32" else "riscv:rv64"

    if backend == "pygdbmi":
        from pygdbmi.gdbcontroller import GdbController
        ctrl = GdbController(gdb_path=gdb_bin)
        _session = GdbSession(backend="pygdbmi", elf_path=elf_path, gdb_bin=gdb_bin, arch=arch, controller=ctrl)
        out = _pygdbmi_exec(f"file {elf_path}")
        _pygdbmi_exec(f"set architecture {arch_str}")
        _pygdbmi_exec("set riscv use-compressed-breakpoints yes")
        _pygdbmi_exec("set confirm off")
        return (
            f"GDB 会话已启动（pygdbmi 后端）\n"
            f"GDB 二进制：{gdb_bin}\n"
            f"ELF 文件：{elf_path}\n"
            f"架构：{arch_str}\n"
            f"加载输出：\n{out}"
        )

    elif backend == "tmux":
        tmux_target = f"{tmux_session}:gdb"
        r = subprocess.run(["tmux", "has-session", "-t", tmux_session], capture_output=True)
        if r.returncode != 0:
            subprocess.run(["tmux", "new-session", "-d", "-s", tmux_session], check=True)
        subprocess.run(["tmux", "new-window", "-t", tmux_session, "-n", "gdb"], capture_output=True)
        _session = GdbSession(backend="tmux", elf_path=elf_path, gdb_bin=gdb_bin, arch=arch, tmux_target=tmux_target)
        gdb_cmd = (
            f"{gdb_bin} {elf_path} "
            f'-ex "set architecture {arch_str}" '
            f'-ex "set riscv use-compressed-breakpoints yes" '
            f'-ex "set confirm off"'
        )
        _tmux_send(gdb_cmd)
        time.sleep(1.5)
        out = _tmux_capture(wait=0)
        return (
            f"GDB 会话已启动（tmux 后端）\n"
            f"tmux 目标：{tmux_target}\n"
            f"GDB 二进制：{gdb_bin}\n"
            f"ELF 文件：{elf_path}\n"
            f"启动输出：\n{out}"
        )
    else:
        raise ValueError(f"不支持的 backend：{backend}，可选 'pygdbmi' 或 'tmux'")


@mcp.tool(description=(
    "连接到 GDB remote target（QEMU GDB stub 或 OpenOCD）。\n"
    "host: 目标主机（默认 '127.0.0.1'）\n"
    "port: 目标端口，例如 QEMU 默认 26000，OpenOCD 默认 3333"
))
def gdb_connect(port: int, host: str = "127.0.0.1") -> str:
    sess = _require_session()
    cmd = f"target remote {host}:{port}"
    out = _backend_exec(cmd, wait=1.5)
    sess.connected = True
    return f"已连接到 {host}:{port}\n{out}"


@mcp.tool(description=(
    "执行任意 GDB 命令，返回输出结果。\n"
    "支持所有 GDB CLI 命令，例如：\n"
    "  'p *vm_list[0]'  打印结构体\n"
    "  'x/10x $sp'      查看内存\n"
    "  'bt'             查看调用栈\n"
    "  'info registers' 查看寄存器\n"
    "  'disas $pc,+32'  反汇编当前位置"
))
def gdb_exec(command: str) -> str:
    return _backend_exec(command, wait=1.0)


@mcp.tool(description=(
    "设置断点。\n"
    "location 可以是：\n"
    "  函数名：'vmm_load'\n"
    "  文件:行号：'trap.c:42'\n"
    "  地址：'*0xffffffc000001234'"
))
def gdb_set_breakpoint(location: str) -> str:
    out = _backend_exec(f"break {location}", wait=0.5)
    return f"断点已设置：{location}\n{out}"


@mcp.tool(description="继续运行程序，直到命中断点或程序结束。")
def gdb_continue() -> str:
    return _backend_exec("continue", wait=2.0)


@mcp.tool(description=(
    "单步执行。\n"
    "step_type:\n"
    "  'step'  (s)  — 单步，进入函数\n"
    "  'next'  (n)  — 单步，跳过函数\n"
    "  'stepi' (si) — 指令级单步，进入\n"
    "  'nexti' (ni) — 指令级单步，跳过"
))
def gdb_step(step_type: str = "next") -> str:
    valid = {"step": "step", "next": "next", "stepi": "stepi", "nexti": "nexti",
             "s": "step", "n": "next", "si": "stepi", "ni": "nexti"}
    cmd = valid.get(step_type)
    if cmd is None:
        raise ValueError(f"无效的 step_type：{step_type}，可选：step/next/stepi/nexti")
    return _backend_exec(cmd, wait=1.0)


@mcp.tool(description=(
    "读取并格式化寄存器值。\n"
    "filter:\n"
    "  'int' — 只读整数寄存器 x0-x31（默认）\n"
    "  'all' — 所有寄存器（含 CSR：sepc/scause/hstatus 等）\n"
    "  'csr' — 只读常用 CSR（sepc/scause/stval/sstatus/satp/hstatus/hgatp/vsepc/vscause）"
))
def gdb_read_registers(filter: str = "int") -> str:
    sess = _require_session()

    if filter == "csr":
        # 逐个查询常用 CSR
        csrs = [
            "sepc", "scause", "stval", "sstatus", "satp",
            "hstatus", "hgatp", "vsepc", "vscause", "vstval",
            "mstatus", "mepc", "mcause",
        ]
        lines = []
        for csr in csrs:
            if sess.backend == "pygdbmi":
                out = _pygdbmi_exec(f"p/x ${csr}")
            else:
                _tmux_send(f"p/x ${csr}")
                out = _tmux_capture(wait=0.4)
            # 过滤空/error 行
            stripped = out.strip()
            if stripped and "ERROR" not in stripped and "No register" not in stripped:
                lines.append(f"{csr:12s} = {stripped.split('=')[-1].strip() if '=' in stripped else stripped}")
        return "CSR 寄存器：\n" + "\n".join(lines) if lines else "（CSR 读取为空，可能未连接或目标不支持）"

    elif filter == "all":
        return _backend_exec("info all-registers", wait=1.0)

    else:  # int（默认）
        return _backend_exec("info registers", wait=1.0)


@mcp.tool(description="终止当前 GDB 调试会话，释放资源。pygdbmi 后端会杀死 GDB 进程，tmux 后端会退出 GDB 并关闭窗格。")
def gdb_stop() -> str:
    global _session
    if _session is None:
        return "没有活跃的 GDB 会话。"
    backend = _session.backend
    tmux_target = _session.tmux_target
    _do_stop()
    if backend == "tmux":
        # 关闭 tmux 窗格
        try:
            subprocess.run(["tmux", "kill-window", "-t", tmux_target], capture_output=True)
        except Exception:
            pass
    return f"GDB 会话已终止（{backend} 后端）。"


# ── 入口 ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    mcp.run(transport="stdio")
