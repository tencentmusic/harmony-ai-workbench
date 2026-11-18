export function formatDatePrefix(date: Date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

export function sanitizeSessionTitleBody(raw: string) {
  let text = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'「『【\s]+|["'」』】\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/[。！？!?.,，、:：;；]+$/g, "").trim();
  return text;
}

export function summarizePromptForSessionTitle(prompt: string) {
  let text = String(prompt || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!text) return "";
  text = text.replace(/\s+/g, " ").trim();

  const mentionMatch = text.match(/@([A-Za-z_][\w.$]*(?:\.[A-Z]\w*)*)/);
  if (mentionMatch?.[1]) {
    const fqn = mentionMatch[1];
    const simpleName = fqn.includes(".") ? fqn.split(".").pop() || fqn : fqn;
    text = text.replace(new RegExp(`@${mentionMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), simpleName);
  }

  return text;
}

export function buildSessionTitleFromBody(body: string, date = new Date()) {
  const prefix = formatDatePrefix(date);
  const cleaned = sanitizeSessionTitleBody(body);
  if (!cleaned) return `${prefix} 新会话`;
  const maxLen = 48;
  const clipped = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
  return `${prefix} ${clipped}`;
}

export function buildSessionTitleFromPrompt(prompt: string, date = new Date()) {
  const body = summarizePromptForSessionTitle(prompt);
  return buildSessionTitleFromBody(body, date);
}

export function isDefaultSessionTitle(title: string) {
  const t = String(title || "").trim();
  return /^(新会话|新对话)$/.test(t) || /^\d{4}\/\d{2}\/\d{2}\s+(新会话|新对话)$/.test(t);
}

export function shouldAutoRenameSession(title: string) {
  return isDefaultSessionTitle(title);
}
