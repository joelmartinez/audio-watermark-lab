import { useState } from "react";
import type { WatermarkSettings } from "./audio/types";
import { ReceiverPanel } from "./components/ReceiverPanel";
import { SourcePanel } from "./components/SourcePanel";

type ViewMode = "both" | "source" | "receiver";

export default function App() {
  const [mode, setMode] = useState<ViewMode>("both");
  const [settings, setSettings] = useState<WatermarkSettings>({ frequency: 18000, levelDb: -32, chipDuration: 0.16 });

  return (
    <main>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark"><i /><i /><i /><i /><i /></div>
          <div>
            <span>Experimental audio tooling</span>
            <h1>Audio Watermark Lab</h1>
          </div>
        </div>
        <nav className="mode-switch" aria-label="Page mode">
          {(["both", "source", "receiver"] as const).map((item) => (
            <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}</button>
          ))}
        </nav>
      </header>

      <div className="intro">
        <p>Speech becomes signal. Signal crosses the room. The receiver decides what survived.</p>
        <span>Target frequency / {(settings.frequency / 1000).toFixed(1)} kHz</span>
      </div>

      <div className={`lab-grid mode-${mode}`}>
        {mode !== "receiver" && <SourcePanel settings={settings} onSettingsChange={setSettings} />}
        {mode !== "source" && <ReceiverPanel settings={settings} />}
      </div>

      <footer>
        <span>AWL / Prototype 0.2</span>
        <p>Carrier presence and repeated chip-pattern correlation are shown separately.</p>
      </footer>
    </main>
  );
}
