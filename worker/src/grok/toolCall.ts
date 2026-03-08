export interface OpenAIToolDefinition {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function stripCodeFences(text: string): string {
  const cleaned = String(text || "").trim();
  if (!cleaned.startsWith("```")) return cleaned;
  return cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim();
}

function extractJsonObject(text: string): string {
  const input = String(text || "");
  const start = input.indexOf("{");
  if (start === -1) return input;
  const end = input.lastIndexOf("}");
  if (end === -1 || end < start) return input.slice(start);
  return input.slice(start, end + 1);
}

function removeTrailingCommas(text: string): string {
  return String(text || "").replace(/,\s*([}\]])/g, "$1");
}

function balanceBraces(text: string): string {
  const input = String(text || "");
  let open = 0;
  let close = 0;
  let inString = false;
  let escape = false;
  for (const ch of input) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") open += 1;
    else if (ch === "}") close += 1;
  }
  if (open > close) return input + "}".repeat(open - close);
  return input;
}

function repairJson(text: string): unknown | null {
  const cleaned = balanceBraces(removeTrailingCommas(extractJsonObject(stripCodeFences(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ")));
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function parseToolCallBlock(rawJson: string, tools?: OpenAIToolDefinition[]): OpenAIToolCall | null {
  if (!rawJson) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = repairJson(rawJson);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const name = parsed.name;
  const argumentsValue = parsed.arguments ?? {};
  if (!name || typeof name !== "string") return null;

  const validNames = new Set(
    (tools || [])
      .filter((tool) => (tool?.type || "function") === "function")
      .map((tool) => tool.function?.name)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
  if (validNames.size && !validNames.has(name)) return null;

  const argumentsText =
    typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue ?? {}, null, 0);

  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

export function buildToolPrompt(
  tools?: OpenAIToolDefinition[],
  toolChoice?: unknown,
  parallelToolCalls: boolean = true,
): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  if (toolChoice === "none") return "";

  const lines: string[] = [
    "# Available Tools",
    "",
    'You have access to the following tools. To call a tool, output a <tool_call> block with a JSON object containing "name" and "arguments".',
    "",
    "Format:",
    "<tool_call>",
    '{"name": "function_name", "arguments": {"param": "value"}}',
    "</tool_call>",
    "",
  ];

  if (parallelToolCalls) {
    lines.push("You may make multiple tool calls in a single response by using multiple <tool_call> blocks.");
    lines.push("");
  }

  lines.push("## Tool Definitions", "");
  for (const tool of tools) {
    if ((tool?.type || "function") !== "function") continue;
    const fn = tool.function || {};
    const name = fn.name || "";
    const desc = fn.description || "";
    const params = fn.parameters;
    if (!name) continue;
    lines.push(`### ${name}`);
    if (desc) lines.push(desc);
    if (params !== undefined) lines.push(`Parameters: ${JSON.stringify(params)}`);
    lines.push("");
  }

  if (toolChoice === "required") {
    lines.push('IMPORTANT: You MUST call at least one tool in your response. Do not respond with only text.');
  } else if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const forcedName = (toolChoice as any)?.function?.name;
    if (typeof forcedName === "string" && forcedName.trim()) {
      lines.push(`IMPORTANT: You MUST call the tool "${forcedName}" in your response.`);
    }
  } else {
    lines.push("Decide whether to call a tool based on the user's request. If you don't need a tool, respond normally with text only.");
  }

  lines.push("", "When you call a tool, you may include text before or after the <tool_call> blocks, but the tool call blocks must be valid JSON.");
  return lines.join("\n");
}

export function formatToolHistory(messages: any[]): any[] {
  const out: any[] = [];
  for (const msg of messages || []) {
    const role = msg?.role || "";
    const content = msg?.content;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : null;
    const toolCallId = msg?.tool_call_id || "";
    const name = msg?.name || "unknown";

    if (role === "assistant" && toolCalls?.length) {
      const parts: string[] = [];
      if (typeof content === "string" && content.trim()) parts.push(content);
      for (const tc of toolCalls) {
        const fn = tc?.function || {};
        const tcName = fn.name || "";
        const tcArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        parts.push(`<tool_call>{"name":"${tcName}","arguments":${tcArgs}}</tool_call>`);
      }
      out.push({ role: "assistant", content: parts.join("\n") });
      continue;
    }

    if (role === "tool") {
      const contentText = typeof content === "string" ? content : JSON.stringify(content ?? "");
      out.push({ role: "user", content: `tool (${name}, ${toolCallId}): ${contentText}` });
      continue;
    }

    out.push(msg);
  }
  return out;
}

const TOOL_CALL_RE = /<tool_call>\s*(.*?)\s*<\/tool_call>/gs;

export function parseToolCalls(content: string, tools?: OpenAIToolDefinition[]): { textContent: string | null; toolCalls: OpenAIToolCall[] | null } {
  const input = String(content || "");
  if (!input) return { textContent: input, toolCalls: null };

  const matches = [...input.matchAll(TOOL_CALL_RE)];
  if (!matches.length) return { textContent: input, toolCalls: null };

  const toolCalls: OpenAIToolCall[] = [];
  for (const match of matches) {
    const raw = String(match[1] || "").trim();
    const parsed = parseToolCallBlock(raw, tools);
    if (parsed) toolCalls.push(parsed);
  }
  if (!toolCalls.length) return { textContent: input, toolCalls: null };

  const textParts: string[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    const before = input.slice(lastEnd, match.index ?? 0).trim();
    if (before) textParts.push(before);
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  const trailing = input.slice(lastEnd).trim();
  if (trailing) textParts.push(trailing);

  return {
    textContent: textParts.length ? textParts.join("\n") : null,
    toolCalls,
  };
}
