import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "./logger.js";

export type TextConfirmationResult =
  | { status: "confirmed" }
  | { status: "skipped" }
  | { status: "cancelled" }
  | { status: "mismatch"; value: unknown };

interface TextConfirmationOptions {
  tool: string;
  message: string;
  fieldName: string;
  fieldDescription: string;
  expectedValue: string;
  signal?: AbortSignal;
}

export async function elicitTextConfirmation(
  server: McpServer,
  options: TextConfirmationOptions
): Promise<TextConfirmationResult> {
  try {
    options.signal?.throwIfAborted();
    const caps = server.server.getClientCapabilities();
    if (caps?.elicitation?.form === undefined) return { status: "skipped" };

    const elicit = await server.server.elicitInput(
      {
        message: options.message,
        requestedSchema: {
          type: "object",
          properties: {
            [options.fieldName]: {
              type: "string",
              description: options.fieldDescription,
            },
          },
          required: [options.fieldName],
        },
      },
      { signal: options.signal }
    );
    options.signal?.throwIfAborted();

    if (elicit.action !== "accept") return { status: "cancelled" };

    const confirmed = elicit.content?.[options.fieldName];
    if (confirmed === undefined || confirmed === null || confirmed === "") {
      return { status: "cancelled" };
    }
    if (
      typeof confirmed !== "string" ||
      confirmed.trim() !== options.expectedValue
    ) {
      return { status: "mismatch", value: confirmed };
    }
    return { status: "confirmed" };
  } catch {
    log.warn("Interactive confirmation failed; operation aborted", {
      tool: options.tool,
    });
    throw new Error(
      "Interactive confirmation failed; operation aborted. Resolve the confirmation failure before retrying."
    );
  }
}
