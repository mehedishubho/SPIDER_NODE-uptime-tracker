import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Byte-parity suite (EML-05, D-07): the relocated render module must produce
// BYTE-IDENTICAL output to the legacy src/lib/mail.ts payload construction.
//
// The fixtures below were frozen on 2026-09-20 by running the CURRENT
// mail.ts send functions with an intercepted nodemailer.createTransport
// (payload captured at sendMail) for a fixed (NEXTAUTH_URL, SMTP_USER, to,
// token) tuple — the old module was the oracle at freeze time. The full
// sendMail payload form is frozen (from/to/subject/html); the render module
// owns to/subject/html (D-07) and the smtp provider owns the from header.
//
// NOTE the frozen copyright year (2026): a year-boundary crossing would
// legitimately require re-freezing.
// ---------------------------------------------------------------------------

process.env.NEXTAUTH_URL = "https://parity.spidernode.test";
process.env.SMTP_USER = "no-reply@parity.spidernode.test";
process.env.SMTP_HOST = "smtp.parity.spidernode.test";
process.env.SMTP_PORT = "587";
process.env.SMTP_PASS = "fixture-pass";

const FIXTURE_TO = "newuser@parity.spidernode.test";
const FIXTURE_FROM = '"SpiderNode" <no-reply@parity.spidernode.test>';
const VERIFY_TOKEN = "verify-fixture-token-0123456789abcdef";
const RESET_TOKEN = "reset-fixture-token-0123456789abcdef";

// Frozen from mail.ts sendVerificationEmail output (oracle capture 2026-09-20).
const VERIFY_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email Address</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f7f6; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; max-width: 600px; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 40px 20px; background-color: #0f172a;">
              <h1 style="color: #ffffff; margin: 0; font-size: 32px; letter-spacing: -0.5px; font-weight: 800;">Spider<span style="color: #3b82f6;">Node</span></h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 40px 40px 30px 40px;">
              <h2 style="color: #1e293b; margin-top: 0; margin-bottom: 24px; font-size: 24px; font-weight: 700;">Verify Your Email Address</h2>
              <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
                Welcome to SpiderNode! We're excited to have you on board. Please confirm your email address by clicking the button below so you can get started.
              </p>
              
              <table border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td align="center" style="border-radius: 8px;" bgcolor="#2563eb">
                    <a href="https://parity.spidernode.test/verify-email?token=verify-fixture-token-0123456789abcdef" target="_blank" style="font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none; padding: 14px 32px; display: inline-block; border-radius: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">Verify Email</a>
                  </td>
                </tr>
              </table>

              <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
                <p style="color: #64748b; font-size: 14px; line-height: 1.5; margin: 0;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="https://parity.spidernode.test/verify-email?token=verify-fixture-token-0123456789abcdef" style="color: #3b82f6; text-decoration: none; word-break: break-all; display: inline-block; margin-top: 8px;">https://parity.spidernode.test/verify-email?token=verify-fixture-token-0123456789abcdef</a>
                </p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0;">
                If you didn't create an account, you can safely ignore this email.
              </p>
              <p style="color: #cbd5e1; font-size: 12px; margin: 16px 0 0 0;">
                &copy; 2026 SpiderNode. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// Frozen from mail.ts sendPasswordResetEmail output (oracle capture 2026-09-20).
const RESET_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f7f6; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; max-width: 600px; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 40px 20px; background-color: #0f172a;">
              <h1 style="color: #ffffff; margin: 0; font-size: 32px; letter-spacing: -0.5px; font-weight: 800;">Spider<span style="color: #3b82f6;">Node</span></h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 40px 40px 30px 40px;">
              <h2 style="color: #1e293b; margin-top: 0; margin-bottom: 24px; font-size: 24px; font-weight: 700;">Reset Your Password</h2>
              <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
                You recently requested to reset your password for your SpiderNode account. Click the button below to set a new password. This link will expire in <strong>1 hour</strong>.
              </p>
              
              <table border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td align="center" style="border-radius: 8px;" bgcolor="#2563eb">
                    <a href="https://parity.spidernode.test/reset-password?token=reset-fixture-token-0123456789abcdef" target="_blank" style="font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none; padding: 14px 32px; display: inline-block; border-radius: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">Reset Password</a>
                  </td>
                </tr>
              </table>

              <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
                <p style="color: #64748b; font-size: 14px; line-height: 1.5; margin: 0;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="https://parity.spidernode.test/reset-password?token=reset-fixture-token-0123456789abcdef" style="color: #3b82f6; text-decoration: none; word-break: break-all; display: inline-block; margin-top: 8px;">https://parity.spidernode.test/reset-password?token=reset-fixture-token-0123456789abcdef</a>
                </p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0;">
                If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
              </p>
              <p style="color: #cbd5e1; font-size: 12px; margin: 16px 0 0 0;">
                &copy; 2026 SpiderNode. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const VERIFY_FIXTURE = {
  from: FIXTURE_FROM,
  to: FIXTURE_TO,
  subject: "Confirm your email - SpiderNode",
  html: VERIFY_HTML,
};

