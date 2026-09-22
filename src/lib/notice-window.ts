// ---------------------------------------------------------------------------
// The login notice strip's env window predicate (07-04 Task 3, AUTH-06/D-02).
//
// The /login notice strip renders only inside the operator's dated window —
// AUTH_NOTICE_START..AUTH_NOTICE_END — and is self-cleaning by construction
// (D-02): once the window has passed the predicate goes false forever and the
// component renders null with zero reserved space. D-05 makes the envs
// delete-after-use; the 07-08 remnant gate keeps their names out afterwards.
//
// T-07-15 (tampering/misconfiguration, mitigate): any missing or unparseable
// bound fails toward NO-STRIP — a misconfigured window can never pin a stale
// notice onto the login page, and the unit suite pins every failure shape.
// ---------------------------------------------------------------------------

/**
 * True only when BOTH bounds parse as dates and `now` lies inside the
 * INCLUSIVE [start, end] window (exactly-start and exactly-end instants are
 * inside — pinned by tests/lib/notice-window.test.ts). Any missing or
 * invalid value returns false (fail toward no-strip).
 */
export function noticeWindowActive(
  now: Date,
  start?: string,
  end?: string,
): boolean {
  if (!start || !end) return false;

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return false;
  }

  const nowMs = now.getTime();
  return nowMs >= startDate.getTime() && nowMs <= endDate.getTime();
}
