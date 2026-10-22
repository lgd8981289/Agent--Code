import { Inject, Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseToolOutput,
  type BusinessTool,
  type ToolOutput,
} from "../shared/business-tools.js";
import type { Actor } from "../shared/types.js";
import { root } from "./config.js";

@Injectable()
export class McpBridge implements OnModuleDestroy {
  private clients = new Map<string, Promise<Client>>();
  private closing = false;
  constructor(
    @Optional()
    @Inject("MCP_ENV")
    private overrides: Record<string, string> = {},
  ) {}
  private async client(actor: Actor) {
    if (this.closing) throw new Error("MCP 服务正在关闭");
    if (!this.clients.has(actor.id)) {
      const connection = (async () => {
        const built = join(root, "dist/mcp/main.js");
        const args =
          process.env.NODE_ENV === "production" && existsSync(built)
            ? [built]
            : ["--import", "tsx", join(root, "mcp/main.ts")];
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args,
          cwd: root,
          env: { ...env, ...this.overrides, MCP_ACTOR_ID: actor.id },
          stderr: "pipe",
        });
        const client = new Client({
          name: "aftersales-host",
          version: "1.0.0",
        });
        client.onclose = () => {
          // 旧连接迟到的关闭事件不能删除已经建立的新连接。
          if (this.clients.get(actor.id) === connection) this.clients.delete(actor.id);
        };
        await client.connect(transport);
        return client;
      })().catch((e) => {
        if (this.clients.get(actor.id) === connection) this.clients.delete(actor.id);
        throw e;
      });
      this.clients.set(actor.id, connection);
    }
    return this.clients.get(actor.id)!;
  }

  /** 调用指定的 MCP 业务工具，解析返回结果并校验数据格式。 */
  async call<N extends BusinessTool>(
    actor: Actor,
    name: N,
    args: Record<string, unknown> = {},
  ): Promise<ToolOutput<N>> {
    // 获取当前用户对应的 MCP Client。
    const client = await this.client(actor);

    // 调用指定的 MCP 工具，传入工具名称和参数，超时时间为 20 秒。
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 20000,
    });

    // MCP 工具返回的 content 可能包含多个内容块，这里按文本内容块处理。
    const blocks = response.content as { type: string; text?: string }[];

    // 提取所有文本类型的内容，并使用换行符拼接。
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // 将工具返回的 JSON 字符串解析为数据对象。
    const value: unknown = JSON.parse(text);

    // 如果 MCP 工具报告执行失败，则提取错误信息并抛出异常。
    if (response.isError) {
      // 优先使用工具返回的 error 字段，否则使用默认错误提示。
      const message =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : "业务工具执行失败";

      throw new Error(message);
    }

    // 根据工具名称校验并解析返回数据，得到对应工具的类型化结果。
    return parseToolOutput(name, value);
  }

  async onModuleDestroy() {
    this.closing = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (p) => (await p).close()));
  }
}
