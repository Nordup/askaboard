import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/500.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import 'katex/dist/katex.min.css';
import './design/app.css';
import './tutor/tutor.css';
import { Icon } from './design/Icon';
import { Composer } from './tutor/Composer';
import { MessageView } from './tutor/MessageView';
import { Orb } from './tutor/Orb';
import { SessionDrawer } from './tutor/SessionDrawer';
import { Settings } from './tutor/Settings';
import { WorkspaceCards } from './tutor/WorkspaceCards';
import { computeShellLayout, fullscreenSidebarOverlays, resolvePanelResize, SHELL } from './shell/layout';
import { shellSpringDuration, shellSpringEasing, springInitialProgressVelocity, springProgress, springVelocity } from './shell/spring';
import { chatVeil, drawerVeil, toggleOpacity } from './shell/reveal';
import { initialShellState, transitionShellState, type Presentation } from './shell/state';
import type { AppProps, TutorSettings, VoiceState } from './ui-types';
import type { BoardTool, Capture, LearningSignal } from './types';

const colors = ['#0A0A0A', '#6051DC', '#0155FB', '#40A365', '#E33E38'];
const toolDefs: Array<{ id: BoardTool; icon: string; label: string }> = [
  { id: 'pen', icon: 'tool/pen', label: 'Pen' },
  { id: 'highlighter', icon: 'tool/highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'tool/eraser', label: 'Eraser' },
  { id: 'lasso', icon: 'tool/lasso', label: 'Lasso' },
];

type PanKind = 'drawer' | 'sidebar';
interface PanGesture {
  kind: PanKind;
  startX: number;
  startY: number;
  startAt: number;
  lastX: number;
  lastAt: number;
  startProgress: number;
  axis: 'pending' | 'horizontal' | 'vertical';
  pointerId: number;
}
interface ResizeGesture { startX: number; startWidth: number; collapsed: boolean; pointerId: number }

function clamped(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function eventIsControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button,a,input,textarea,select,[role="menu"],[role="separator"],[contenteditable="true"]'));
}

function useViewport() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    if (document.documentElement) observer.observe(document.documentElement);
    return () => { window.removeEventListener('resize', update); observer.disconnect(); };
  }, []);
  return size;
}

