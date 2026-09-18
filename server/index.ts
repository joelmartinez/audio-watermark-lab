import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const MAX_TEXT_LENGTH = 4096;
const MAX_INSTRUCTIONS_LENGTH = 1024;
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);
const DEFAULT_VOICE = "marin";
const DEFAULT_INSTRUCTIONS = "Speak clearly and naturally.";
const LIVE_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const LIVE_VOICES = new Set(["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"]);

interface TtsRequest {
  text: string;
  voice: string;
  instructions?: string;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

interface LiveSessionRequest extends TtsRequest {
  sdp: string;
}

function sendApiError(
  response: express.Response,
  status: number,
  code: string,
  message: string,
) {
  const body: ApiErrorBody = { error: { code, message } };
  response.status(status).json(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTtsRequest(body: unknown): TtsRequest | ApiErrorBody {
  if (!isRecord(body)) {
    return { error: { code: "invalid_request", message: "Request body must be a JSON object." } };
  }

  if (typeof body.text !== "string") {
    return { error: { code: "invalid_text", message: "Text must be a string." } };
  }

  const text = body.text.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return {
      error: {
        code: "invalid_text",
        message: `Text must contain 1–${MAX_TEXT_LENGTH} characters.`,
      },
    };
  }

  if (body.voice !== undefined && typeof body.voice !== "string") {
    return { error: { code: "invalid_voice", message: "Voice must be a string." } };
  }

  const voice = body.voice?.trim() || DEFAULT_VOICE;
  if (!TTS_VOICES.has(voice)) {
    return { error: { code: "invalid_voice", message: "Choose a supported TTS voice." } };
  }

  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    return { error: { code: "invalid_instructions", message: "Instructions must be a string." } };
  }

  const instructions = body.instructions?.trim();
  if (instructions && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return {
      error: {
        code: "invalid_instructions",
        message: `Instructions must not exceed ${MAX_INSTRUCTIONS_LENGTH} characters.`,
      },
    };
  }

  return { text, voice, instructions };
}

function isApiErrorBody(value: TtsRequest | ApiErrorBody): value is ApiErrorBody {
  return "error" in value;
}

function parseLiveSessionRequest(body: unknown): LiveSessionRequest | ApiErrorBody {
  const speechRequest = parseTtsRequest(body);
  if (isApiErrorBody(speechRequest)) return speechRequest;
  if (!isRecord(body) || typeof body.sdp !== "string" || !body.sdp.trim() || body.sdp.length > 24_000) {
    return { error: { code: "invalid_sdp", message: "A valid WebRTC session offer is required." } };
  }
  if (!LIVE_VOICES.has(speechRequest.voice)) {
    return { error: { code: "invalid_live_voice", message: "Choose a voice supported by OpenAI Live." } };
  }
  return { ...speechRequest, sdp: body.sdp };
}

function getProviderFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof OpenAI.RateLimitError) {
    return { status: 429, code: "tts_rate_limited", message: "The TTS provider is busy. Please try again shortly." };
  }

  if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return { status: 502, code: "tts_provider_unreachable", message: "The TTS provider is temporarily unreachable." };
  }

  if (error instanceof OpenAI.APIError) {
    return { status: 502, code: "tts_provider_error", message: "The TTS provider could not generate audio." };
  }

  return { status: 500, code: "tts_generation_failed", message: "Speech generation failed. Please try again." };
}

app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, ttsConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post("/api/tts", async (request, response) => {
  const speechRequest = parseTtsRequest(request.body);
  if (isApiErrorBody(speechRequest)) {
    response.status(400).json(speechRequest);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    sendApiError(response, 503, "tts_not_configured", "TTS is not configured on this server.");
    return;
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const speech = await client.audio.speech.create({
      model: TTS_MODEL,
      voice: speechRequest.voice,
      input: speechRequest.text,
      instructions: speechRequest.instructions || DEFAULT_INSTRUCTIONS,
      response_format: "wav",
    });

    const audio = Buffer.from(await speech.arrayBuffer());
    if (audio.length === 0) {
      sendApiError(response, 502, "tts_empty_response", "The TTS provider returned no audio. Please try again.");
      return;
    }

    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", audio.length);
    response.send(audio);
  } catch (error) {
    const failure = getProviderFailure(error);
    const requestId = error instanceof OpenAI.APIError ? error.requestID : undefined;
    console.error("OpenAI TTS request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      status: error instanceof OpenAI.APIError ? error.status : undefined,
      requestId,
    });
    sendApiError(response, failure.status, failure.code, failure.message);
  }
});

app.post("/api/live/session", async (request, response) => {
  const liveRequest = parseLiveSessionRequest(request.body);
  if (isApiErrorBody(liveRequest)) {
    response.status(400).json(liveRequest);
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    sendApiError(response, 503, "live_not_configured", "OpenAI Live is not configured on this server.");
    return;
  }

  try {
    const form = new FormData();
    form.set("sdp", liveRequest.sdp);
    form.set("session", JSON.stringify({
      type: "realtime",
      model: LIVE_MODEL,
      instructions: `Read the user's supplied script aloud verbatim. ${liveRequest.instructions || DEFAULT_INSTRUCTIONS}`,
      audio: { output: { voice: liveRequest.voice } },
    }));
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const answerSdp = await upstream.text();
    if (!upstream.ok || !answerSdp.trim()) {
      console.error("OpenAI Live session creation failed", { status: upstream.status });
      sendApiError(response, 502, "live_session_failed", "OpenAI Live could not start an audio session.");
      return;
    }
    response.status(201).json({ sdp: answerSdp });
  } catch (error) {
    console.error("OpenAI Live session request failed", { name: error instanceof Error ? error.name : "UnknownError" });
    sendApiError(response, 502, "live_provider_unreachable", "OpenAI Live is temporarily unreachable.");
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    sendApiError(response, 400, "invalid_json", "Request body must contain valid JSON.");
    return;
  }

  if (isRecord(error) && error.type === "entity.too.large") {
    sendApiError(response, 413, "request_too_large", "Request body is too large.");
    return;
  }

  console.error("Unhandled API request error", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  sendApiError(response, 500, "internal_error", "The server could not process this request.");
});

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory = path.resolve(currentDirectory, "../dist");
app.use(express.static(distributionDirectory));
app.get("/{*splat}", (_request, response) => {
  response.sendFile(path.join(distributionDirectory, "index.html"));
});

app.listen(port, () => {
  console.log(`Audio Watermark Lab server listening on http://localhost:${port}`);
});
