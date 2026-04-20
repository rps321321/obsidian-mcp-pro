export interface NoteMetadata {
  title: string;
  relativePath: string;
  created: Date | null;
  modified: Date | null;
  size: number;
  tags: string[];
  frontmatter: Record<string, unknown>;
  aliases: string[];
}

export interface VaultConfig {
  vaultPath: string;
  configPath?: string;
}

export interface SearchResult {
  path: string;
  relativePath: string;
  matches: SearchMatch[];
  score: number;
}

export interface SearchMatch {
  line: number;
  content: string;
  column: number;
}

export interface LinkInfo {
  source: string;
  target: string;
  displayText?: string;
  isEmbed: boolean;
}

export interface TagInfo {
  tag: string;
  count: number;
  files: string[];
}

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  label?: string;
  color?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface DailyNoteConfig {
  folder: string;
  format: string;
  template?: string;
}

export interface GraphNeighbor {
  path: string;
  depth: number;
  direction: "inbound" | "outbound" | "both";
}

export interface BrokenLink {
  sourcePath: string;
  targetLink: string;
  line: number;
}

export interface OrphanNote {
  path: string;
  hasOutlinks: boolean;
  hasBacklinks: boolean;
}
