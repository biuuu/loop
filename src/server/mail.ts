import nodemailer from 'nodemailer';

export type EmailMessage = {
  to: string;
  code: string;
  purpose: 'login' | 'bind';
};
export type SendMail = (message: EmailMessage) => Promise<void>;

// One SMTP transport; secrets stay on the Node service. Delivery is separately verified.
export function smtpMail(): SendMail | undefined {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return undefined;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return async ({ to, code, purpose }) => {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject: `Loop ${purpose === 'bind' ? '绑定' : '登录'}验证码`,
      text: `你的 Loop 验证码是 ${code}，5 分钟内有效。请勿将验证码告诉他人。如非本人操作，请忽略此邮件。`,
    });
  };
}
