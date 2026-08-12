const GMAILER_URL = "https://code4fukui.github.io/Gmailer/Gmailer.js";

export function fillMailTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => String(values[key] ?? ""));
}

export async function sendConfirmationMail(details) {
  const config = JSON.parse(await Deno.readTextFile("config.json"));
  if (!config.gmailAddress || !config.appPassword) {
    throw new Error("config.jsonにgmailAddressとappPasswordを設定してください");
  }
  const template = await Deno.readTextFile("mail-template.txt");
  const body = fillMailTemplate(template, details);
  const { Gmailer } = await import(GMAILER_URL);
  const mailer = new Gmailer(config.gmailAddress, config.appPassword);
  await mailer.mail(
    details.email,
    config.mailSubject ?? `【くみくみ】${details.title} 予約確認`,
    body,
  );
}