export function App(props: AppProps) {
  const viewport = useViewport();
  const [shell, dispatch] = useReducer(transitionShellState, initialShellState);
  const [requestedPanelWidth, setRequestedPanelWidth] = useState<number>(SHELL.panelDefault);
  const [resizeHandleOffset, setResizeHandleOffset] = useState(0);
  const [authCode, setAuthCode] = useState('');
  const [activePan, setActivePan] = useState<PanKind | null>(null);
  const [, setRevealSettled] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [collapsedDockMounted, setCollapsedDockMounted] = useState(false);
  const [collapsedDockEntering, setCollapsedDockEntering] = useState(false);
  const [collapsedDockLeaving, setCollapsedDockLeaving] = useState(false);
  const panGesture = useRef<PanGesture | null>(null);
  const resizeGesture = useRef<ResizeGesture | null>(null);
  const revealProgress = useRef({ drawer: 0, sidebar: 0 });
  const revealAnimations = useRef<Record<PanKind, { frame: number; startedAt: number; from: number; to: number; velocity: number } | null>>({ drawer: null, sidebar: null });
  const releaseVelocity = useRef<Partial<Record<PanKind, number>>>({});
  const drawerRevealRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const overlaySidebarToggleRef = useRef<HTMLButtonElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const animatedPanel = useRef<HTMLElement>(null);
  const surfaceAnimation = useRef<Animation | null>(null);
  const lastDockPresentation = useRef<Presentation | null>(null);
  const lastEffectivePresentation = useRef<Presentation | null>(null);
  const collapsedDockTimer = useRef<number | null>(null);
  const collapsedDockFrame = useRef<number | null>(null);
  const collapsedDockElement = useRef<HTMLDivElement>(null);
  const lastVisiblePresentation = useRef<Presentation | null>(null);
  const layout = useMemo(() => computeShellLayout(viewport.width, viewport.height, requestedPanelWidth), [viewport, requestedPanelWidth]);
  const requestedPresentation = shell.presentation;
  // A narrow window uses the already-designed collapsed board state until a full-screen tutor is requested.
  const presentation: Presentation = requestedPresentation === 'docked' && !layout.canDockTutor ? 'collapsed' : requestedPresentation;
  const drawerProgress = revealProgress.current.drawer;
  const sidebarProgress = revealProgress.current.sidebar;
  const sidebarVisible = shell.sidebarOpen || sidebarProgress > 0;
  const isBusy = props.status.busy;
  const displayError = props.status.error || props.auth.error || props.voice.error || null;
  const currentSettings: TutorSettings = {
    model: props.workspace?.model ?? 'gpt-5.6-luna',
    reasoningEffort: props.workspace?.reasoningEffort ?? 'high',
  };
  const activeSession = props.workspace?.id ?? null;
  const messages = props.workspace?.messages ?? [];
  const canSelectBoard = props.canSelectBoard;
  const lastMessage = messages[messages.length - 1];
  const drawerWidth = layout.drawerWidth;
  const voiceIsActive = props.voice.phase !== 'idle' && props.voice.phase !== 'error';
  const voiceIsInVisibleSession = voiceIsActive && props.voice.sessionId === activeSession;
  const visibleVoice: VoiceState = voiceIsInVisibleSession ? props.voice : {
    ...props.voice,
    phase: 'idle',
    sessionId: null,
    inputTranscript: '',
    outputTranscript: '',
    inputLevel: 0,
    outputLevel: 0,
  };
  const awayVoiceSession = voiceIsActive && props.voice.sessionId && props.voice.sessionId !== activeSession
    ? props.sessions.find(session => session.id === props.voice.sessionId)
    : undefined;
  const sidebarWidth = layout.sidebarWidth;
  const sidebarOverlay = fullscreenSidebarOverlays(viewport.width, sidebarWidth);
  const sidebarLane = sidebarOverlay ? 0 : sidebarWidth;
  const isDragging = Boolean(activePan || isResizing);
  const onSettingsClose = useCallback(() => dispatch({ type: 'settings-open', value: false }), []);

  const writeRevealProgress = (kind: PanKind, rawProgress: number) => {
    const progress = clamped(rawProgress, 0, 1);
    revealProgress.current[kind] = progress;
    if (kind === 'drawer') {
      const reveal = drawerRevealRef.current;
      const content = chatContentRef.current;
      if (reveal) {
        reveal.style.transform = 'translateX(0px)';
        reveal.style.setProperty('--drawer-veil', String(drawerVeil(progress)));
        reveal.inert = progress === 0 || !shell.drawerOpen;
        reveal.setAttribute('aria-hidden', String(progress === 0));
        reveal.style.pointerEvents = progress > 0 ? 'auto' : 'none';
      }
      if (content) {
        content.style.transform = `translateX(${Math.round(progress * drawerWidth)}px)`;
        content.style.setProperty('--chat-veil', String(chatVeil(progress)));
        content.style.setProperty('--drawer-toggle-opacity', String(toggleOpacity(progress)));
        content.inert = progress > 0;
        content.setAttribute('aria-hidden', String(progress > 0));
      }
    } else {
      const sidebar = sidebarRef.current;
      if (sidebar) sidebar.style.transform = `translateX(${Math.round((progress - 1) * sidebarWidth)}px)`;
      const overlayToggle = overlaySidebarToggleRef.current;
      if (overlayToggle && sidebarOverlay) overlayToggle.style.left = `${28 + Math.round(progress * sidebarWidth)}px`;
      const panel = animatedPanel.current;
      if (panel && presentation === 'fullscreen') {
        panel.style.left = `${Math.round(sidebarLane * progress)}px`;
        panel.style.width = `calc(100% - ${Math.round(sidebarLane * progress)}px)`;
        const remainingWidth = Math.max(0, viewport.width - sidebarLane * progress);
        const columnWidth = Math.max(0, Math.min(SHELL.columnWidth, remainingWidth - 2 * (SHELL.peekWidth + SHELL.edge)));
        panel.style.setProperty('--column-width', `${columnWidth}px`);
      }
    }
  };

  const cancelRevealAnimation = (kind: PanKind) => {
    const animation = revealAnimations.current[kind];
    if (!animation) return 0;
    cancelAnimationFrame(animation.frame);
    const elapsed = Math.max(0, (performance.now() - animation.startedAt) / 1000);
    const velocity = springVelocity(elapsed, animation.from, animation.to, animation.velocity);
    revealAnimations.current[kind] = null;
    return velocity;
  };

  const animateReveal = (kind: PanKind, target: number, physicalVelocity = 0) => {
    const previousVelocity = cancelRevealAnimation(kind);
    const from = revealProgress.current[kind];
    const to = target ? 1 : 0;
    const travel = kind === 'drawer' ? drawerWidth : sidebarWidth;
    const velocity = physicalVelocity === 0 && previousVelocity !== 0
      ? previousVelocity
      : springInitialProgressVelocity(physicalVelocity, from, to, travel);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === to) {
      writeRevealProgress(kind, to);
      revealAnimations.current[kind] = null;
      return;
    }
    const startedAt = performance.now();
    const animation = { frame: 0, startedAt, from, to, velocity };
    const tick = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      const next = springProgress(elapsed, from, to, velocity);
      writeRevealProgress(kind, next);
      const speed = springVelocity(elapsed, from, to, velocity);
      if (elapsed >= shellSpringDuration && Math.abs(next - to) < 0.001 && Math.abs(speed) < 0.04) {
        writeRevealProgress(kind, to);
        revealAnimations.current[kind] = null;
        setRevealSettled(value => value + 1);
        return;
      }
      animation.frame = requestAnimationFrame(tick);
    };
    revealAnimations.current[kind] = animation;
    animation.frame = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    if (presentation === 'docked') animateReveal('drawer', shell.drawerOpen ? 1 : 0, releaseVelocity.current.drawer ?? 0);
    else {
      cancelRevealAnimation('drawer');
      writeRevealProgress('drawer', 0);
    }
    releaseVelocity.current.drawer = undefined;
  }, [shell.drawerOpen, presentation, drawerWidth]);

  useLayoutEffect(() => {
    if (presentation === 'fullscreen') animateReveal('sidebar', shell.sidebarOpen ? 1 : 0, releaseVelocity.current.sidebar ?? 0);
    else writeRevealProgress('sidebar', shell.sidebarOpen ? 1 : 0);
    releaseVelocity.current.sidebar = undefined;
  }, [shell.sidebarOpen, presentation, sidebarWidth, sidebarLane]);

  useLayoutEffect(() => {
    // React re-renders for transcript updates, but progress is kept outside React so a
    // drawer drag never rebuilds the thread or composer. Reapply the live transform after
    // React updates the panel's base styles.
    writeRevealProgress('drawer', revealProgress.current.drawer);
    writeRevealProgress('sidebar', revealProgress.current.sidebar);
  });

  useEffect(() => {
    const thread = threadRef.current;
    if (thread && following.current) thread.scrollTop = thread.scrollHeight;
  }, [messages.length, lastMessage?.text, presentation]);

  useEffect(() => {
    const previous = lastEffectivePresentation.current;
    lastEffectivePresentation.current = presentation;
    if (previous === 'docked' && presentation !== 'docked' && shell.drawerOpen) {
      dispatch({ type: 'drawer-open', value: false });
    }
  }, [presentation, shell.drawerOpen]);

  useLayoutEffect(() => {
    const element = animatedPanel.current;
    if (!element) return;
    const previous = lastVisiblePresentation.current;
    lastVisiblePresentation.current = presentation;
    if (previous === null || previous === presentation) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const interrupted = surfaceAnimation.current?.playState === 'running';
    const computed = getComputedStyle(element);
    surfaceAnimation.current?.cancel();
    if (reduce) {
      element.style.opacity = presentation === 'collapsed' ? '0' : '1';
      element.style.transform = 'none';
      return;
    }
    const fromTransform = interrupted ? computed.transform
      : previous === 'collapsed' ? `translateX(${presentation === 'fullscreen' ? -32 : 32}px)`
        : presentation === 'collapsed' ? 'translateX(0px)'
          : `translateX(${presentation === 'fullscreen' ? -32 : 32}px)`;
    const fromOpacity = interrupted ? computed.opacity : previous === 'collapsed' ? '0' : '1';
    const toOpacity = presentation === 'collapsed' ? '0' : '1';
    const toTransform = presentation === 'collapsed' ? 'translateX(32px)' : 'translateX(0)';
    const animation = element.animate([
      { opacity: fromOpacity, transform: fromTransform },
      { opacity: toOpacity, transform: toTransform },
    ], { duration: shellSpringDuration * 1000, easing: shellSpringEasing(), fill: 'both' });
    surfaceAnimation.current = animation;
    animation.onfinish = () => {
      if (surfaceAnimation.current !== animation) return;
      surfaceAnimation.current = null;
      animation.onfinish = null;
      animation.cancel();
      element.style.opacity = toOpacity;
      element.style.transform = 'none';
    };
  }, [presentation]);

  useLayoutEffect(() => {
    const previous = lastDockPresentation.current;
    lastDockPresentation.current = presentation;
    if (previous === null) {
      setCollapsedDockMounted(presentation === 'collapsed');
      return;
    }
    if (previous === presentation) return;
    if (collapsedDockTimer.current !== null) window.clearTimeout(collapsedDockTimer.current);
    if (collapsedDockFrame.current !== null) cancelAnimationFrame(collapsedDockFrame.current);

    if (presentation === 'collapsed') {
      setCollapsedDockMounted(true);
      setCollapsedDockLeaving(false);
      setCollapsedDockEntering(true);
      collapsedDockFrame.current = requestAnimationFrame(() => setCollapsedDockEntering(false));
    } else if (previous === 'collapsed') {
      setCollapsedDockEntering(false);
      setCollapsedDockLeaving(true);
      collapsedDockTimer.current = window.setTimeout(() => {
        setCollapsedDockMounted(false);
        setCollapsedDockLeaving(false);
        collapsedDockTimer.current = null;
      }, shellSpringDuration * 1000);
    }
  }, [presentation]);

  useEffect(() => () => {
    if (collapsedDockTimer.current !== null) window.clearTimeout(collapsedDockTimer.current);
    if (collapsedDockFrame.current !== null) cancelAnimationFrame(collapsedDockFrame.current);
  }, []);

  useEffect(() => () => surfaceAnimation.current?.cancel(), []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeGesture.current;
      if (resize && resize.pointerId === event.pointerId) {
        const result = resolvePanelResize(resize.startWidth, event.clientX - resize.startX, layout.maximumPanelWidth);
        resize.collapsed = result.collapsed;
        if (!result.collapsed) setRequestedPanelWidth(result.width);
        setResizeHandleOffset(result.handleOffset);
        event.preventDefault();
        return;
      }

      const gesture = panGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (gesture.axis === 'pending' && Math.hypot(dx, dy) >= 12) {
        const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
        gesture.axis = angle <= 38 ? 'horizontal' : 'vertical';
        if (gesture.axis === 'horizontal' && gesture.kind === 'drawer') {
          // A tap may have started while the spring was still running. Freeze its exact
          // current position at intent-lock, then keep the chat pane under the finger.
          cancelRevealAnimation('drawer');
          gesture.startProgress = revealProgress.current.drawer - dx / Math.max(1, drawerWidth);
        }
      }
      if (gesture.axis !== 'horizontal') return;
      const travel = gesture.kind === 'drawer' ? drawerWidth : sidebarWidth;
      const progress = clamped(gesture.startProgress + dx / Math.max(1, travel), 0, 1);
      gesture.lastX = event.clientX;
      gesture.lastAt = performance.now();
      setActivePan(gesture.kind);
      // The docked panes track the finger together. The full-screen sidebar is a separate
      // reading lane and commits only after the swipe is released, as it does in SwiftUI.
      if (gesture.kind === 'drawer') writeRevealProgress('drawer', progress);
      event.preventDefault();
    };
    const finish = (event: PointerEvent) => {
      const resize = resizeGesture.current;
      if (resize && resize.pointerId === event.pointerId) {
        if (resize.collapsed) dispatch({ type: 'presentation', value: 'collapsed' });
        resizeGesture.current = null;
        setIsResizing(false);
        setResizeHandleOffset(0);
        return;
      }
      const gesture = panGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (gesture.axis === 'horizontal') {
        const releaseAt = event.timeStamp || performance.now();
        const sampleElapsed = Math.max(1, releaseAt - gesture.lastAt);
        const sampleDistance = event.clientX - gesture.lastX;
        const velocity = sampleDistance / sampleElapsed * 1000;
        const dx = event.clientX - gesture.startX;
        const progress = gesture.kind === 'drawer'
          ? clamped(gesture.startProgress + dx / Math.max(1, drawerWidth), 0, 1)
          : (dx > 0 ? 1 : 0);
        // The full-screen lane uses the committed direction to choose its target; an
        // opposite fast release can reverse that choice just like the source recognizer.
        const open = velocity >= 300 ? true : velocity <= -300 ? false : progress >= 0.5;
        releaseVelocity.current[gesture.kind] = velocity;
        dispatch(gesture.kind === 'drawer' ? { type: 'drawer-open', value: open } : { type: 'sidebar-open', value: open });
      }
      panGesture.current = null;
      setActivePan(null);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [layout.maximumPanelWidth, drawerWidth, sidebarWidth]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (shell.settingsOpen || shell.drawerOpen || shell.sidebarOpen) {
        dispatch({ type: 'escape' });
        event.preventDefault();
        return;
      }
      if (props.selectedCapture || props.selectionMode) {
        clearBoardSelection();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [shell.settingsOpen, shell.drawerOpen, shell.sidebarOpen, props.selectedCapture, props.selectionMode, props.onClearCapture, props.onToggleSelection]);

  const beginPan = (kind: PanKind, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || shell.settingsOpen || eventIsControl(event.target)) return;
    if (kind === 'drawer' && presentation !== 'docked') return;
    if (kind === 'sidebar' && presentation !== 'fullscreen') return;
    const currentProgress = revealProgress.current[kind];
    panGesture.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      startAt: performance.now(),
      lastX: event.clientX,
      lastAt: performance.now(),
      startProgress: currentProgress,
      axis: 'pending',
      pointerId: event.pointerId,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is unavailable on older browsers. */ }
  };

  const send = async (text: string, attachments: Parameters<AppProps['onSend']>[1] = [], capture: Capture | null = null, signal?: LearningSignal) => {
    await props.onSend(text, attachments, capture, signal);
    clearBoardSelection();
  };
  const clearBoardSelection = () => {
    props.onClearCapture();
    if (props.selectionMode) props.onToggleSelection();
  };
  const createSession = () => { clearBoardSelection(); void props.onCreateSession(); dispatch({ type: 'session-selected' }); };
  const selectSession = (id: string) => { clearBoardSelection(); void props.onSelectSession(id); dispatch({ type: 'session-selected' }); };
  const sendSuggestion = (text: string, signal?: LearningSignal) => {
    const capture = signal === 'dontKnow' ? null : props.selectedCapture;
    void send(text, [], capture, signal).catch(() => {});
  };
  const openTutor = () => dispatch({ type: 'presentation', value: layout.canDockTutor ? 'docked' : 'fullscreen' });
  const startOnBoard = () => { props.onStartPlan(); dispatch({ type: 'presentation', value: 'collapsed' }); };
  const returnToChat = () => { props.onReturnToChat(); dispatch({ type: 'presentation', value: layout.canDockTutor ? 'docked' : 'fullscreen' }); };
  const errorBanner = displayError && <div className="status-error" role="status">
    {displayError}
    {props.status.preserve && <button className="retry-action" onClick={props.status.preserve}>Preserve a copy</button>}
    {props.status.retry && <button className="retry-action" onClick={props.status.retry}>Try again</button>}
  </div>;

  if (props.auth.required) return <div className="auth-backdrop"><form className="settings-window auth-window" onSubmit={event => { event.preventDefault(); void props.auth.submit(authCode); }}>
    <div className="settings-pane auth-pane"><header className="settings-heading"><h2>AI Tutor</h2><p>Enter your access code to open your workspace.</p></header><label className="auth-label">Access code<input autoFocus type="password" autoComplete="one-time-code" value={authCode} onChange={event => setAuthCode(event.target.value)} /></label>{props.auth.error && <div className="status-error">{props.auth.error}</div>}<button className="primary-button" disabled={!authCode || props.auth.busy}>{props.auth.busy ? 'Connecting…' : 'Continue'}</button></div>
  </form></div>;

  const shellStyle = {
    '--tutor-width': `${layout.panelWidth}px`,
    '--rail-x': `${presentation === 'collapsed' ? layout.railXCollapsed : layout.railX}px`,
    '--board-x': `${presentation === 'collapsed' ? layout.boardXCollapsed : layout.boardX}px`,
    '--board-width': `${presentation === 'collapsed' ? layout.boardWidthCollapsed : layout.boardWidthDocked}px`,
    '--content-top': `${layout.contentTop}px`,
    '--content-height': `${layout.contentHeight}px`,
    '--drawer-width': `${drawerWidth}px`,
    '--drawer-progress': drawerProgress,
    '--sidebar-width': `${sidebarWidth}px`,
    '--sidebar-progress': sidebarProgress,
    '--shell-spring-easing': shellSpringEasing(),
    '--column-x': `${shell.sidebarOpen && !sidebarOverlay ? layout.columnXWithSidebar : layout.columnX}px`,
    '--column-width': `${shell.sidebarOpen && !sidebarOverlay ? layout.columnWidthWithSidebar : layout.columnWidth}px`,
    '--resize-offset': `${resizeHandleOffset}px`,
  } as React.CSSProperties;
  const panelStyle = {
    left: presentation === 'fullscreen' ? '0px' : `${layout.panelX}px`,
    top: presentation === 'fullscreen' ? 0 : `${layout.contentTop}px`,
    width: presentation === 'fullscreen' ? '100%' : `${layout.panelWidth}px`,
    height: presentation === 'fullscreen' ? '100%' : `${layout.contentHeight}px`,
    opacity: presentation === 'collapsed' ? 0 : 1,
    pointerEvents: presentation === 'collapsed' ? 'none' : 'auto',
  } as React.CSSProperties;
  const peekHeight = Math.max(100, layout.contentHeight);
  const peekPath = `M45,0 H11.91 A11.91,18 0 0 0 0,18 V46 A11.91,18 0 0 0 11.91,64 H14.56 A11.91,18 0 0 1 26.47,82 V${peekHeight - 18} A11.91,18 0 0 0 38.38,${peekHeight} H45 Z`;
  const threadClass = `thread ${presentation === 'fullscreen' ? 'thread--fullscreen' : ''}`;
  const composerClass = `composer-wrap ${presentation === 'fullscreen' ? 'composer-wrap--fullscreen' : ''}`;

  return <main
    className={`app-shell mode-${presentation}${shell.settingsOpen ? ' has-settings' : ''}${isDragging ? ' is-dragging' : ''}`}
    data-fit={layout.fit}
    data-presentation={presentation}
    style={shellStyle}
  >
    {props.board && <div
      className={`board-frame${presentation === 'fullscreen' ? ' board-frame--hidden' : ''}`}
      aria-label="Whiteboard"
      aria-hidden={presentation === 'fullscreen'}
      aria-describedby="board-history-status"
      data-can-undo={props.canUndo}
      data-can-redo={props.canRedo}
      style={{ left: 'var(--board-x)', top: 'var(--content-top)', width: 'var(--board-width)', height: 'var(--content-height)' }}
    >{props.board}<span id="board-history-status" className="screen-reader-only">Undo {props.canUndo ? 'available' : 'unavailable'}; redo {props.canRedo ? 'available' : 'unavailable'}. Use Command or Control with Z to undo, and Shift with Z to redo.</span></div>}

    {presentation !== 'fullscreen' && <aside className="tool-rail" aria-label="Board tools" style={{ left: 'var(--rail-x)', top: 'var(--content-top)' }}>
      <div className="tool-group">{toolDefs.map(tool => <button key={tool.id} className={`tool-slot ${props.boardTool === tool.id ? 'is-selected' : ''}`} aria-label={tool.label} aria-pressed={props.boardTool === tool.id} onClick={() => props.onBoardToolChange(tool.id)}><Icon name={tool.icon} size={28} /></button>)}</div>
      <div className="rail-divider" />
      <div className="swatches" aria-label="Pen color">{colors.map(color => <button key={color} className={`swatch ${props.boardColor.toLowerCase() === color.toLowerCase() ? 'is-selected' : ''}`} style={{ backgroundColor: color }} aria-label={`Choose ${color}`} aria-pressed={props.boardColor.toLowerCase() === color.toLowerCase()} onClick={() => props.onBoardColorChange(color)} />)}</div>
      <div className="width-swatch" role="img" aria-label={`Stroke thickness ${props.boardWidth}px`}><span style={{ height: `${Math.max(2.5, props.boardWidth)}px`, backgroundColor: props.boardColor }} /></div>
      <button className="tool-slot center-tool" aria-label="Fit board to view" onClick={() => props.onFitBoard()}><Icon name="tool/center" size={26} /></button>
    </aside>}

    {collapsedDockMounted && <div
      ref={collapsedDockElement}
      className={`collapsed-dock${collapsedDockEntering ? ' collapsed-dock--entering' : ''}${collapsedDockLeaving ? ' collapsed-dock--leaving' : ''}`}
      aria-hidden={presentation !== 'collapsed'}
      inert={presentation !== 'collapsed'}
      style={{ left: `${layout.collapsedDockX}px`, top: `${layout.collapsedDockY}px`, pointerEvents: presentation === 'collapsed' ? 'auto' : 'none' }}
    >
      <button className="collapsed-open" onClick={openTutor} aria-label="Open the tutor"><Orb variant="collapsed" phase={props.voice.phase} inputLevel={props.voice.inputLevel} outputLevel={props.voice.outputLevel} /></button>
      <button className={`collapsed-select ${props.selectionMode || props.selectedCapture ? 'is-selected' : ''}`} aria-label={props.selectedCapture ? 'Remove board selection' : 'Select a board region'} aria-pressed={props.selectionMode || Boolean(props.selectedCapture)} disabled={!canSelectBoard} onClick={() => {
        if (props.selectedCapture) clearBoardSelection();
        else props.onToggleSelection();
      }}><Icon name="ui/selection-marker" size={24} /></button>
    </div>}

    <section
      ref={element => { animatedPanel.current = element; }}
    className={`chat-panel${presentation === 'fullscreen' ? ' chat-panel--fullscreen' : ''}${drawerProgress > 0 && presentation === 'docked' ? ' has-drawer' : ''}${presentation === 'fullscreen' && sidebarVisible ? ' has-sidebar' : ''}${presentation === 'fullscreen' && sidebarOverlay && sidebarVisible ? ' has-overlay-sidebar' : ''}`}
      style={panelStyle}
      aria-hidden={presentation === 'collapsed'}
      inert={presentation === 'collapsed'}
      onPointerDown={event => beginPan(presentation === 'fullscreen' ? 'sidebar' : 'drawer', event)}
        onClick={event => {
          if (presentation === 'docked' && drawerProgress > 0 && event.clientX >= layout.panelX + drawerWidth && !eventIsControl(event.target)) {
            dispatch({ type: 'drawer-open', value: false });
          }
        }}
    >
      {presentation === 'docked' && <div
        ref={drawerRevealRef}
        className="docked-drawer-reveal"
        aria-hidden={drawerProgress === 0}
        style={{ transform: 'translateX(0px)', pointerEvents: drawerProgress > 0 ? 'auto' : 'none' }}
      >
        <SessionDrawer
          sessions={props.sessions} activeId={activeSession} variant="docked" width={drawerWidth}
          onClose={() => dispatch({ type: 'drawer-open', value: false })}
          onCreate={createSession}
          onSelect={selectSession}
          onRename={(id, title) => void props.onRenameSession(id, title)}
          onDelete={id => void props.onDeleteSession(id)}
          onSettings={() => dispatch({ type: 'settings-open', value: true })}
        />
      </div>}

      <div ref={chatContentRef} className="chat-panel-content" style={{ transform: presentation === 'docked' ? `translateX(${drawerProgress * drawerWidth}px)` : undefined }}>
        <header className="panel-top">
          <button className="icon-button" aria-label={presentation === 'fullscreen' ? (shell.sidebarOpen ? 'Close sessions sidebar' : 'Open sessions sidebar') : (shell.drawerOpen ? 'Close sessions' : 'Open sessions')} onClick={() => dispatch({ type: presentation === 'fullscreen' ? 'toggle-sidebar' : 'toggle-drawer' })}><Icon name="ui/sidebar-toggle" /></button>
          <span className="panel-title" aria-hidden="true" />
        </header>
        <div ref={threadRef} className={threadClass} aria-live="polite" onScroll={event => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
          {messages.length === 0 && <div className="start-state">
            <Orb variant="panel" phase={props.voice.phase} inputLevel={props.voice.inputLevel} outputLevel={props.voice.outputLevel} />
            <div className="greeting">
              <h1>Hi! I'm your AI Tutor</h1><p>I'm here to help you learn, practice and achieve your goals.</p>
              <div className="suggestions">{[
                ['chip/explain', 'Explain this concept', undefined],
                ['chip/example', 'Give me an example', undefined],
                ['chip/exercise', 'Create an exercise', undefined],
                ['chip/confused', "I don't understand this", 'dontKnow'],
              ].map(([icon, label, signal]) => <button className="suggestion" key={label} onClick={() => sendSuggestion(label!, signal as LearningSignal | undefined)}><Icon name={icon!} size={22} />{label}</button>)}</div>
            </div>
          </div>}
          {messages.map(message => <MessageView key={message.id} message={message} sessionId={activeSession ?? ''} onEdit={message.role === 'user' ? props.onEditMessage : undefined} />)}
          {isBusy && <div className="status-sync" role="status">{props.status.phase ?? 'Working…'}</div>}
          {props.workspace && <WorkspaceCards workspace={props.workspace} onStartPlan={startOnBoard} onReturnToChat={returnToChat} />}
          {voiceIsInVisibleSession && <div className="voice-state-orb"><Orb variant={props.voice.phase === 'resting' ? 'resting' : 'live'} phase={props.voice.phase} inputLevel={props.voice.inputLevel} outputLevel={props.voice.outputLevel} /></div>}
        </div>
        {errorBanner}
        <div className={composerClass}>
        <Composer
          ready={Boolean(props.workspace)} sessionId={activeSession ?? ''} selectedCapture={props.selectedCapture}
          selectionMode={props.selectionMode} canSelectBoard={canSelectBoard} onToggleSelection={props.onToggleSelection}
          editDraft={props.editDraft} onCancelEdit={props.onCancelEdit} onSubmitEdit={props.onSubmitEdit}
          voice={visibleVoice} dictationState={props.dictationState} busy={isBusy}
          liveAvailable={Boolean(props.workspace && props.config?.liveAvailable)} onStop={props.onStop}
          onSend={send} onAttach={props.onAttach} onClearCapture={clearBoardSelection}
          onDictation={props.onDictation} onVoiceAction={props.onVoiceAction}
        />
        </div>
        <footer className="panel-footer screen-reader-only">{props.status.sync && <span className="status-sync" title={props.status.sync}>{props.status.sync}</span>}</footer>
      </div>
      {presentation === 'docked' && <div className="panel-controls">
        <button className="icon-button" aria-label="Full screen tutor" onClick={() => dispatch({ type: 'presentation', value: 'fullscreen' })}><Icon name="control/full" /></button>
        <button className="icon-button" aria-label="Collapse tutor" onClick={() => dispatch({ type: 'presentation', value: 'collapsed' })}><Icon name="control/dock" /></button>
      </div>}
    </section>

    {awayVoiceSession && <div
      className="away-voice-lane"
      style={{
        left: presentation === 'fullscreen' ? 0 : presentation === 'collapsed' ? layout.boardXCollapsed : layout.boardX,
        width: presentation === 'fullscreen' ? viewport.width : presentation === 'collapsed' ? layout.boardWidthCollapsed : layout.boardWidthDocked,
        top: layout.contentTop + 8,
      }}
    ><button className="away-voice-pill" aria-label={`Return to voice call in ${awayVoiceSession.title || 'this chat'}`} onClick={() => selectSession(awayVoiceSession.id)}>
      <span className="away-voice-orb"><Orb variant={props.voice.phase === 'resting' ? 'resting' : 'live'} phase={props.voice.phase} inputLevel={props.voice.inputLevel} outputLevel={props.voice.outputLevel} /></span>
      <span>Voice · {awayVoiceSession.title || 'this chat'}</span>
    </button></div>}

    {presentation === 'docked' && <div
      className="resize-handle"
      style={{ left: `${layout.resizeStripX}px`, top: `${layout.contentTop}px`, height: `${layout.contentHeight}px`, transform: `translateX(${resizeHandleOffset}px)` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizeGesture.current = { startX: event.clientX, startWidth: layout.panelWidth, collapsed: false, pointerId: event.pointerId };
        setIsResizing(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
      }}
      onDoubleClick={() => { setRequestedPanelWidth(SHELL.panelDefault); setResizeHandleOffset(0); }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const delta = event.key === 'ArrowRight' ? SHELL.resizeAccessibilityStep : -SHELL.resizeAccessibilityStep;
          setRequestedPanelWidth(current => clamped(current + delta, SHELL.panelMinimum, layout.maximumPanelWidth));
        } else if (event.key === 'Home') {
          event.preventDefault(); setRequestedPanelWidth(SHELL.panelDefault);
        }
      }}
      role="separator" aria-label="Resize tutor panel" aria-orientation="vertical" aria-valuemin={SHELL.panelMinimum} aria-valuemax={layout.maximumPanelWidth} aria-valuenow={layout.panelWidth} tabIndex={0}
    />}

    {presentation === 'fullscreen' && <>
      {sidebarVisible ? <div ref={sidebarRef} className={`fullscreen-sidebar${sidebarOverlay ? ' fullscreen-sidebar--overlay' : ''}`} style={{ width: sidebarWidth, transform: `translateX(${(sidebarProgress - 1) * sidebarWidth}px)` }} onPointerDown={event => beginPan('sidebar', event)}>
        <SessionDrawer
          sessions={props.sessions} activeId={activeSession} variant="sidebar" width={sidebarWidth}
          onClose={() => dispatch({ type: 'sidebar-open', value: false })}
          onCreate={createSession}
          onSelect={selectSession}
          onRename={(id, title) => void props.onRenameSession(id, title)}
          onDelete={id => void props.onDeleteSession(id)}
          onSettings={() => dispatch({ type: 'settings-open', value: true })}
        />
      </div> : null}
      {sidebarOverlay && sidebarVisible && <button
        ref={overlaySidebarToggleRef}
        className="icon-button fullscreen-overlay-toggle"
        aria-label="Close sessions sidebar"
        style={{ left: `${28 + Math.round(sidebarProgress * sidebarWidth)}px` }}
        onClick={() => dispatch({ type: 'sidebar-open', value: false })}
      ><Icon name="ui/sidebar-toggle" /></button>}
      <button className="board-peek-toggle" aria-label="Return to the board" style={{ clipPath: 'url(#board-peek-hit)' }} onClick={() => dispatch({ type: 'presentation', value: 'docked' })}>
        <svg className="board-peek-shape" viewBox={`0 0 45 ${peekHeight}`} preserveAspectRatio="none" aria-hidden="true">
          <defs><clipPath id="board-peek-hit" clipPathUnits="userSpaceOnUse"><path d={peekPath} /></clipPath></defs>
          <path d={peekPath} />
        </svg>
        <Icon name="board/hinge" size={22} />
      </button>
    </>}

    {shell.settingsOpen && <Settings settings={currentSettings} config={props.config} busy={isBusy} error={displayError} onSave={settings => void props.onSaveSettings(settings)} onClose={onSettingsClose} onReset={() => {
      void Promise.resolve().then(() => props.onResetSession()).then(() => { clearBoardSelection(); dispatch({ type: 'settings-open', value: false }); }).catch(() => {});
    }} />}
  </main>;
}

export default App;
