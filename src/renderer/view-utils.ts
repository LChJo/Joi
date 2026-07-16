export function formatDate(value: string, timezone?: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      day: "2-digit", hour: "2-digit", minute: "2-digit", month: "2-digit", ...(timezone === undefined ? {} : { timeZone: timezone }),
    }).format(new Date(value));
  } catch { return value; }
}

export function initials(name: string) {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "JO";
}

export function localDateTimeToIso(value: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error("Local date and time are invalid.");
  const intended = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let candidate = new Date(intended);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
    }).formatToParts(candidate);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? "0");
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    candidate = new Date(candidate.getTime() + intended - represented);
  }
  if (isoToLocalDateTime(candidate.toISOString(), timezone) !== value) throw new Error("Local date and time do not exist in this timezone.");
  return candidate.toISOString();
}

export function isoToLocalDateTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
