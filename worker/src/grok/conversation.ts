import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { getModelInfo, toGrokModel } from "./models";

export interface OpenAIChatMessage {
  role: string;
  content:
    | string
    | null
    | { type?: string; text?: string; image_url?: { url?: string }; input_audio?: { data?: string }; file?: { file_data?: string } }
    | Array<{
        type?: string;
        text?: string;
        image_url?: { url?: string };
        input_audio?: { data?: string };
        file?: { file_data?: string };
      }>;
}

export interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  video_config?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  };
}

export const CONVERSATION_API = "https://grok.com/rest/app-chat/conversations/new";

export function extractContent(messages: OpenAIChatMessage[]): { content: string; images: string[] } {
  const images: string[] = [];
  const files: string[] = [];
  const extracted: Array<{ role: string; text: string }> = [];

  for (const msg of messages) {
    const role = msg.role ?? "user";
    const content = msg.content;

    if (content == null) {
      if (role === "assistant") continue;
      throw new Error("Message content cannot be null");
    }

    const normalized = Array.isArray(content) ? content : typeof content === "object" ? [content] : content;
    const parts: string[] = [];

    if (Array.isArray(normalized)) {
      for (const item of normalized) {
        const itemType = item?.type ?? "text";
        if (itemType === "text" || itemType === "input_text" || itemType === "output_text") {
          const t = item?.text ?? "";
          if (String(t).trim()) parts.push(String(t));
          continue;
        }
        if (itemType === "image_url" || itemType === "input_image" || itemType === "image") {
          const url = item?.image_url?.url;
          if (url) images.push(url);
          continue;
        }
        if (itemType === "input_audio") {
          const data = item?.input_audio?.data;
          if (data) files.push(data);
          continue;
        }
        if (itemType === "file") {
          const data = item?.file?.file_data;
          if (data) files.push(data);
          continue;
        }
      }
    } else {
      const t = String(normalized);
      if (t.trim()) parts.push(t);
    }

    if (parts.length) extracted.push({ role, text: parts.join("\n") });
  }

  let lastUserIndex: number | null = null;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const out: string[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const role = extracted[i]!.role || "user";
    const text = extracted[i]!.text;
    if (i === lastUserIndex) out.push(text);
    else out.push(`${role}: ${text}`);
  }

  let combined = out.join("\n\n");
  if (!combined.trim() && (images.length || files.length)) {
    combined = "Refer to the following content:";
  }

  return { content: combined, images };
}

export function buildConversationPayload(args: {
  requestModel: string;
  content: string;
  imgIds: string[];
  imgUris: string[];
  postId?: string;
  videoConfig?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  };
  settings: GrokSettings;
}): { payload: Record<string, unknown>; referer?: string; isVideoModel: boolean } {
  const { requestModel, content, imgIds, imgUris, postId, settings } = args;
  const cfg = getModelInfo(requestModel);
  const { grokModel, mode, isVideoModel } = toGrokModel(requestModel);

  if (cfg?.is_video_model) {
    if (!postId) throw new Error("视频模型缺少 postId（需要先创建 media post）");

    const aspectRatio = (args.videoConfig?.aspect_ratio ?? "").trim() || "3:2";
    const videoLengthRaw = Number(args.videoConfig?.video_length ?? 6);
    const videoLengthBase = Number.isFinite(videoLengthRaw) ? Math.floor(videoLengthRaw) : 6;
    const videoLength = Math.min(30, Math.max(6, videoLengthBase));
    const resolutionInput = String(args.videoConfig?.resolution ?? "540p").trim().toLowerCase();
    const resolution = ["720p", "hd"].includes(resolutionInput) ? "720p" : "540p";
    const preset = (args.videoConfig?.preset ?? "normal").trim();

    let modeFlag = "--mode=custom";
    if (preset === "fun") modeFlag = "--mode=extremely-crazy";
    else if (preset === "normal") modeFlag = "--mode=normal";
    else if (preset === "spicy") modeFlag = "--mode=extremely-spicy-or-crazy";

    const prompt = `${String(content || "").trim()} ${modeFlag}`.trim();

    return {
      isVideoModel: true,
      referer: "https://grok.com/imagine",
      payload: {
        temporary: true,
        modelName: "grok-3",
        message: prompt,
        toolOverrides: { videoGen: true },
        enableSideBySide: true,
        responseMetadata: {
          experiments: [],
          modelConfigOverride: {
            modelMap: {
              videoGenModelConfig: {
                parentPostId: postId,
                aspectRatio,
                videoLength,
                videoResolution: resolution,
              },
            },
          },
        },
      },
    };
  }

  return {
    isVideoModel,
    payload: {
      temporary: settings.temporary ?? true,
      modelName: grokModel,
      message: content,
      fileAttachments: imgIds,
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: false,
      webpageUrls: [],
      disableTextFollowUps: true,
      responseMetadata: { requestModelDetails: { modelId: grokModel } },
      disableMemory: false,
      forceSideBySide: false,
      modelMode: mode,
      isAsyncChat: false,
    },
  };
}

export async function sendConversationRequest(args: {
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
}): Promise<Response> {
  const { payload, cookie, settings, referer } = args;
  const headers = getDynamicHeaders(settings, "/rest/app-chat/conversations/new");
  headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  const body = JSON.stringify(payload);

  return fetch(CONVERSATION_API, { method: "POST", headers, body });
}
