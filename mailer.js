const GMAILER_URL = "https://code4fukui.github.io/Gmailer/Gmailer.js";

export function fillMailTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => String(values[key] ?? ""));
}

export function parseMailTemplate(template) {
  const normalized = String(template).replaceAll("\r\n", "\n");
  const [firstLine = "", ...rest] = normalized.split("\n");
  const subject = firstLine.match(/^Subject:\s*(.+)$/i)?.[1]?.trim();
  if (!subject) {
    return { subject: "{{title}} くみくみ確認メール", body: normalized.trim() };
  }
  if (rest[0] === "") rest.shift();
  return { subject, body: rest.join("\n").trim() };
}

export async function sendConfirmationMail(details) {
  const config = JSON.parse(await Deno.readTextFile("config.json"));
  if (!config.gmailAddress || !config.appPassword) {
    throw new Error("config.jsonにgmailAddressとappPasswordを設定してください");
  }
  const template = parseMailTemplate(await Deno.readTextFile("mail-template.txt"));
  const body = fillMailTemplate(details.mailBody ?? template.body, details);
  const subject = fillMailTemplate(
    details.mailSubject ?? template.subject,
    details,
  );
  const { Gmailer } = await import(GMAILER_URL);
  const mailer = new Gmailer(config.gmailAddress, config.appPassword);
  await mailer.mail(
    details.email,
    subject,
    body,
  );
}