const RESET_FIXTURE = {
  from: FIXTURE_FROM,
  to: FIXTURE_TO,
  subject: "Reset your password - SpiderNode",
  html: RESET_HTML,
};

// The smtp-provider seam: capture transporter creation + sendMail payloads.
const smtpSeam = vi.hoisted(() => ({
  transportsCreated: [] as unknown[],
  sent: [] as unknown[],
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: unknown) => {
      smtpSeam.transportsCreated.push(options);
      return {
        sendMail: (payload: unknown) => {
          smtpSeam.sent.push(payload);
          return Promise.resolve({});
        },
      };
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  smtpSeam.transportsCreated.length = 0;
  smtpSeam.sent.length = 0;
});

describe("lib/email render — byte-verbatim relocation from mail.ts (EML-05, D-07)", () => {
  it("renderVerificationEmail returns the frozen mail.ts verification payload byte-for-byte", async () => {
    const { renderVerificationEmail } = await import("@/lib/email/render");

    const rendered = renderVerificationEmail(FIXTURE_TO, VERIFY_TOKEN);

    expect(rendered).toEqual({
      to: VERIFY_FIXTURE.to,
      subject: VERIFY_FIXTURE.subject,
      html: VERIFY_FIXTURE.html,
    });
    // Byte-equality corroboration: identical length AND identical content.
    expect(rendered.html.length).toBe(VERIFY_FIXTURE.html.length);
  });

  it("renderPasswordResetEmail returns the frozen mail.ts reset payload byte-for-byte", async () => {
    const { renderPasswordResetEmail } = await import("@/lib/email/render");

    const rendered = renderPasswordResetEmail(FIXTURE_TO, RESET_TOKEN);

    expect(rendered).toEqual({
      to: RESET_FIXTURE.to,
      subject: RESET_FIXTURE.subject,
      html: RESET_FIXTURE.html,
    });
    expect(rendered.html.length).toBe(RESET_FIXTURE.html.length);
  });

  it("link forms: domain + /verify-email?token= and /reset-password?token= from NEXTAUTH_URL", async () => {
    const { renderVerificationEmail, renderPasswordResetEmail } = await import("@/lib/email/render");

    const verify = renderVerificationEmail(FIXTURE_TO, VERIFY_TOKEN);
    const reset = renderPasswordResetEmail(FIXTURE_TO, RESET_TOKEN);

    expect(verify.html).toContain(`https://parity.spidernode.test/verify-email?token=${VERIFY_TOKEN}`);
    expect(reset.html).toContain(`https://parity.spidernode.test/reset-password?token=${RESET_TOKEN}`);
  });
});

describe("lib/email smtp provider — from-header byte-parity + lazy transporter", () => {
  it("send() passes the byte-identical sendMail payload (from/to/subject/html) as mail.ts did", async () => {
    const { createSmtpEmailProvider } = await import("@/lib/email/providers/smtp");
    const provider = createSmtpEmailProvider();

    await provider.send({
      to: VERIFY_FIXTURE.to,
      subject: VERIFY_FIXTURE.subject,
      html: VERIFY_FIXTURE.html,
    });

    expect(smtpSeam.sent).toHaveLength(1);
    expect(smtpSeam.sent[0]).toEqual(VERIFY_FIXTURE);
  });

  it("transporter is created lazily (import + provider creation open NO socket) and reused across sends", async () => {
    const { createSmtpEmailProvider } = await import("@/lib/email/providers/smtp");
    const provider = createSmtpEmailProvider();

    // Creating the provider must not create a transporter.
    expect(smtpSeam.transportsCreated).toHaveLength(0);

    await provider.send({ to: FIXTURE_TO, subject: "s", html: "h" });
    await provider.send({ to: FIXTURE_TO, subject: "s2", html: "h2" });

    // One transporter, created on first send, REUSED for the second.
    expect(smtpSeam.transportsCreated).toHaveLength(1);
    expect(smtpSeam.sent).toHaveLength(2);
  });

  it("transporter config carries the exact same option keys/values as mail.ts lines 5-13", async () => {
    const { createSmtpEmailProvider } = await import("@/lib/email/providers/smtp");
    const provider = createSmtpEmailProvider();
    await provider.send({ to: FIXTURE_TO, subject: "s", html: "h" });

    expect(smtpSeam.transportsCreated[0]).toEqual({
      host: "smtp.parity.spidernode.test",
      port: 587,
      secure: false,
      auth: {
        user: "no-reply@parity.spidernode.test",
        pass: "fixture-pass",
      },
    });
  });
});
