import type { BoardElement } from './board/element-types';

export type Point = [number, number];
export interface InkPoint { x: number; y: number; pressure: number; time: number; }
export interface Stroke { id: string; tool: 'pen' | 'highlighter'; color: string; width: number; points: InkPoint[]; }
export interface Camera { center: Point; zoom: number; }
export type BoardTool = 'pen' | 'highlighter' | 'eraser' | 'lasso';
export type { BoardElement };
export interface BoardScene { elements: BoardElement[]; }

export interface Source { title?: string; url: string; snippet?: string; domain?: string; [key: string]: unknown; }
export type ActivityItem =
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'step'; id: string; tool: string; label: string; imageId?: string }
  | { kind: 'search'; id: string; query: string; sources: Source[] };
export interface ActivityTrail { items: ActivityItem[]; duration?: number; }
/** Legacy activity shape accepted while old local workspaces are upgraded. */
export interface Activity { id: string; label: string; detail?: string; status?: string; }

export interface Attachment {
  id: string;
  filename: string;
  kind?: string;
  content_type?: string;
  thumbnail_base64?: string | null;
  page_count?: number | null;
  thumbnail_blob_key?: string;
  [key: string]: unknown;
}
export interface MessageCapture { imageId: string; region: BoardRegion; }
export type LearningSignal = 'evaluate' | 'dontKnow' | 'voice';
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: Attachment[];
  capture?: MessageCapture;
  signal?: LearningSignal;
  isVoice?: boolean;
  sources?: Source[];
  activity?: ActivityTrail;
}

export interface Workspace {
  version: 1;
  id: string;
  /** Derived (`workspace/title.ts`) and cached for the server's session list; never set directly. */
  title: string;
  /** The learner's rename, if any; `null` once the workspace uses derived titles. */
  customTitle?: string | null;
  strokes: Stroke[];
  scene: BoardScene;
  camera: Camera;
  messages: Message[];
  model: string;
  reasoningEffort: string;
  plan: unknown;
  exercise: unknown;
  isWorkspace?: boolean;
  /** Legacy global cards are still decoded, then migrated to message trails. */
  sources?: Source[];
  activity?: Activity[];
  updatedAt: string;
}
export interface BoardRegion { x: number; y: number; width: number; height: number; }
export interface Capture { image_base64: string; region: BoardRegion; }
export interface BoardHistory { canUndo: boolean; canRedo: boolean; }
export interface BoardHandle {
  context(): string;
  capture(region?: BoardRegion): Promise<Capture>;
  overview(): Promise<string>;
  fit(): void;
  undo(): void;
  redo(): void;
  clear(): void;
}
export interface BoardProps {
  workspace: Workspace;
  tool: BoardTool;
  color: string;
  width: number;
  selectionMode: boolean;
  onChange(patch: Partial<Workspace>): void;
  onSelection(capture: Capture | null): void;
  onHistoryChange(history: BoardHistory): void;
  onError(message: string): void;
}
