// ---------------------------------------------------------------------------
// Transactional-email rendering (D-13 / EML-05 / D-07) — the HTML template
// and both render functions relocated BYTE-VERBATIM from src/lib/mail.ts
// (rule 19: no string may change; the old file's deletion happens in the
// Phase 6 deletion release). The ONLY deltas vs the legacy module: the
// functions RETURN { to, subject, html } instead of sending — routes render
// at enqueue time and the worker transports bytes (D-07, self-contained
// payloads, no web/worker template skew) — and the from header moved to the
// smtp provider (src/lib/email/providers/smtp.ts).
//
// Byte-parity is pinned by tests/lib/email-render.test.ts against fixtures
// frozen from the legacy module's live output (oracle capture 2026-09-20).
//
// 07-02 (EML-04 / D-20, T-07-06): the module-scope domain source moved from
// the retiring legacy NextAuth URL env to BETTER_AUTH_URL (Pitfall 5 — every
// queued link derives from this const, so it must survive that env's
// deletion). Template bytes stay frozen. The two *FromUrl variants below are ADDITIVE
// for the Better Auth hooks (EML-04): they embed Better Auth's prebuilt url
// — its API verify/reset endpoints, inverting today's page-first link shape
// (RESEARCH Pattern 4; pre-flip links die at the flip, D-20) — instead of
// rebuilding a token link from the domain. The token-based exports keep
// their signatures until 07-03 removes their call sites.
// ---------------------------------------------------------------------------

const domain = process.env.BETTER_AUTH_URL;

const generateEmailTemplate = (title: string, content: string, buttonText: string, buttonLink: string, footerText: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
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
              <h2 style="color: #1e293b; margin-top: 0; margin-bottom: 24px; font-size: 24px; font-weight: 700;">${title}</h2>
              <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
                ${content}
              </p>
              
              <table border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td align="center" style="border-radius: 8px;" bgcolor="#2563eb">
                    <a href="${buttonLink}" target="_blank" style="font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none; padding: 14px 32px; display: inline-block; border-radius: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">${buttonText}</a>
                  </td>
                </tr>
              </table>

              <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
                <p style="color: #64748b; font-size: 14px; line-height: 1.5; margin: 0;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="${buttonLink}" style="color: #3b82f6; text-decoration: none; word-break: break-all; display: inline-block; margin-top: 8px;">${buttonLink}</a>
                </p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0;">
                ${footerText}
              </p>
              <p style="color: #cbd5e1; font-size: 12px; margin: 16px 0 0 0;">
                &copy; ${new Date().getFullYear()} SpiderNode. All rights reserved.
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

/** The rendered, transport-free form of a transactional email (D-07). */
export interface RenderedEmail {
  to: string;
  subject: string;
  html: string;
}

export const renderVerificationEmail = (to: string, token: string): RenderedEmail => {
  const confirmLink = `${domain}/verify-email?token=${token}`;

  const content = `Welcome to SpiderNode! We're excited to have you on board. Please confirm your email address by clicking the button below so you can get started.`;
  const footerText = `If you didn't create an account, you can safely ignore this email.`;

  return {
    to,
    subject: "Confirm your email - SpiderNode",
    html: generateEmailTemplate("Verify Your Email Address", content, "Verify Email", confirmLink, footerText),
  };
};

export const renderPasswordResetEmail = (to: string, token: string): RenderedEmail => {
  const resetLink = `${domain}/reset-password?token=${token}`;

  const content = `You recently requested to reset your password for your SpiderNode account. Click the button below to set a new password. This link will expire in <strong>1 hour</strong>.`;
  const footerText = `If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.`;

  return {
    to,
    subject: "Reset your password - SpiderNode",
    html: generateEmailTemplate("Reset Your Password", content, "Reset Password", resetLink, footerText),
  };
};

/**
 * Hook-facing verification render (EML-04, 07-02): embeds Better Auth's
 * prebuilt `url` — handed to the sendVerificationEmail hook — exactly as
 * given, in both the button and the copy-paste link slots. No domain or
 * token rebuild: Better Auth's url points at its own API verify endpoint
 * (D-20 — the page-first link shape retires with the flip).
 */
export const renderVerificationEmailFromUrl = (to: string, url: string): RenderedEmail => {
  const content = `Welcome to SpiderNode! We're excited to have you on board. Please confirm your email address by clicking the button below so you can get started.`;
  const footerText = `If you didn't create an account, you can safely ignore this email.`;

  return {
    to,
    subject: "Confirm your email - SpiderNode",
    html: generateEmailTemplate("Verify Your Email Address", content, "Verify Email", url, footerText),
  };
};

/**
 * Hook-facing password-reset render (EML-04, 07-02): embeds Better Auth's
 * prebuilt `url` — handed to the sendResetPassword hook — exactly as given,
 * in both the button and the copy-paste link slots. No domain or token
 * rebuild (D-20).
 */
export const renderPasswordResetEmailFromUrl = (to: string, url: string): RenderedEmail => {
  const content = `You recently requested to reset your password for your SpiderNode account. Click the button below to set a new password. This link will expire in <strong>1 hour</strong>.`;
  const footerText = `If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.`;

  return {
    to,
    subject: "Reset your password - SpiderNode",
    html: generateEmailTemplate("Reset Your Password", content, "Reset Password", url, footerText),
  };
};
