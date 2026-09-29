import { LoginForm } from "@/components/Auth/LoginForm";

// 07-08 deletion release (D-05): the D-02 notice strip is deleted with the
// deletion release — its component, env predicate, test, and both dated-window
// env entries are gone, and the remnant gate keeps their names out afterwards.
// The page returns to the plain LoginForm mount; the force-dynamic mode the
// strip needed (07-06 rehearsal finding) goes with it, restoring the
// static-prerender form the auth pages had before the strip landed.

export default function LoginPage() {
  return <LoginForm />;
}
