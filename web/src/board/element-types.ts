/** Board scene elements as they cross the Swift `BoardElement` JSON boundary.
 *
 * Geometry names stay in their wire spelling so a scene can be rendered and
 * round-tripped without an adapter silently dropping a primitive. Shared
 * style values are optional because older scene payloads may omit them; Swift
 * supplies the same defaults when it decodes those payloads.
 */
export interface BoardElementStyle {
  role?: 'content' | 'hint' | 'correction' | 'emphasis';
  stroke?: string;
  fill?: string;
  stroke_width?: number;
  opacity?: number;
  dash?: number[];
  rotation?: number;
}

export type BoardTextAlignment = 'left' | 'center' | 'right';
export type BoardPoint = [number, number];
interface BoardElementBase extends BoardElementStyle {
  id: string;
  kind: string;
  /** Older stored scenes carry shared style under this key. */
  style?: BoardElementStyle;
  /** Keep additional server fields round-trippable while known fields remain typed. */
  [key: string]: unknown;
}

export type BoardElement =
  | (BoardElementBase & { kind: 'text'; x: number; y: number; text: string; font_size: number; alignment?: BoardTextAlignment; width?: number })
  | (BoardElementBase & { kind: 'line'; x1: number; y1: number; x2: number; y2: number })
  | (BoardElementBase & { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; head_size?: number })
  | (BoardElementBase & { kind: 'rectangle'; x: number; y: number; width: number; height: number })
  | (BoardElementBase & { kind: 'ellipse'; x: number; y: number; width: number; height: number })
  | (BoardElementBase & { kind: 'circle'; cx: number; cy: number; radius: number })
  | (BoardElementBase & { kind: 'polygon'; points: BoardPoint[] })
  | (BoardElementBase & { kind: 'polyline'; points: BoardPoint[] })
  | (BoardElementBase & { kind: 'freehand'; points: BoardPoint[] })
  | (BoardElementBase & { kind: 'arc'; cx: number; cy: number; radius: number; start_angle: number; end_angle: number })
  | (BoardElementBase & { kind: 'angle_marker'; vertex_x: number; vertex_y: number; ray1_x: number; ray1_y: number; ray2_x: number; ray2_y: number; radius?: number; right_angle?: boolean })
  | (BoardElementBase & { kind: 'path'; d: string; fill_rule?: 'nonzero' | 'evenodd' })
  | (BoardElementBase & { kind: 'math_text'; x: number; y: number; latex: string; font_size: number })
  | (BoardElementBase & { kind: 'ink_text'; x: number; y: number; text: string; size?: number })
  | (BoardElementBase & { kind: 'image'; x: number; y: number; width: number; height: number; blob_id: string })
  | (BoardElementBase & { kind: 'svg'; x: number; y: number; width?: number; height?: number; svg: string });

export type BoardElementKind = BoardElement['kind'];
