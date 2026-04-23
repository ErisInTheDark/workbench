"use client";

const EMPHASIS_PATTERN = /(\d[\d.,]*(?:[a-zA-Z]+)?)/g;

export default function ThreadSummaryText({ text }: { text: string }) {
  const parts = text.split(EMPHASIS_PATTERN).filter(Boolean);

  return (
    <span>
      {parts.map((part, index) => (
        /^\d/.test(part) ? (
          <span key={`${part}:${index}`} className="font-medium text-text">
            {part}
          </span>
        ) : (
          <span key={`${part}:${index}`}>{part}</span>
        )
      ))}
    </span>
  );
}
