import type { DetectionReading, NormalizedPcmChunk, PcmAudioChunk, WatermarkSettings } from "./types";

const WATERMARK_PATTERN = [1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0];
const CHIP_EDGE_SECONDS = 0.006;
const MIN_DECIBELS = -120;
export const PAYLOAD_MATCH_THRESHOLD = 0.64;

export function getWatermarkPattern(): readonly number[] {
  return WATERMARK_PATTERN;
}

export function normalizePcmChunk(chunk: PcmAudioChunk): NormalizedPcmChunk {
  const { channels, sampleRate, encoding } = chunk.format;
  const bytesPerSample = encoding === "pcm_s16le" ? 2 : 4;
  if (chunk.data.byteLength % (channels * bytesPerSample) !== 0) {
    throw new Error("PCM chunk length must contain complete interleaved frames.");
  }

  const frames = chunk.data.byteLength / (channels * bytesPerSample);
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(chunk.data);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (frame * channels + channel) * bytesPerSample;
      const value = encoding === "pcm_s16le"
        ? view.getInt16(offset, true) / 0x8000
        : view.getFloat32(offset, true);
      output[channel][frame] = Math.max(-1, Math.min(1, value));
    }
  }
  return { channels: output, sampleRate, isFinal: chunk.isFinal };
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(data.slice(0));
  } finally {
    await context.close();
  }
}

export function applyWatermark(source: AudioBuffer, settings: WatermarkSettings): AudioBuffer {
  const output = new AudioBuffer({
    length: source.length,
    numberOfChannels: source.numberOfChannels,
    sampleRate: source.sampleRate,
  });
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    mixWatermarkChannel(source.getChannelData(channel), output.getChannelData(channel), source.sampleRate, settings);
  }

  return output;
}

export function mixWatermarkChannel(
  input: Float32Array,
  output: Float32Array,
  sampleRate: number,
  settings: WatermarkSettings,
  startSample = 0,
): void {
  const amplitude = 10 ** (settings.levelDb / 20);
  const chipSamples = Math.max(1, Math.round(settings.chipDuration * sampleRate));
  const edgeSamples = Math.min(Math.floor(chipSamples / 2), Math.max(1, Math.round(CHIP_EDGE_SECONDS * sampleRate)));

  for (let index = 0; index < input.length; index += 1) {
    const absoluteSample = startSample + index;
    const chipIndex = Math.floor(absoluteSample / chipSamples);
    const chipOffset = absoluteSample % chipSamples;
    const chip = WATERMARK_PATTERN[chipIndex % WATERMARK_PATTERN.length];
    const edgeDistance = Math.min(chipOffset, chipSamples - chipOffset - 1);
    const envelope = chip && edgeDistance < edgeSamples
      ? 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edgeDistance) / edgeSamples)
      : chip;
    const time = absoluteSample / sampleRate;
    const carrier = amplitude * envelope * Math.sin(2 * Math.PI * settings.frequency * time);
    const mixed = input[index] + carrier;
    output[index] = Math.abs(mixed) > 0.985 ? Math.tanh(mixed) / Math.tanh(1) : mixed;
  }
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const bytesPerSample = 2;
  const dataLength = buffer.length * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataLength);
  const view = new DataView(output);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let sample = 0; sample < buffer.length; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[sample]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([output], { type: "audio/wav" });
}

export function analyzeCarrier(
  frequencyData: Float32Array<ArrayBuffer>,
  sampleRate: number,
  fftSize: number,
  frequency: number,
  thresholdDb: number,
): DetectionReading {
  const binWidth = sampleRate / fftSize;
  const carrierBin = Math.max(2, Math.min(frequencyData.length - 3, Math.round(frequency / binWidth)));
  const carrierDb = Math.max(
    sanitizeDecibels(frequencyData[carrierBin - 1]),
    sanitizeDecibels(frequencyData[carrierBin]),
    sanitizeDecibels(frequencyData[carrierBin + 1]),
  );
  const neighbors: number[] = [];
  for (let offset = 5; offset <= 24; offset += 1) {
    if (carrierBin - offset >= 0) neighbors.push(sanitizeDecibels(frequencyData[carrierBin - offset]));
    if (carrierBin + offset < frequencyData.length) neighbors.push(sanitizeDecibels(frequencyData[carrierBin + offset]));
  }
  neighbors.sort((left, right) => left - right);
  const noiseFloorDb = neighbors[Math.floor(neighbors.length / 2)] ?? MIN_DECIBELS;
  const snrDb = carrierDb - noiseFloorDb;
  const confidence = Math.max(0, Math.min(1, 1 / (1 + Math.exp(-(snrDb - thresholdDb) / 2.5))));
  return {
    inputLevelDb: MIN_DECIBELS,
    carrierDb,
    noiseFloorDb,
    snrDb,
    confidence,
    payloadConfidence: 0,
    carrierPresent: confidence >= 0.62,
    payloadMatched: false,
    detected: false,
  };
}

export function calculateInputLevelDb(timeDomainData: Float32Array): number {
  let sumOfSquares = 0;
  for (const sample of timeDomainData) sumOfSquares += sample ** 2;
  const rms = Math.sqrt(sumOfSquares / timeDomainData.length);
  return rms > 0 && Number.isFinite(rms) ? Math.max(MIN_DECIBELS, 20 * Math.log10(rms)) : MIN_DECIBELS;
}

function sanitizeDecibels(value: number): number {
  return Number.isFinite(value) ? value : MIN_DECIBELS;
}

interface CarrierObservation {
  time: number;
  present: boolean;
}

export class PayloadCorrelator {
  private observations: CarrierObservation[] = [];
  private readonly pattern = WATERMARK_PATTERN;

  reset() {
    this.observations = [];
  }

  observe(time: number, carrierPresent: boolean, chipDuration: number): number {
    this.observations.push({ time, present: carrierPresent });
    const historySeconds = chipDuration * (this.pattern.length + 3);
    while (this.observations.length && this.observations[0].time < time - historySeconds) {
      this.observations.shift();
    }

    const requiredHistory = chipDuration * this.pattern.length;
    if (!this.observations.length || time - this.observations[0].time < requiredHistory) return 0;

    let best = -1;
    const phaseSteps = this.pattern.length * 12;
    for (let step = 0; step < phaseSteps; step += 1) {
      const phase = (step / phaseSteps) * requiredHistory;
      let score = 0;
      let count = 0;
      for (const observation of this.observations) {
        if (observation.time < time - requiredHistory) continue;
        const expected = this.pattern[Math.floor((observation.time + phase) / chipDuration) % this.pattern.length] === 1;
        score += expected === observation.present ? 1 : -1;
        count += 1;
      }
      if (count) best = Math.max(best, score / count);
    }
    return Math.max(0, (best + 1) / 2);
  }
}
