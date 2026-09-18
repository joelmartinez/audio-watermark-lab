export interface SpeechRequest {
  text: string;
  voice: string;
  instructions?: string;
}

export interface AudioSourceProvider {
  readonly id: string;
  generate(request: SpeechRequest, options?: SpeechGenerationOptions): Promise<ArrayBuffer>;
}

export interface SpeechGenerationOptions {
  signal?: AbortSignal;
}

export interface PcmAudioFormat {
  encoding: "pcm_s16le" | "pcm_f32le";
  sampleRate: number;
  channels: number;
}

export interface PcmAudioChunk {
  data: ArrayBuffer;
  format: PcmAudioFormat;
  isFinal: boolean;
}

export interface NormalizedPcmChunk {
  channels: Float32Array[];
  sampleRate: number;
  isFinal: boolean;
}

export interface StreamingAudioSourceProvider {
  readonly id: string;
  stream(request: SpeechRequest, options?: SpeechGenerationOptions): AsyncIterable<PcmAudioChunk>;
}

export interface LivePlaybackSession {
  readonly id: string;
  stop(): void;
}

export interface LiveAudioSourceProvider {
  readonly id: string;
  start(
    request: SpeechRequest,
    settings: WatermarkSettings,
    options?: {
      onStatus?: (status: string) => void;
      onTranscript?: (transcript: string) => void;
      onOutputAnalyser?: (analyser: AnalyserNode | null) => void;
      onInputLevel?: (levelDb: number) => void;
      onEnded?: () => void;
      watermarkEnabled?: boolean;
    },
  ): Promise<LivePlaybackSession>;
}

export interface WatermarkSettings {
  frequency: number;
  levelDb: number;
  chipDuration: number;
}

export interface DetectionReading {
  inputLevelDb: number;
  carrierDb: number;
  noiseFloorDb: number;
  snrDb: number;
  confidence: number;
  payloadConfidence: number;
  carrierPresent: boolean;
  payloadMatched: boolean;
  detected: boolean;
}
