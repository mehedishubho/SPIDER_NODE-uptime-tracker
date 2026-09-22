import { InformationCircleIcon } from "hugeicons-react";
import { noticeWindowActive } from "@/lib/notice-window";

// ---------------------------------------------------------------------------
// The D-02 login notice strip — the phase's single new UI element (07-04
// Task 3, AUTH-06). SERVER-rendered on /login only: inside the
// AUTH_NOTICE_START..AUTH_NOTICE_END window it renders exactly one
// non-dismissible flex row with ZERO client state (no localStorage, no
// dismissal, no cookie); any missing/invalid bound renders null with no
// placeholder and no reserved space (self-cleaning window, D-02).
//
// Tokens follow the 07-UI-SPEC Color/Spacing recipe exactly (informational
// surface — deliberately NO accent color): bg-card + border border-border +
// rounded-xl container, text-foreground 14px/400/1.5 copy, muted w-4 h-4
// decorative icon with aria-hidden, role="status" so screen readers announce
// it, py-4 px-4 + mb-4 on the declared scale, items-start + gap-2 so wrapped
// lines stay aligned (wraps, never truncates).
//
// Copy is the frozen D-02 sentence, byte-exact; the operator approves the
// rendered bytes at the deploy rehearsal via the console provider (D-06).
// Component + env reads + env entries are deleted with the deletion release
// (D-05 extends the remnant gate to the env names).
// ---------------------------------------------------------------------------

const NOTICE_COPY =
  "Sign-in moved to a new system — sign in with your existing email and password";

export function LoginNotice() {
  const active = noticeWindowActive(
    new Date(),
    process.env.AUTH_NOTICE_START,
    process.env.AUTH_NOTICE_END,
  );
  if (!active) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 bg-card border border-border rounded-xl py-4 px-4 mb-4"
    >
      <InformationCircleIcon
        aria-hidden="true"
        className="w-4 h-4 text-muted-foreground"
      />
      <span className="text-foreground text-sm leading-normal">{NOTICE_COPY}</span>
    </div>
  );
}
