export type KnowledgeRole = "canonical" | "evidence" | "codegraph" | "reference";

export type KnowledgeLibraryGroup = "technical" | "migration";

export type KnowledgeLocator = {
  libraryId: string;
  sourceId: string;
  workspaceAlias: string;
  docPath: string;
  appScopeId?: string;
};

export type KnowledgeLibrarySummary = {
  libraryId: string;
  label: string;
  group: KnowledgeLibraryGroup;
  sourceId: string;
  sourceLabel: string;
  workspaceAlias: string;
  role: KnowledgeRole;
  documentCount: number;
  appScopeId?: string;
};

export type KnowledgeTreeNode = {
  key: string;
  title: string;
  kind: "directory" | "document";
  path?: string;
  children?: KnowledgeTreeNode[];
};

export type KnowledgeDocument = {
  libraryId: string;
  appScopeId?: string;
  sourceId: string;
  sourceLabel: string;
  workspaceAlias: string;
  role: KnowledgeRole;
  path: string;
  title: string;
  markdown: string;
  locator: KnowledgeLocator;
};

export type KnowledgeSearchHit = {
  libraryId: string;
  appScopeId?: string;
  sourceId: string;
  sourceLabel: string;
  workspaceAlias: string;
  role: KnowledgeRole;
  path: string;
  title: string;
  summary: string;
  score: number;
};
