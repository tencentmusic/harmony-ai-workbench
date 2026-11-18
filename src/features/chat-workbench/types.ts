export type ChatSession = { id: string; title: string; createdAt: string; updatedAt: string };

export type ChatMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ViewerProfile = {
  tokenId: string;
  personName: string;
  personCode: string;
  label: string | null;
};

export type AndroidClassCandidate = {
  className: string;
  fqn: string;
  module: string;
  filePath: string;
  platform?: "android" | "harmony";
};

export type OpencodeImageAttachment = {
  path: string;
  mime: string;
  alt?: string;
};

export type ChatAttachment = {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  dataUrl?: string;
};

export type AndroidAppScope = {
  id: string;
  label: string;
  prefixes: string[];
};

