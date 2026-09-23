import { LoginForm } from "@/components/Auth/LoginForm";
import { LoginNotice } from "@/components/Auth/LoginNotice";

// The D-02 notice strip is env-window-gated (AUTH_NOTICE_START/END read at
// render time). Without this, Next statically prerenders /login at BUILD time
// — before any operator notice window exists — baking `null` in forever and
// making the strip unrenderable in every production build (07-06 rehearsal
// finding). force-dynamic makes the window check per-request, which is the
// component's documented contract (self-cleaning when the window closes).
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <>
      {/* D-02 notice strip — server-rendered, env-window-gated, renders null
          outside the window (zero reserved space). Mounted on the /login page
          only, at the centered max-w-md column width so it is never a
          viewport-wide banner and never collides with the auth layout's
          absolute ThemeToggle. The in-DOM column child lives inside
          LoginForm.tsx, whose JSX is byte-frozen (D-33/Task 1) — this
          page-level shell reproduces the placement contract (column width,
          centered, above the brand header, in-flow so it can never overlap
          the form or the toggle). */}
      <div className="flex justify-center px-4">
        <div className="w-full max-w-md">
          <LoginNotice />
        </div>
      </div>
      <LoginForm />
    </>
  );
}
