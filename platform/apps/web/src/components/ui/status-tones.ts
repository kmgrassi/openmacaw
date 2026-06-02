import { cn } from "../../lib/cn";

export type StatusTone =
  | "success"
  | "error"
  | "warning"
  | "info"
  | "running"
  | "idle"
  | "neutral";

type StatusToneClasses = {
  pill: string;
  panel: string;
  dot: string;
  text: string;
};

const STATUS_TONE_CLASSES: Record<StatusTone, StatusToneClasses> = {
  success: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    panel: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
  },
  error: {
    pill: "border-red-500/30 bg-red-500/10 text-red-200",
    panel: "border-red-500/40 bg-red-500/10 text-red-300",
    dot: "bg-red-400",
    text: "text-red-400",
  },
  warning: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    panel: "border-amber-400/40 bg-amber-500/10 text-amber-200",
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  info: {
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-200",
    panel: "border-blue-500/40 bg-blue-500/10 text-blue-200",
    dot: "bg-blue-400",
    text: "text-blue-300",
  },
  running: {
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-200",
    panel: "border-blue-500/40 bg-blue-500/10 text-blue-200",
    dot: "bg-blue-400",
    text: "text-blue-300",
  },
  idle: {
    pill: "border-slate-700 bg-slate-900 text-slate-300",
    panel: "border-slate-700 bg-slate-800/60 text-slate-300",
    dot: "bg-slate-600",
    text: "text-slate-500",
  },
  neutral: {
    pill: "border-slate-700 bg-slate-900 text-slate-300",
    panel: "border-slate-700 bg-slate-800/60 text-slate-300",
    dot: "bg-slate-500",
    text: "text-slate-400",
  },
};

const STATUS_VALUE_TONES: Record<string, StatusTone> = {
  activating: "running",
  awaiting_review: "running",
  blocked: "error",
  complete: "success",
  completed: "success",
  connected: "success",
  connecting: "running",
  disconnected: "error",
  done: "success",
  error: "error",
  fail: "error",
  failed: "error",
  healthy: "success",
  idle: "idle",
  in_progress: "running",
  merged: "success",
  missing: "warning",
  pass: "success",
  ready: "success",
  running: "running",
  scope_missing: "warning",
  stopped: "idle",
  success: "success",
  unhealthy: "error",
  warning: "warning",
};

export function statusToneForValue(
  value: string | null | undefined,
  fallback: StatusTone = "neutral",
) {
  return STATUS_VALUE_TONES[value ?? ""] ?? fallback;
}

export function statusToneClass(
  tone: StatusTone,
  target: keyof StatusToneClasses,
) {
  return STATUS_TONE_CLASSES[tone][target];
}

export function statusToneDotClass(
  tone: StatusTone,
  options: { glow?: boolean; pulse?: boolean } = {},
) {
  return cn(
    statusToneClass(tone, "dot"),
    options.glow &&
      tone === "success" &&
      "shadow-[0_0_4px_rgba(52,211,153,0.5)]",
    options.glow &&
      tone === "error" &&
      "shadow-[0_0_4px_rgba(248,113,113,0.45)]",
    options.pulse && "animate-pulse",
  );
}
