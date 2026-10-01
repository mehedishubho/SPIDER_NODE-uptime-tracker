"use client";

import React, { useCallback, useRef } from "react";
import { useCompletion } from "@ai-sdk/react";
import { APICallError } from "ai";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ---------------------------------------------------------------------------
// PostMortemCard (08-07, AI-03 UX) — the inline streaming post-mortem draft
// mounted under each incident block on the monitor detail page.
//
// Contract pins (each exercised by tests/e2e/ai-surfaces.spec.ts):
//   - D-12 inline card under the incident — never a modal hiding the
//     evidence; markdown streams as it arrives via the AI SDK's useCompletion
//     over POST /api/ai/post-mortem (D-07: SDK primitives, no custom chunk
//     parsing — the hook's default UIMessage-stream protocol consumes the
//     08-10 route's createUIMessageStreamResponse verbatim).
//   - D-14 the draft is structured in the four sections (Summary, Timeline,
//     Impact, Possible causes) — the route's instructions demand them; the
//     e2e asserts the four headings rendered against the stub stream.
//   - Controls per the UI-SPEC copy contract: "Generate post-mortem" (idle)
//     -> "Stop" (streaming, via stop() — honest because the route composes
//     req.signal into its abortSignal) -> "Copy" + "Regenerate" (complete).
//     Header: "Post-mortem draft — not saved" (D-13 made visible).
//     Copy success toast: "Post-mortem copied to clipboard".
//   - D-13 COPY-ONLY: there is no save affordance of any kind — nothing from
//     this card ever reaches the database.
//   - D-09 provider failure -> the inline error "Couldn't generate the
//     post-mortem." + a user-initiated "Retry" — never a silent auto-retry.
//   - D-08 the 429 answers carry Retry-After; the toast surfaces the exact
//     seconds: "Too many AI requests — try again in {n}s". useCompletion's
//     error surface (APICallError) exposes the status/body but never the
//     headers, so a fetch wrapper captures Retry-After at the response
//     boundary (a header read, not chunk parsing — D-07 intact).
//   - D-21 with aiEnabled false the card and its trigger do not render at
//     all (the early return sits AFTER the hooks — rules-of-hooks), so the
//     flag-off DOM carries zero AI trace.
// ---------------------------------------------------------------------------

interface PostMortemCardProps {
  monitorId: number;
  incidentId: string;
  /** Server-rendered flag boolean (Pattern 6) — false renders nothing. */
  aiEnabled: boolean;
}

/** True when the error is the guard chain's 429 (D-08 toast contract). */
function isRateLimitError(error: Error): boolean {
  return APICallError.isInstance(error) && error.statusCode === 429;
}

export function PostMortemCard({ monitorId, incidentId, aiEnabled }: PostMortemCardProps) {
  // The seconds from the latest 429's Retry-After header (D-08), captured by
  // the fetch wrapper below and read in onError — the hook's error object
  // carries the status code but not the headers.
  const retryAfterRef = useRef<number | null>(null);

  // Streaming caret accent + card border while streaming (UI-SPEC Color
  // reserved list item 4): the state rides isLoading below.
  const {
    completion,
    complete,
    stop,
    isLoading,
    error,
  } = useCompletion({
    api: "/api/ai/post-mortem",
    credentials: "same-origin",
    fetch: useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
      retryAfterRef.current = null;
      const response = await fetch(input, init);
      if (response.status === 429) {
        const raw = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(raw) && raw > 0) retryAfterRef.current = raw;
      }
      return response;
    }, []),
    onError: useCallback((err: Error) => {
      if (isRateLimitError(err)) {
        const seconds = retryAfterRef.current ?? 60;
        toast.error(`Too many AI requests — try again in ${seconds}s`);
      }
      // Other failures surface through the hook's error state as the inline
      // D-09 error below — never a silent auto-retry (D-09).
    }, []),
  });

  // Stream (or re-stream — D-16 Regenerate and D-09 Retry share this path)
  // the draft for THIS incident. The ids ride the request body next to the
  // prompt payload the hook sends.
  const generate = useCallback(() => {
    void complete("", { body: { monitorId, incidentId } });
  }, [complete, monitorId, incidentId]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(completion)
      .then(() => toast.success("Post-mortem copied to clipboard"))
      .catch(() => toast.error("Couldn't copy the post-mortem."));
  }, [completion]);

  // D-21: with the flag off the card and its trigger do not render at all.
  // Placed AFTER the hooks (rules-of-hooks) — the idle hook makes no
  // requests, so the flag-off page carries zero AI trace in DOM and network.
  if (!aiEnabled) {
    return null;
  }

  const hasDraft = completion.trim().length > 0;
  const isComplete = !isLoading && hasDraft && !error;

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="post-mortem-mount">
      {/* Controls — the contract copy per state (D-16): "Generate post-mortem"
          idle -> "Stop" streaming -> "Copy" + "Regenerate" complete (the idle
          trigger relabels as the ONE Regenerate affordance; a second one would
          duplicate the accessible name). Error state adds "Retry" (D-09). */}
      <div className="flex flex-wrap items-center gap-2">
        {isLoading ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={stop}
            data-testid="post-mortem-stop"
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={generate}
            data-testid={hasDraft ? "post-mortem-regenerate" : "post-mortem-generate"}
          >
            {hasDraft ? "Regenerate" : "Generate post-mortem"}
          </Button>
        )}
        {isComplete && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            data-testid="post-mortem-copy"
          >
            Copy
          </Button>
        )}
        {error && !isLoading && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={generate}
            data-testid="post-mortem-retry"
          >
            Retry
          </Button>
        )}
      </div>

      {/* The draft card — inline, never a modal (D-12). Renders while
          streaming (partial markdown as it arrives), when complete, and on
          error (inline D-09 error next to any partial draft). */}
      {(hasDraft || error) && (
        <Card
          data-testid="post-mortem-card"
          className={`gap-3 py-4 ${isLoading ? "border-accent-cyan/40" : ""}`}
        >
          <CardHeader className="gap-1 px-4">
            <CardTitle className="text-sm font-semibold text-foreground">
              Post-mortem draft — not saved
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Generated from this incident&apos;s evidence. Copy it — nothing
              is saved automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            {error && (
              <p
                className="mb-2 text-xs font-medium text-status-down"
                data-testid="post-mortem-error"
              >
                Couldn&apos;t generate the post-mortem.
              </p>
            )}
            {hasDraft && (
              // Markdown only — react-markdown without rehype-raw, so streamed
              // raw HTML never executes (T-08-23). Internal scroll keeps long
              // drafts inside the incident block (UI-SPEC long-text row).
              <div className="max-h-[40rem] overflow-y-auto text-sm text-foreground">
                <ReactMarkdown
                  components={{
                    h2: ({ children }) => (
                      <h2 className="mb-1 mt-3 text-base font-semibold text-foreground first:mt-0">
                        {children}
                      </h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="mb-1 mt-2 text-sm font-semibold text-foreground">
                        {children}
                      </h3>
                    ),
                    p: ({ children }) => (
                      <p className="mb-2 leading-relaxed text-muted-foreground">{children}</p>
                    ),
                    ul: ({ children }) => (
                      <ul className="mb-2 list-disc pl-5 text-muted-foreground">{children}</ul>
                    ),
                    li: ({ children }) => <li className="mb-0.5">{children}</li>,
                  }}
                >
                  {completion}
                </ReactMarkdown>
                {isLoading && (
                  <span
                    className="inline-block h-4 w-2 animate-pulse bg-accent-cyan align-text-bottom"
                    aria-hidden
                    data-testid="post-mortem-caret"
                  />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
