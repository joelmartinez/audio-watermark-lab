import { useEffect, useMemo, useRef, useState } from "react";
import { OpenAiRealtimeProvider } from "../audio/providers/openAiRealtime";
import type { LivePlaybackSession, WatermarkSettings } from "../audio/types";
import { SignalCanvas } from "./SignalCanvas";

interface SourcePanelProps {
  settings: WatermarkSettings;
  onSettingsChange: (settings: WatermarkSettings) => void;
}

export function SourcePanel({ settings, onSettingsChange }: SourcePanelProps) {
  const provider = useMemo(() => new OpenAiRealtimeProvider(), []);
  const [text, setText] = useState("This is a test of an acoustic watermark carried through ordinary speech.");
  const [voice, setVoice] = useState("marin");
  const [instructions, setInstructions] = useState("Warm, clear, measured delivery.");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [watermarkEnabled, setWatermarkEnabled] = useState(true);
  const [status, setStatus] = useState("Ready to stream");
  const [transcript, setTranscript] = useState("");
  const [outputAnalyser, setOutputAnalyser] = useState<AnalyserNode | null>(null);
  const [inputLevelDb, setInputLevelDb] = useState(-120);
  const [error, setError] = useState("");
  const sessionRef = useRef<LivePlaybackSession | null>(null);

  const start = async () => {
    setBusy(true);
    setError("");
    setTranscript("");
    try {
      const session = await provider.start(
        { text, voice, instructions },
        settings,
        {
          onStatus: setStatus,
          onTranscript: (delta) => setTranscript((current) => current + delta),
          onOutputAnalyser: setOutputAnalyser,
          onInputLevel: setInputLevelDb,
          watermarkEnabled,
        },
      );
      sessionRef.current = session;
      setLive(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to generate audio.");
      setStatus("Unable to start");
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setLive(false);
    setOutputAnalyser(null);
    setInputLevelDb(-120);
    setStatus("Ready to stream");
  };

  useEffect(() => () => stop(), []);

  return (
    <section className="panel source-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">01 · Transmitter</span>
          <h2>Shape the signal</h2>
        </div>
        <span className={`status-chip ${live ? "live" : "neutral"}`}><i />OpenAI Live</span>
      </div>

      <label className="field wide">
        <span>Script</span>
        <textarea value={text} maxLength={4096} onChange={(event) => setText(event.target.value)} />
        <small>{text.length} / 4096</small>
      </label>

      <div className="field-grid">
        <label className="field">
          <span>Voice</span>
          <select value={voice} onChange={(event) => setVoice(event.target.value)}>
            {['marin', 'cedar', 'coral', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Direction</span>
          <input value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        </label>
      </div>

      <div className="control-strip">
        <label>
          <span>Carrier</span>
          <strong>{(settings.frequency / 1000).toFixed(1)} kHz</strong>
          <input type="range" min="15000" max="20000" step="100" value={settings.frequency} onChange={(event) => onSettingsChange({ ...settings, frequency: Number(event.target.value) })} />
        </label>
        <label>
          <span>Level</span>
          <strong>{settings.levelDb} dB</strong>
          <input type="range" min="-48" max="-18" step="1" value={settings.levelDb} onChange={(event) => onSettingsChange({ ...settings, levelDb: Number(event.target.value) })} />
        </label>
        <label>
          <span>Chip duration</span>
          <strong>{Math.round(settings.chipDuration * 1000)} ms</strong>
          <input type="range" min="80" max="320" step="20" value={settings.chipDuration * 1000} onChange={(event) => onSettingsChange({ ...settings, chipDuration: Number(event.target.value) / 1000 })} />
        </label>
      </div>

      <label className="toggle-row source-toggle">
        <input
          type="checkbox"
          checked={watermarkEnabled}
          disabled={live || busy}
          onChange={(event) => setWatermarkEnabled(event.target.checked)}
        />
        <span>Inject watermark into live output (off = clean control)</span>
      </label>
      <button className={live ? "stop-button" : "primary-button"} onClick={live ? stop : start} disabled={busy || !text.trim()}>
        {busy ? "Connecting…" : live ? "Stop live transmission" : watermarkEnabled ? "Start live watermarked playback" : "Start live clean playback"}
      </button>
      {error && <p className="error-message">{error}</p>}

      <div className="preview-card">
        <div className="chart-label source-chart-label"><span>Live output spectrum</span><span>Post-watermark</span></div>
        <SignalCanvas analyser={outputAnalyser} targetFrequency={settings.frequency} accent={watermarkEnabled ? "#84f7c5" : "#8fa19a"} />
        <div className="live-readout">
          <span className={`track-label ${watermarkEnabled ? "marked" : ""}`}>Live transcript · {status}</span>
          <p>{transcript || `OpenAI Live speech will play ${watermarkEnabled ? "through the watermark encoder" : "through a clean bypass"} before speaker output.`}</p>
          <span className="signal-level">Remote speech (before watermark) <strong>{inputLevelDb.toFixed(1)} dBFS</strong></span>
        </div>
      </div>
    </section>
  );
}
