export type Point = [number, number];
export interface InkPoint { x: number; y: number; pressure: number; time: number; }
export interface Stroke { id: string; tool: 'pen' | 'highlighter'; color: string; width: number; points: InkPoint[]; }
export interface Camera { center: Point; zoom: number; }
export type BoardTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'hand' | 'selection';
export interface BoardElement {
  id: string;
  kind: string;
  [key: string]: unknown;
}
export interface BoardScene { elements: BoardElement[]; }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; }
export interface Source { title?: string; url: string; [key: string]: unknown; }
export interface Activity { id: string; label: string; detail?: string; status?: string; }
export interface Attachment { id: string; filename: string; thumbnail_blob_key?: string; [key: string]: unknown; }
export interface Workspace {
  version: 1;
  id: string;
  title: string;
  strokes: Stroke[];
  scene: BoardScene;
  camera: Camera;
  messages: Message[];
  model: string;
  reasoningEffort: string;
  plan: unknown;
  exercise: unknown;
  sources?: Source[];
  activity?: Activity[];
  updatedAt: string;
}
export interface BoardRegion { x: number; y: number; width: number; height: number; }
export interface Capture { image_base64: string; region: BoardRegion; }
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
  onChange(patch: Partial<Workspace>): void;
  onSelection(capture: Capture | null): void;
  onError(message: string): void;
}
