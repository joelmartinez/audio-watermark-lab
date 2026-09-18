import { calculateInputLevelDb, mixWatermarkChannel } from "../watermark";
import type { LiveAudioSourceProvider, LivePlaybackSession, SpeechRequest, WatermarkSettings } from "../types";

interface LiveSessionResponse {
  sdp: string;
}

interface LiveEvent {
  type?: string;
  error?: { message?: string };
  delta?: string;
}

async function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      reject(new Error("Timed out while preparing the live audio connection."));
    }, 10_000);
    const onStateChange = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

export class OpenAiRealtimeProvider implements LiveAudioSourceProvider {
  readonly id = "openai-realtime";

  async start(
    request: SpeechRequest,
    settings: WatermarkSettings,
    options?: {
      onStatus?: (status: string) => void;
      onTranscript?: (transcript: string) => void;
      onOutputAnalyser?: (analyser: AnalyserNode | null) => void;
      onInputLevel?: (levelDb: number) => void;
      watermarkEnabled?: boolean;
    },
  ): Promise<LivePlaybackSession> {
    const connection = new RTCPeerConnection();
    const outputContext = new AudioContext({ latencyHint: "interactive" });
    await outputContext.resume();
    const events = connection.createDataChannel("oai-events");
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let analyser: AnalyserNode | null = null;
    const decoder = new Audio();
    let started = false;
    let samplesProcessed = 0;
    let stopped = false;
    let lastLevelReport = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      processor?.disconnect();
      source?.disconnect();
      analyser?.disconnect();
      options?.onOutputAnalyser?.(null);
      decoder.pause();
      decoder.srcObject = null;
      events.close();
      connection.close();
      void outputContext.close();
      options?.onStatus?.("Stopped");
    };

    const sendScript = () => {
      if (started || events.readyState !== "open") return;
      started = true;
      events.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request.text }],
        },
      }));
      events.send(JSON.stringify({
        type: "response.create",
        response: { output_modalities: ["audio"] },
      }));
      options?.onStatus?.("Streaming watermarked audio");
    };

    connection.addEventListener("track", (event) => {
      const remoteStream = event.streams[0];
      if (!remoteStream) {
        options?.onStatus?.("Live audio arrived without a playable media stream.");
        return;
      }
      source = outputContext.createMediaStreamSource(remoteStream);
      decoder.autoplay = true;
      decoder.muted = true;
      decoder.srcObject = remoteStream;
      void decoder.play();
      processor = outputContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = ({ inputBuffer, outputBuffer }) => {
        const input = inputBuffer.getChannelData(0);
        const output = outputBuffer.getChannelData(0);
        const inputLevelDb = calculateInputLevelDb(input);
        if (performance.now() - lastLevelReport >= 100) {
          lastLevelReport = performance.now();
          options?.onInputLevel?.(inputLevelDb);
        }
        if (options?.watermarkEnabled === false) {
          output.set(input);
        } else {
          mixWatermarkChannel(input, output, outputContext.sampleRate, settings, samplesProcessed);
        }
        samplesProcessed += input.length;
      };
      analyser = outputContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(processor);
      processor.connect(analyser);
      analyser.connect(outputContext.destination);
      options?.onOutputAnalyser?.(analyser);
      options?.onStatus?.("Receiving live audio");
      void outputContext.resume();
    });

    events.addEventListener("message", ({ data }) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(String(data)) as LiveEvent;
      } catch {
        return;
      }
      if (event.type === "session.started" || event.type === "session.created") {
        sendScript();
      } else if (event.type === "response.output_audio_transcript.delta" && event.delta) {
        options?.onTranscript?.(event.delta);
      } else if (event.type === "error") {
        options?.onStatus?.(event.error?.message ?? "The live audio service returned an error.");
      }
    });
    events.addEventListener("open", () => options?.onStatus?.("Live session ready"));
    events.addEventListener("close", () => {
      if (!stopped) options?.onStatus?.("Live session disconnected");
    });

    try {
      connection.addTransceiver("audio", { direction: "recvonly" });
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await waitForIceGathering(connection);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("Unable to prepare the live audio connection.");

      options?.onStatus?.("Connecting to OpenAI Live");
      const response = await fetch("/api/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, sdp }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Unable to start the live audio session.");
      }
      const result = await response.json() as LiveSessionResponse;
      await connection.setRemoteDescription({ type: "answer", sdp: result.sdp });
      await outputContext.resume();
      return { id: crypto.randomUUID(), stop };
    } catch (error) {
      stop();
      throw error;
    }
  }
}
