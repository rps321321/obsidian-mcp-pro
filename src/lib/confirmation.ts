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
}

export async function elicitTextConfirmation(
  server: McpServer,
  options: TextConfirmationOptions,
): Promise<TextConfirmationResult> {
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation === undefined) return { status: "skipped" };

  try {
    const elicit = await server.server.elicitInput({
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
    });

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
  } catch (err) {
    log.warn(`${options.tool}: elicitation skipped`, { err: err as Error });
    return { status: "skipped" };
  }
}
