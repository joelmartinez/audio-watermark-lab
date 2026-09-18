import type { AudioSourceProvider, SpeechRequest } from "../types";

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  } | string;
}

export class SpeechGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SpeechGenerationError";
  }
}

function getApiError(body: ApiErrorResponse | null): { code?: string; message?: string } {
  if (typeof body?.error === "string") {
    return { message: body.error };
  }

  return body?.error ?? {};
}

export class OpenAiTtsProvider implements AudioSourceProvider {
  readonly id = "openai-tts";

  async generate(request: SpeechRequest, options?: { signal?: AbortSignal }): Promise<ArrayBuffer> {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: {
        Accept: "audio/wav",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options?.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
      const error = getApiError(body);
      throw new SpeechGenerationError(
        error.message ?? `Speech generation failed (${response.status}).`,
        response.status,
        error.code,
      );
    }

    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("audio/wav")) {
      throw new SpeechGenerationError("The TTS service returned an unexpected audio format.", response.status);
    }

    return response.arrayBuffer();
  }
}
