import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorkItemProjection } from "../../api/plans";
import { useSnoozeWorkItemMutation } from "../../api/query-hooks";
import type { SnoozeWorkItemInput } from "../../api/work-items";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type Props = {
  workspaceId: string;
  workItemId: string;
  onSnoozed: (workItem: WorkItemProjection) => void;
  onError?: (message: string) => void;
};

type Preset = {
  key: string;
  label: string;
  resolve: () => SnoozeWorkItemInput;
};

function toIsoFromLocalInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function nextNineAm() {
  const date = new Date();
  date.setHours(9, 0, 0, 0);
  if (date.getTime() <= Date.now()) {
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString();
}

function tomorrowNineAm() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function localDatetimeMin() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

const POPOVER_WIDTH = 320;
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 8;

export function SnoozeButton({
  workspaceId,
  workItemId,
  onSnoozed,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [customUntil, setCustomUntil] = useState("");
  const [reason, setReason] = useState("");
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const snoozeMutation = useSnoozeWorkItemMutation(workspaceId);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function recompute() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = rect.right - POPOVER_WIDTH;
      left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(left, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
      );
      let top = rect.bottom + POPOVER_GAP;
      const popover = popoverRef.current;
      const popoverHeight = popover?.offsetHeight ?? 0;
      if (
        popoverHeight > 0 &&
        top + popoverHeight > viewportHeight - VIEWPORT_MARGIN &&
        rect.top - POPOVER_GAP - popoverHeight >= VIEWPORT_MARGIN
      ) {
        top = rect.top - POPOVER_GAP - popoverHeight;
      }
      setPosition({ top, left });
    }
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const presets = useMemo<Preset[]>(
    () => [
      { key: "1h", label: "1 h", resolve: () => ({ seconds: 60 * 60 }) },
      { key: "4h", label: "4 h", resolve: () => ({ seconds: 4 * 60 * 60 }) },
      {
        key: "9am",
        label: "Until 9am",
        resolve: () => ({ until: nextNineAm() }),
      },
      {
        key: "tomorrow",
        label: "Tomorrow",
        resolve: () => ({ until: tomorrowNineAm() }),
      },
      {
        key: "indefinite",
        label: "Indefinite",
        resolve: () => ({ indefinite: true }),
      },
    ],
    [],
  );

  async function submit(key: string, input: SnoozeWorkItemInput) {
    setSubmittingKey(key);
    setError(null);
    onError?.("");
    try {
      const cleanReason = reason.trim();
      const response = await snoozeMutation.mutateAsync({
        workItemId,
        input: {
          ...input,
          ...(cleanReason ? { reason: cleanReason } : {}),
        },
      });
      onSnoozed(response.workItem);
      setOpen(false);
      setCustomUntil("");
      setReason("");
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      onError?.(message);
    } finally {
      setSubmittingKey(null);
    }
  }

  const customIso = customUntil ? toIsoFromLocalInput(customUntil) : null;
  const customIsPast = customIso
    ? new Date(customIso).getTime() <= Date.now()
    : false;
  const customDisabled = !customIso || customIsPast || submittingKey !== null;

  const popover = open
    ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Snooze work item"
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            width: POPOVER_WIDTH,
            visibility: position ? "visible" : "hidden",
          }}
          className="z-50 rounded-md border border-border bg-slate-950 p-3 text-left shadow-xl"
        >
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.key}
                type="button"
                size="sm"
                variant="secondary"
                loading={submittingKey === preset.key}
                disabled={submittingKey !== null}
                onClick={() => void submit(preset.key, preset.resolve())}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <div className="mt-3 space-y-3">
            <Input
              label="Custom datetime"
              type="datetime-local"
              min={localDatetimeMin()}
              value={customUntil}
              onChange={(event) => setCustomUntil(event.target.value)}
              error={customIsPast ? "Choose a future time." : undefined}
            />
            <Input
              label="Reason"
              value={reason}
              maxLength={500}
              placeholder="Optional"
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                loading={submittingKey === "custom"}
                disabled={customDisabled}
                onClick={() => {
                  if (!customIso || customIsPast) return;
                  void submit("custom", { until: customIso });
                }}
              >
                Set snooze
              </Button>
            </div>
          </div>

          {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="inline-flex">
      <Button
        ref={triggerRef}
        size="sm"
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Snooze
      </Button>
      {popover}
    </div>
  );
}
