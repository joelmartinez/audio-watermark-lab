import { useEffect, useRef, useState } from "react";
import { analyzeCarrier, calculateInputLevelDb, PAYLOAD_MATCH_THRESHOLD, PayloadCorrelator } from "../audio/watermark";
import type { DetectionReading, WatermarkSettings } from "../audio/types";
import { SignalCanvas } from "./SignalCanvas";

interface ReceiverPanelProps {
  settings: WatermarkSettings;
}

const emptyReading: DetectionReading = {
  inputLevelDb: -120,
  carrierDb: -120,
  noiseFloorDb: -120,
  snrDb: 0,
  confidence: 0,
  payloadConfidence: 0,
  carrierPresent: false,
  payloadMatched: false,
  detected: false,
};

export function ReceiverPanel({ settings }: ReceiverPanelProps) {
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [reading, setReading] = useState(emptyReading);
  const [error, setError] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef(0);
  const readingRef = useRef(emptyReading);
  const correlatorRef = useRef(new PayloadCorrelator());
  const lastUiUpdateRef = useRef(0);
  const settingsRef = useRef(settings);
  const lastCarrierAtRef = useRef<number | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const stop = () => {
    cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    contextRef.current?.close();
    streamRef.current = null;
    contextRef.current = null;
    correlatorRef.current.reset();
    readingRef.current = emptyReading;
    lastCarrierAtRef.current = null;
    setAnalyser(null);
    setListening(false);
    setReading(emptyReading);
  };

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: processing ? true : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const context = new AudioContext();
      const nextAnalyser = context.createAnalyser();
      nextAnalyser.fftSize = 8192;
      nextAnalyser.smoothingTimeConstant = 0.65;
      nextAnalyser.minDecibels = -120;
      nextAnalyser.maxDecibels = -20;
      const detectionAnalyser = context.createAnalyser();
      detectionAnalyser.fftSize = 2048;
      detectionAnalyser.smoothingTimeConstant = 0;
      detectionAnalyser.minDecibels = -120;
      detectionAnalyser.maxDecibels = -20;
      const microphone = context.createMediaStreamSource(stream);
      microphone.connect(nextAnalyser);
      microphone.connect(detectionAnalyser);
      streamRef.current = stream;
      contextRef.current = context;
      setAnalyser(nextAnalyser);
      setListening(true);

      const frequencyData = new Float32Array(detectionAnalyser.frequencyBinCount);
      const timeDomainData = new Float32Array(nextAnalyser.fftSize);
      const update = () => {
        detectionAnalyser.getFloatFrequencyData(frequencyData);
        nextAnalyser.getFloatTimeDomainData(timeDomainData);
        const activeSettings = settingsRef.current;
        const instant = analyzeCarrier(frequencyData, context.sampleRate, detectionAnalyser.fftSize, activeSettings.frequency, 9);
        const previous = readingRef.current;
        if (instant.carrierPresent) lastCarrierAtRef.current = context.currentTime;
        const carrierHoldSeconds = Math.max(0.8, activeSettings.chipDuration * 5);
        const carrierHeld = lastCarrierAtRef.current !== null
          && context.currentTime - lastCarrierAtRef.current < carrierHoldSeconds;
        const payloadConfidence = correlatorRef.current.observe(
          context.currentTime,
          instant.carrierPresent,
          activeSettings.chipDuration,
        );
        const smoothedCarrierConfidence = previous.confidence * 0.82 + instant.confidence * 0.18;
        const smoothedPayloadConfidence = previous.payloadConfidence * 0.9 + payloadConfidence * 0.1;
        const payloadMatched = smoothedPayloadConfidence >= PAYLOAD_MATCH_THRESHOLD;
        const smoothed = {
          ...instant,
          inputLevelDb: calculateInputLevelDb(timeDomainData),
          confidence: smoothedCarrierConfidence,
          payloadConfidence: smoothedPayloadConfidence,
          carrierPresent: carrierHeld,
          payloadMatched,
          detected: previous.detected
            ? carrierHeld
            : smoothedCarrierConfidence >= 0.72 && payloadMatched,
        };
        readingRef.current = smoothed;
        if (performance.now() - lastUiUpdateRef.current >= 100) {
          lastUiUpdateRef.current = performance.now();
          setReading(smoothed);
        }
        animationRef.current = requestAnimationFrame(update);
      };
      update();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Microphone access failed.");
    }
  };

  useEffect(() => stop, []);

  return (
    <section className="panel receiver-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">02 · Receiver</span>
          <h2>Listen through the air</h2>
        </div>
        <span className={`status-chip ${listening ? "live" : "neutral"}`}><i />{listening ? "Listening" : "Idle"}</span>
      </div>

      <div className="receiver-actions">
        <button className={listening ? "stop-button" : "primary-button"} onClick={listening ? stop : start}>
          {listening ? "Stop microphone" : "Start microphone"}
        </button>
        <label className="toggle-row">
          <input type="checkbox" checked={processing} disabled={listening} onChange={(event) => setProcessing(event.target.checked)} />
          <span>Simulate normal call processing</span>
        </label>
      </div>
      <p className="hint">Off requests raw capture. On allows browser echo cancellation, noise suppression, and automatic gain.</p>
      {error && <p className="error-message">{error}</p>}

      <div className="spectrum-wrap">
        <div className="chart-label"><span>Live spectrum</span><span>0 — 24 kHz</span></div>
        <SignalCanvas analyser={analyser} targetFrequency={settings.frequency} />
        <div className="carrier-marker" style={{ left: `${Math.min(96, (settings.frequency / 24000) * 100)}%` }}><span>{(settings.frequency / 1000).toFixed(1)}k</span></div>
      </div>

      <div className="readout-grid" aria-live="polite">
        <div className="confidence-card">
          <span>Watermark confidence</span>
          <strong>{Math.round(reading.confidence * 100)}%</strong>
          <div className="meter"><i style={{ width: `${reading.confidence * 100}%` }} /></div>
        </div>
        <div className={`verdict-card ${reading.detected ? "detected" : ""}`}>
          <span>{reading.detected ? "Payload lock" : reading.carrierPresent ? "Carrier present" : "Searching"}</span>
          <strong>{reading.detected ? "Watermark detected" : reading.carrierPresent ? "Pattern pending" : "No carrier yet"}</strong>
        </div>
      </div>

      <div className="metrics">
        <span>Mic input <strong>{reading.inputLevelDb.toFixed(1)} dBFS</strong></span>
        <span>Carrier <strong>{reading.carrierDb.toFixed(1)} dB</strong></span>
        <span>Noise floor <strong>{reading.noiseFloorDb.toFixed(1)} dB</strong></span>
        <span>Relative SNR <strong>{reading.snrDb.toFixed(1)} dB</strong></span>
        <span>Payload match <strong>{Math.round(reading.payloadConfidence * 100)}%</strong></span>
      </div>
    </section>
  );
}
