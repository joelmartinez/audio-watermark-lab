import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCarrier,
  calculateInputLevelDb,
  getWatermarkPattern,
  mixWatermarkChannel,
  normalizePcmChunk,
  PAYLOAD_MATCH_THRESHOLD,
  PayloadCorrelator,
} from "../src/audio/watermark";

test("normalizes interleaved signed-16 PCM", () => {
  const samples = new Int16Array([0, 32767, -32768, 16384]);
  const normalized = normalizePcmChunk({
    data: samples.buffer,
    format: { encoding: "pcm_s16le", sampleRate: 48_000, channels: 2 },
    isFinal: true,
  });

  assert.equal(normalized.sampleRate, 48_000);
  assert.equal(normalized.isFinal, true);
  assert.deepEqual([...normalized.channels[0]], [0, -1]);
  assert.deepEqual([...normalized.channels[1]], [32767 / 32768, 0.5]);
});

test("preserves a watermark across PCM chunk boundaries", () => {
  const settings = { frequency: 1_000, levelDb: -24, chipDuration: 0.08 };
  const input = new Float32Array(9_600);
  const whole = new Float32Array(input.length);
  const chunked = new Float32Array(input.length);
  mixWatermarkChannel(input, whole, 48_000, settings);
  mixWatermarkChannel(input.subarray(0, 4_800), chunked.subarray(0, 4_800), 48_000, settings);
  mixWatermarkChannel(input.subarray(4_800), chunked.subarray(4_800), 48_000, settings, 4_800);

  assert.deepEqual([...chunked], [...whole]);
  assert.ok(whole.some((sample, index) => index < 3_840 && Math.abs(sample) > 0));
  assert.ok(whole.subarray(3_840, 7_680).every((sample) => sample === 0));
});

test("returns finite readings for silent analyser frames", () => {
  const reading = analyzeCarrier(new Float32Array(4_096).fill(-Infinity), 48_000, 8_192, 18_000, 9);

  assert.deepEqual(reading, {
    inputLevelDb: -120,
    carrierDb: -120,
    noiseFloorDb: -120,
    snrDb: 0,
    confidence: 1 / (1 + Math.exp(9 / 2.5)),
    payloadConfidence: 0,
    carrierPresent: false,
    payloadMatched: false,
    detected: false,
  });
});

test("measures time-domain microphone input level", () => {
  assert.equal(calculateInputLevelDb(new Float32Array(128)), -120);
  const tone = new Float32Array(128).fill(0.5);
  assert.equal(calculateInputLevelDb(tone), -6.020599913279624);
});

test("matches the repeated watermark pattern but rejects silence", () => {
  const pattern = getWatermarkPattern();
  const marked = new PayloadCorrelator();
  const clean = new PayloadCorrelator();
  let markedScore = 0;
  let cleanScore = 0;

  for (let time = 0; time <= 2.7; time += 0.02) {
    markedScore = marked.observe(time, pattern[Math.floor(time / 0.08) % pattern.length] === 1, 0.08);
    cleanScore = clean.observe(time, false, 0.08);
  }

  assert.ok(markedScore >= PAYLOAD_MATCH_THRESHOLD);
  assert.ok(cleanScore < PAYLOAD_MATCH_THRESHOLD);
});
