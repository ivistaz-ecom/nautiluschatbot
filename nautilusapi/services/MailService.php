<?php
// backend/services/MailService.php

class MailService {

    public static function sendVerification(string $to, string $name, string $token): void {
        $cfg      = require __DIR__ . '/../config/config.php';
        $frontUrl = getenv('FRONTEND_URL') ?: 'https://chat.nautilusshipping.com';
        $link     = "$frontUrl/verify-email?token=$token";

        $subject = 'Verify your Nautilus Shipping KB account';
        $body    = self::template("Hello $name,", "Please verify your email address to activate your account.", $link, 'Verify Email');

        self::send($to, $subject, $body);
    }

    public static function sendPasswordReset(string $to, string $name, string $token): void {
        $frontUrl = getenv('FRONTEND_URL') ?: 'https://chat.nautilusshipping.com';
        $link     = "$frontUrl/reset-password?token=$token";

        $subject = 'Reset your Nautilus Shipping KB password';
        $body    = self::template("Hello $name,", "Click below to reset your password. This link expires in 1 hour.", $link, 'Reset Password');

        self::send($to, $subject, $body);
    }

    public static function sendQueryAnswered(string $to, string $name, string $question, string $answer): void {
        $subject = 'Your query has been answered — Nautilus Shipping KB';
        $body    = self::template(
            "Hello $name,",
            "Your query has been answered by our team:\n\n<b>Your question:</b> " . htmlspecialchars($question) . "\n\n<b>Answer:</b> " . htmlspecialchars($answer),
            null, null
        );
        self::send($to, $subject, $body);
    }

    private static function send(string $to, string $subject, string $htmlBody): void {
        $cfg  = require __DIR__ . '/../config/config.php';
        $mc   = $cfg['mail'];
        $from = $mc['from'];
        $name = $mc['from_name'];

        $headers  = "MIME-Version: 1.0\r\n";
        $headers .= "Content-Type: text/html; charset=UTF-8\r\n";
        $headers .= "From: $name <$from>\r\n";
        $headers .= "Reply-To: $from\r\n";

        // Use PHP mail() as fallback; replace with SMTP in production
        if (!mail($to, $subject, $htmlBody, $headers)) {
            throw new RuntimeException("mail() failed for: $to");
        }
    }

    private static function template(string $greeting, string $body, ?string $link, ?string $btnText): string {
        $btn = '';
        if ($link && $btnText) {
            $btn = "<a href=\"$link\" style=\"display:inline-block;padding:12px 28px;background:#1B4F8A;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin:20px 0\">$btnText</a>";
        }

        $bodyFormatted = nl2br(htmlspecialchars($body));
        return <<<HTML
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:40px auto;padding:20px;color:#222">
  <div style="border-bottom:3px solid #1B4F8A;padding-bottom:16px;margin-bottom:24px">
    <span style="font-size:20px;font-weight:700;color:#1B4F8A">Nautilus Shipping</span>
    <span style="font-size:14px;color:#666;margin-left:8px">Knowledge Base</span>
  </div>
  <p style="font-size:16px">$greeting</p>
  <p style="font-size:15px;line-height:1.6;color:#444">$bodyFormatted</p>
  $btn
  <hr style="margin:32px 0;border:none;border-top:1px solid #e0e0e0">
  <p style="font-size:12px;color:#999">This email was sent by Nautilus Shipping Knowledge Base. Do not reply to this email.</p>
</body></html>
HTML;
    }
}
