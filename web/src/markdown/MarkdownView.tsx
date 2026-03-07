import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchMarkdown } from "../api";
import type { MarkdownDoc } from "../types";

interface Props {
  path: string;
}

export function MarkdownView({ path }: Props) {
  const [doc, setDoc] = useState<MarkdownDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void fetchMarkdown(path)
      .then((result) => {
        if (!active) return;
        setDoc(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [path]);

  if (loading) {
    return <div className="markdown-loading">Loading markdown...</div>;
  }

  if (error) {
    return <div className="markdown-error">{error}</div>;
  }

  if (!doc) {
    return <div className="markdown-error">No markdown content found.</div>;
  }

  return (
    <div className="markdown-view">
      <div className="markdown-header">
        <span className="markdown-path">{doc.path}</span>
      </div>
      <article className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {doc.content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
