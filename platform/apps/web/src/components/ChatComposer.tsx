import { useRef, useEffect } from "react";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";

type Props = {
  text: string;
  onTextChange: (text: string) => void;
  onSend: (text: string) => void;
  onAbort?: () => void;
  disabled?: boolean;
  streaming?: boolean;
  focusToken?: number;
};

export function ChatComposer({
  text,
  onTextChange,
  onSend,
  onAbort,
  disabled,
  streaming,
  focusToken,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (!focusToken) return;
    textareaRef.current?.focus();
  }, [focusToken]);

  const submit = () => {
    if (text.trim() && !disabled) {
      onSend(text);
      onTextChange("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border bg-surface px-4 py-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Connecting..." : "Type a message..."}
          disabled={disabled}
          rows={1}
          wrapperClassName="flex-1"
          className="resize-none overflow-hidden rounded-lg placeholder-slate-500 outline-none focus:ring-0"
        />
        {streaming ? (
          <Button
            type="button"
            onClick={onAbort}
            variant="danger"
            className="rounded-lg border-transparent bg-red-600 px-4 text-white hover:bg-red-500"
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="rounded-lg bg-blue-600 px-4 hover:bg-blue-500"
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
