import { useRef, useState } from "react";
import type { MouseEvent } from "react";

interface Props {
  text: string;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function CopyButton({ text }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  const onClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    if (!text.trim()) return;

    try {
      await writeClipboard(text);
      setCopied(true);
      if (resetTimer.current != null) {
        window.clearTimeout(resetTimer.current);
      }
      resetTimer.current = window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch (err) {
      console.error("[copy] failed to copy node text", err);
    }
  };

  return (
    <button
      type="button"
      className="node-copy-button"
      onClick={(event) => {
        void onClick(event);
      }}
      title={copied ? "Copied" : "Copy full node text"}
      aria-label="Copy full node text"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
