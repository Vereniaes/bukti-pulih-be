// Build a branded OTP email for phone and desktop mail clients.
import type { VerificationEmail } from "./brevo-mailer.js";

const messages = {
  register: { action: "verifikasi akun", title: "Verifikasi akun", instruction: "Masukkan kode berikut pada halaman pendaftaran BuktiPulih." },
  login: { action: "masuk", title: "Lanjutkan masuk", instruction: "Masukkan kode berikut untuk masuk ke akun BuktiPulih." },
  reset: { action: "reset password", title: "Atur ulang password", instruction: "Masukkan kode berikut untuk membuat password baru." },
};

export function createVerificationEmail(input: Pick<VerificationEmail, "code" | "expiresAt" | "purpose">) {
  const message = messages[input.purpose];
  const code = input.code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const date = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(input.expiresAt);
  const time = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(input.expiresAt);

  return {
    subject: `Kode ${message.action} BuktiPulih`,
    htmlContent: `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${message.title} - BuktiPulih</title>
  <style>
    @media only screen and (min-width: 481px) {
      .email-shell { padding: 40px 16px !important; }
      .email-content { padding: 36px 40px !important; }
      .email-title { font-size: 30px !important; }
      .email-code { font-size: 36px !important; letter-spacing: 5px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f1e9;font-family:Arial,Helvetica,sans-serif;color:#172c20;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;" aria-hidden="true">Kode untuk ${message.action} BuktiPulih. Jangan bagikan kode ini.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f1e9">
    <tr><td class="email-shell" align="center" style="padding:20px 12px;">
      <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fffdf8" style="width:100%;max-width:560px;border:1px solid #e2ddcf;border-radius:16px;border-spacing:0;">
        <tr><td style="height:6px;line-height:6px;background-color:#0a572b;border-radius:16px 16px 0 0;">&nbsp;</td></tr>
        <tr><td class="email-content" style="padding:28px 22px;">
          <p style="margin:0;color:#0a572b;font-size:26px;font-weight:700;letter-spacing:-1.2px;line-height:1.2;">buktipulih</p>
          <h1 class="email-title" style="margin:32px 0 12px;color:#172c20;font-size:26px;font-weight:700;line-height:1.2;letter-spacing:-0.7px;">${message.title}</h1>
          <p style="margin:0;color:#526157;font-size:15px;line-height:1.65;">${message.instruction}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1eee3" style="margin:24px 0;border:1px solid #e2ddcf;border-radius:12px;">
            <tr><td align="center" style="padding:24px 8px;">
              <p style="margin:0 0 10px;color:#526157;font-size:12px;font-weight:700;line-height:1.4;">KODE VERIFIKASI</p>
              <p class="email-code" style="margin:0;color:#0a572b;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:4px;line-height:1.25;white-space:nowrap;">${code}</p>
            </td></tr>
          </table>
          <p style="margin:0;color:#526157;font-size:13px;line-height:1.7;">Berlaku sampai<br><strong style="color:#172c20;font-weight:700;">${date}, ${time} WIB</strong></p>
          <p style="margin:24px 0 0;padding-top:24px;border-top:1px solid #e2ddcf;color:#526157;font-size:13px;line-height:1.7;">Kode hanya dapat digunakan sekali. Jangan bagikan kode ini.</p>
          <p style="margin:10px 0 0;color:#526157;font-size:13px;line-height:1.7;">Jika tidak meminta kode ini, abaikan email.</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
      <p style="margin:20px 0 0;color:#657166;font-size:12px;line-height:1.6;">Pantau Jejak, Kawal Pemulihan.</p>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
