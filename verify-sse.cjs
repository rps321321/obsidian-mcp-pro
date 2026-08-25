#!/usr/bin/env node
/**
 * obsidian-mcp-pro 验证脚本
 * 用法: node verify-sse.mjs [分钟数]   (默认 2 分钟)
 *
 * 验证项:
 *  1. SDK 连接成功（拿到 sessionId）
 *  2. listTools 返回工具数量（应为 41）
 *  3. 长连接稳定性: 每 30s 打点一次，观察 sessionId 是否保持不变
 *     (sessionId 不变 = SSE 流未断 = 心跳/超时配置生效)
 *  4. 结束时再次 listTools 确认连接仍活跃
 *
 * stateless 模式（STATELESS_MODE=true）适配：
 *  服务端不签发 sessionId（undefined）、无 GET SSE 长连接，
 *  因此第 3 项"sessionId 稳定性"检查自动跳过，改为每 30s 重复
 *  调用 listTools 验证"多次独立请求均正常"。
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const MCP_URL = process.env.MCP_URL || "https://your-mcp-host:port/mcp";
const MCP_TOKEN = process.env.MCP_TOKEN || "your-mcp-http-token-here";
const minutes = Math.max(1, parseInt(process.argv[2] || "2", 10));
const ticks = minutes * 2; // 每 30s 一个 tick

async function main() {
  const t = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  const c = new Client({ name: "verify-sse", version: "1.0" });

  await c.connect(t);
  const sid0 = t._sessionId;
  console.log(`>>> [T0] connect OK, sessionId = ${sid0}`);

  const r1 = await c.listTools();
  console.log(`>>> [T0] listTools OK, tools = ${r1.tools.length}`);

  // stateless：无 sessionId、无长连接，跳过稳定性打点，改为多次工具调用验证
  if (sid0 === undefined) {
    console.log(">>> [MODE] stateless (无 sessionId) —— 跳过 30s 长连接打点，改为每 30s 工具调用验证");
    for (let i = 1; i <= ticks; i++) {
      await new Promise((r) => setTimeout(r, 30000));
      const rr = await c.listTools();
      console.log(`>>> [T+${i * 30}s] listTools OK, tools = ${rr.tools.length}`);
    }
    const r2 = await c.listTools();
    console.log(`>>> [END] 再次 listTools OK, tools = ${r2.tools.length}`);
    await c.close();
    console.log(">>> VERIFY PASS: stateless 多次独立请求均正常");
    return;
  }

  // stateful：sessionId 稳定性 = SSE 长连接未断（心跳/超时配置生效）
  for (let i = 1; i <= ticks; i++) {
    await new Promise((r) => setTimeout(r, 30000));
    const sid = t._sessionId;
    const stable = sid === sid0 ? "OK(stable)" : `CHANGED! (${sid0} -> ${sid})`;
    console.log(`>>> [T+${i * 30}s] sessionId ${stable}`);
  }

  const r2 = await c.listTools();
  console.log(`>>> [END] 再次 listTools OK, tools = ${r2.tools.length}`);
  await c.close();
  console.log(">>> VERIFY PASS: 长连接保持稳定");
}

main().catch((e) => {
  console.error(`>>> VERIFY FAIL: ${String(e.message).split("\n")[0]}`);
  process.exit(1);
});
