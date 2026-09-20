import { beforeEach, describe, expect, it, vi } from "vitest";
import { LANE_PRIORITY } from "@/worker/queues";

// ---------------------------------------------------------------------------
// lib/email module contract suite (06-02 Task 1):
//   1. D-11 selection matrix — EMAIL_PROVIDER unset/empty -> smtp (missing
//      config can never break email), "console" -> the dev dump provider,
//      "smtp" -> smtp, anything else THROWS (throw-early convention — a typo
//      like "smtpp" fails loud at worker boot, never a silent no-op).
//   2. D-12 console dump — send() prints ONE structured stdout line carrying
//      recipient + subject + the rendered HTML (bracketed-prefix convention).
//   3. Enqueue contract — enqueueTransactionalEmail adds a "send" job with
//      priority LANE_PRIORITY.email, attempts 5, backoff { type: "custom" },
//      retention-by-age removal — and NEVER a jobId (Pitfall 3: BullMQ 6
//      rejects colon-containing ids that are not exactly 3 segments).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  delete process.env.EMAIL_PROVIDER;
});

describe("getEmailProvider — D-11 selection matrix (EML-01)", () => {
  it("EMAIL_PROVIDER unset -> smtp provider", async () => {
    delete process.env.EMAIL_PROVIDER;
    const { getEmailProvider } = await import("@/lib/email");
    expect(getEmailProvider().name).toBe("smtp");
  });

  it("EMAIL_PROVIDER empty string -> smtp provider", async () => {
    process.env.EMAIL_PROVIDER = "";
    const { getEmailProvider } = await import("@/lib/email");
    expect(getEmailProvider().name).toBe("smtp");
  });

  it('EMAIL_PROVIDER "smtp" -> smtp provider (explicit)', async () => {
    process.env.EMAIL_PROVIDER = "smtp";
    const { getEmailProvider } = await import("@/lib/email");
    expect(getEmailProvider().name).toBe("smtp");
  });

  it('EMAIL_PROVIDER "console" -> console provider (dev opt-in)', async () => {
    process.env.EMAIL_PROVIDER = "console";
    const { getEmailProvider } = await import("@/lib/email");
    expect(getEmailProvider().name).toBe("console");
  });

  it('EMAIL_PROVIDER unknown ("smtpp") -> THROWS loud (never a silent fallback)', async () => {
    process.env.EMAIL_PROVIDER = "smtpp";
    const { getEmailProvider } = await import("@/lib/email");
    expect(() => getEmailProvider()).toThrow(/EMAIL_PROVIDER/);
  });
});

describe("console provider — D-12 one structured stdout line", () => {
  it("send() prints ONE line with the bracketed prefix + recipient + subject + rendered HTML", async () => {
    process.env.EMAIL_PROVIDER = "console";
    const { getEmailProvider } = await import("@/lib/email");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await getEmailProvider().send({
        to: "dev@console.test",
        subject: "Confirm your email - SpiderNode",
        html: "<p>line one\nline two</p>",
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String(logSpy.mock.calls[0][0]);
      // Bracketed-prefix logging convention ("[redis] ..." style).
      expect(line.startsWith("[email-console]")).toBe(true);
      // Recipient + subject + rendered HTML all carried.
      expect(line).toContain("dev@console.test");
      expect(line).toContain("Confirm your email - SpiderNode");
      expect(line).toContain("<p>line one\\nline two</p>");
      // ONE line — the embedded HTML's newlines are escaped.
      expect(line.split("\n")).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("enqueueTransactionalEmail — enqueue contract (Pitfall 3 / D-09)", () => {
  it("adds a \"send\" job with priority/attempts/backoff-custom and NO jobId, on the injectable queue", async () => {
    const add = vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({ id: "job-1" }));
    const { enqueueTransactionalEmail, EMAIL_JOB_OPTIONS } = await import("@/lib/email/enqueue");

    const payload = { to: "x@y.test", subject: "s", html: "<b>h</b>" };
    const result = await enqueueTransactionalEmail(payload, { emailQueue: { add } });

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe("send");
    expect(data).toEqual(payload);
    expect(opts).toMatchObject({
      priority: LANE_PRIORITY.email,
      attempts: 5,
      backoff: { type: "custom" },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 14 * 24 * 3600 },
    });
    // Pitfall 3: NO jobId option ever — BullMQ 6 rejects colon ids that are
    // not exactly 3 segments; auto ids are the correct form for email sends.
    expect(opts).not.toHaveProperty("jobId");
    expect(result).toEqual({ job: { id: "job-1" } });

    // The exported constant is the transcription source of truth.
    expect(EMAIL_JOB_OPTIONS).toEqual({
      priority: LANE_PRIORITY.email,
      attempts: 5,
      backoff: { type: "custom" },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 1209600 },
    });
  });

  it("propagates an add() rejection to the caller (routes map it to a loud 503, D-29)", async () => {
    const add = vi.fn(async () => {
      throw new Error("simulated redis down");
    });
    const { enqueueTransactionalEmail } = await import("@/lib/email/enqueue");

    await expect(
      enqueueTransactionalEmail({ to: "x@y.test", subject: "s", html: "h" }, { emailQueue: { add } })
    ).rejects.toThrow("simulated redis down");
  });
});
