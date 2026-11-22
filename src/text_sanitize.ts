export function sanitizePlainText(raw: unknown, maxLen: number, stripUrls = false): string {
  if (typeof raw !== "string") return "";
  let s = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (stripUrls) {
    s = s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  }
  return s.slice(0, maxLen);
}
