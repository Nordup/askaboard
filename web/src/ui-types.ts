import type { ReactNode } from 'react';
import type { Activity, Attachment, BoardTool, Capture, Source, Workspace } from './types';

export interface SessionSummary {
  id: string;
  title: string;
  updated_at?: string;
  updatedAt?: string;
}

export type VoicePhase = 'idle' | 'connecting' | 'live' | 'resting' | 'closing' | 'error';
export interface VoiceState {
  phase: VoicePhase;
  muted: boolean;
  sessionId: string | null;
  inputTranscript: string;
  outputTranscript: string;
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
  sources: Source[];
  activity: Activity[];
  selectedCapture: Capture | null;
  voice: VoiceState;
  dictationState: 'idle' | 'recording' | 'transcribing';
  boardTool: BoardTool;
  boardColor: string;
  boardWidth: number;
  onCreateSession(): Promise<void> | void;
  onSelectSession(id: string): Promise<void> | void;
  onRenameSession(id: string, title: string): Promise<void> | void;
  onDeleteSession(id: string): Promise<void> | void;
  onSaveSettings(settings: TutorSettings): Promise<void> | void;
  onSend(text: string, attachmentIds?: string[], capture?: Capture | null): Promise<void>;
  onEditMessage(messageId: string, text: string): Promise<void>;
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
  onClearBoard(): void;
  onFitBoard(): void;
  onEvaluate(): void;
}
