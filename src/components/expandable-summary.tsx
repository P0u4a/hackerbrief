"use client";

import { useState } from "react";
import { Streamdown } from "streamdown";

export function ExpandableSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pt-5 text-pretty">
      <div className={expanded ? "" : "line-clamp-5 overflow-hidden"}>
        <Streamdown>{summary}</Streamdown>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-sm text-stone-300 hover:underline"
      >
        {expanded ? "Show less" : "Read more..."}
      </button>
    </div>
  );
}
