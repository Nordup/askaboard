import type { ReactNode } from 'react';
import type { Activity, Attachment, BoardTool, Capture, LearningSignal, Source, Workspace } from './types';

export interface SessionSummary {
  id: string;
  title: string;
  updated_at?: string;
  updatedAt?: string;
}

export type VoicePhase = 'idle' | 'connecting' | 'live' | 'listening' | 'thinking' | 'talking' | 'resting' | 'closing' | 'error';
export interface VoiceState {
  phase: VoicePhase;
  muted: boolean;
  sessionId: string | null;
  inputTranscript: string;
  outputTranscript: string;
  inputLevel?: number;
  outputLevel?: number;
  error?: string | null;
}

export interface TutorSettings {
  model: string;
  reasoningEffort: string;
}

export interface AppConfig {
  models: string[];
  effortsForModel: Record<string, string[]>;
  liveAvailable: boolean;
}

export interface AppProps {
  config?: AppConfig;
  workspace: Workspace | null;
  sessions: SessionSummary[];
  board: ReactNode;
  auth: {
    required: boolean;
    busy: boolean;
    error: string | null;
    submit(code: string): Promise<void> | void;
  };
  status: {
    busy: boolean;
    error: string | null;
    sync: string;
    phase?: string | null;
    retry?: () => void;
    preserve?: () => void;
  };
  /** Legacy aggregate values remain available for old saved workspaces. */
  sources: Source[];
  activity: Activity[];
  selectedCapture: Capture | null;
  voice: VoiceState;
  dictationState: 'idle' | 'recording' | 'transcribing';
  boardTool: BoardTool;
  boardColor: string;
  boardWidth: number;
  selectionMode: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSelectBoard: boolean;
  editDraft: { messageId: string; text: string } | null;
  onCreateSession(): Promise<void> | void;
  onResetSession(): Promise<void> | void;
  onSelectSession(id: string): Promise<void> | void;
  onRenameSession(id: string, title: string): Promise<void> | void;
  onDeleteSession(id: string): Promise<void> | void;
  onSaveSettings(settings: TutorSettings): Promise<void> | void;
  onSend(text: string, attachments?: Attachment[], capture?: Capture | null, signal?: LearningSignal): Promise<void>;
  onEditMessage(messageId: string): void;
  onCancelEdit(): void;
  onSubmitEdit(messageId: string, text: string): Promise<void>;
  onStop(): void;
  onAttach(files: File[]): Promise<Attachment[]>;
  onClearCapture(): void;
  onDictation(): Promise<string>;
  onVoiceAction(action: 'start' | 'end' | 'mute' | 'rest' | 'wake' | 'return'): Promise<void> | void;
  onBoardToolChange(tool: BoardTool): void;
  onBoardColorChange(color: string): void;
  onBoardWidthChange(width: number): void;
  onUndo(): void;
  onRedo(): void;
  onToggleSelection(): void;
  onClearBoard(): void;
  onFitBoard(): void;
  onEvaluate(): Promise<void> | void;
  onStartPlan(): void;
  onReturnToChat(): void;
}
