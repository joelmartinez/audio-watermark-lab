import { useEffect, useRef } from "react";

interface SignalCanvasProps {
  analyser?: AnalyserNode | null;
  buffer?: AudioBuffer | null;
  accent?: string;
  targetFrequency?: number;
}

const BACKGROUND = "#070b0a";
const MAX_DISPLAY_FREQUENCY = 24_000;
const TARGET_BANDWIDTH = 1_200;

const formatFrequency = (frequency: number) => (frequency === 0 ? "0" : `${frequency / 1_000}k`);

export function SignalCanvas({ analyser, buffer, accent = "#84f7c5", targetFrequency = 18_000 }: SignalCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const sizeCanvas = () => {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      if (!nextWidth || !nextHeight) return false;
      if (width === nextWidth && height === nextHeight && pixelRatio === nextPixelRatio) return false;

      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextPixelRatio;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      return true;
    };

    const drawFrame = (frequencyCeiling?: number, persist = false) => {
      if (!persist) context.clearRect(0, 0, width, height);
      context.fillStyle = persist ? "rgba(7, 11, 10, .18)" : BACKGROUND;
      context.fillRect(0, 0, width, height);

      const inset = { top: 14, right: 12, bottom: frequencyCeiling ? 24 : 12, left: 12 };
      const graphWidth = width - inset.left - inset.right;
      const graphHeight = height - inset.top - inset.bottom;

      if (frequencyCeiling) {
        const targetStart = Math.max(0, targetFrequency - TARGET_BANDWIDTH) / frequencyCeiling;
        const targetEnd = Math.min(frequencyCeiling, targetFrequency + TARGET_BANDWIDTH) / frequencyCeiling;
        if (targetStart < 1 && targetEnd > 0) {
          const targetGradient = context.createLinearGradient(0, inset.top, 0, inset.top + graphHeight);
          targetGradient.addColorStop(0, "rgba(218, 255, 130, .10)");
          targetGradient.addColorStop(1, "rgba(218, 255, 130, .018)");
          context.fillStyle = targetGradient;
          context.fillRect(inset.left + graphWidth * targetStart, inset.top, graphWidth * (targetEnd - targetStart), graphHeight);
        }

        context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        context.textAlign = "center";
        context.textBaseline = "top";
        const labels = [0, 6_000, 12_000, 18_000, 24_000].filter((frequency) => frequency <= frequencyCeiling);
        for (const frequency of labels) {
          const x = inset.left + (frequency / frequencyCeiling) * graphWidth;
          context.strokeStyle = frequency === targetFrequency ? "rgba(218, 255, 130, .26)" : "rgba(220, 255, 239, .075)";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(Math.round(x) + 0.5, inset.top);
          context.lineTo(Math.round(x) + 0.5, inset.top + graphHeight);
          context.stroke();
          context.fillStyle = frequency === targetFrequency ? "rgba(225, 255, 157, .86)" : "rgba(195, 220, 210, .48)";
          context.fillText(formatFrequency(frequency), x, height - 15);
        }
        context.textAlign = "left";
        context.fillStyle = "rgba(225, 255, 157, .75)";
        context.fillText("target", inset.left + graphWidth * targetStart + 5, inset.top + 5);
      }

      context.strokeStyle = "rgba(220, 255, 239, .055)";
      context.lineWidth = 1;
      for (let line = 1; line < 4; line += 1) {
        const y = inset.top + (graphHeight / 4) * line;
        context.beginPath();
        context.moveTo(inset.left, Math.round(y) + 0.5);
        context.lineTo(width - inset.right, Math.round(y) + 0.5);
        context.stroke();
      }
      return { inset, graphWidth, graphHeight };
    };

    const drawWaveform = () => {
      sizeCanvas();
      if (!width || !height) return;
      const { inset, graphWidth, graphHeight } = drawFrame();
      const samples = buffer?.getChannelData(0);
      const centerY = inset.top + graphHeight / 2;
      const columns = Math.max(1, Math.floor(graphWidth));
      const samplesPerColumn = samples ? Math.max(1, Math.floor(samples.length / columns)) : 1;

      context.beginPath();
      for (let column = 0; column <= columns; column += 1) {
        const sampleStart = samples ? Math.min(samples.length - 1, column * samplesPerColumn) : 0;
        const sampleEnd = samples ? Math.min(samples.length, sampleStart + samplesPerColumn) : 0;
        let minimum = 0;
        let maximum = 0;
        if (samples) {
          for (let index = sampleStart; index < sampleEnd; index += 1) {
            minimum = Math.min(minimum, samples[index]);
            maximum = Math.max(maximum, samples[index]);
          }
        } else {
          const envelope = 0.1 + 0.06 * Math.sin(column * 0.027);
          minimum = -envelope * (0.45 + 0.55 * Math.sin(column * 0.053) ** 2);
          maximum = -minimum;
        }
        const x = inset.left + column;
        context.moveTo(x, centerY + minimum * graphHeight * 0.42);
        context.lineTo(x, centerY + maximum * graphHeight * 0.42);
      }
      context.strokeStyle = accent;
      context.globalAlpha = 0.74;
      context.lineWidth = 1;
      context.shadowBlur = 10;
      context.shadowColor = accent;
      context.stroke();
      context.shadowBlur = 0;
      context.globalAlpha = 1;

      context.strokeStyle = "rgba(215, 255, 238, .17)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(inset.left, Math.round(centerY) + 0.5);
      context.lineTo(width - inset.right, Math.round(centerY) + 0.5);
      context.stroke();
    };

    const resizeObserver = new ResizeObserver(() => {
      if (!analyser) drawWaveform();
    });
    resizeObserver.observe(canvas);

    if (!analyser) {
      drawWaveform();
      return () => resizeObserver.disconnect();
    }

    const values = new Float32Array(analyser.frequencyBinCount);
    const render = () => {
      const resized = sizeCanvas();
      if (!width || !height) {
        frame = requestAnimationFrame(render);
        return;
      }
      const frequencyCeiling = Math.min(MAX_DISPLAY_FREQUENCY, analyser.context.sampleRate / 2);
      const { inset, graphWidth, graphHeight } = drawFrame(frequencyCeiling, !resized);
      analyser.getFloatFrequencyData(values);
      const visibleBins = Math.max(1, Math.floor((frequencyCeiling / (analyser.context.sampleRate / 2)) * values.length));
      const gradient = context.createLinearGradient(0, inset.top, 0, inset.top + graphHeight);
      gradient.addColorStop(0, "rgba(230, 255, 173, .52)");
      gradient.addColorStop(0.56, "rgba(132, 247, 197, .14)");
      gradient.addColorStop(1, "rgba(132, 247, 197, 0)");

      context.beginPath();
      context.moveTo(inset.left, inset.top + graphHeight);
      for (let pixel = 0; pixel <= graphWidth; pixel += 2) {
        const bin = Math.min(visibleBins - 1, Math.round((pixel / graphWidth) * (visibleBins - 1)));
        const normalized = Math.max(0, Math.min(1, (values[bin] + 108) / 88));
        context.lineTo(inset.left + pixel, inset.top + graphHeight - normalized * graphHeight * 0.96);
      }
      context.lineTo(inset.left + graphWidth, inset.top + graphHeight);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();

      context.beginPath();
      for (let pixel = 0; pixel <= graphWidth; pixel += 2) {
        const bin = Math.min(visibleBins - 1, Math.round((pixel / graphWidth) * (visibleBins - 1)));
        const normalized = Math.max(0, Math.min(1, (values[bin] + 108) / 88));
        const x = inset.left + pixel;
        const y = inset.top + graphHeight - normalized * graphHeight * 0.96;
        if (pixel === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = accent;
      context.lineWidth = 1.35;
      context.shadowBlur = 13;
      context.shadowColor = accent;
      context.stroke();
      context.shadowBlur = 0;
      frame = requestAnimationFrame(render);
    };

    render();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [accent, analyser, buffer, targetFrequency]);

  const label = analyser
    ? "Live audio spectrum with a highlighted watermark target near 18 kilohertz"
    : buffer
      ? "Audio waveform preview"
      : "Audio waveform preview awaiting a generated signal";

  return <canvas ref={canvasRef} className="signal-canvas" role="img" aria-label={label} />;
}
