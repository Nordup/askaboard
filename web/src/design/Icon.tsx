import iconExport from '../../../design/icons.json';

type Element = { type: string; d?: string; x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; r?: number; fill?: string; stroke?: string; strokeWidth?: number | null; lineCap?: string | null; lineJoin?: string | null; dashArray?: number[] | null };
type IconExport = { icons: Array<{ name: string; viewBox: { width: number; height: number }; renderSize: number; elements: Element[] }> };
const icons = (iconExport as IconExport).icons;

/** Product glyphs are rendered from the verbatim SVG path data exported from Paper. */
export function Icon({ name, size, className }: { name: string; size?: number; className?: string }) {
  const item = icons.find(icon => icon.name === name);
  if (!item) return null;
  const strokeValue = (value: string | undefined) => value ?? 'none';
  return <svg className={className} width={size ?? item.renderSize} height={size ?? item.renderSize} viewBox={`0 0 ${item.viewBox.width} ${item.viewBox.height}`} fill="none" aria-hidden="true">
    {item.elements.map((element, index) => {
      const common = { fill: element.fill === 'none' ? 'none' : element.fill?.startsWith('var(') ? element.fill : element.fill ?? 'none', stroke: strokeValue(element.stroke), strokeWidth: element.strokeWidth ?? undefined, strokeLinecap: element.lineCap as 'butt' | 'round' | 'square' | undefined, strokeLinejoin: element.lineJoin as 'miter' | 'round' | 'bevel' | undefined, strokeDasharray: element.dashArray?.join(' ') };
      switch (element.type) {
        case 'path': return <path key={index} {...common} d={element.d} />;
        case 'circle': return <circle key={index} {...common} cx={element.cx} cy={element.cy} r={element.r} />;
        case 'rect': return <rect key={index} {...common} x={element.x} y={element.y} width={element.width} height={element.height} />;
        default: return null;
      }
    })}
  </svg>;
}

/** The voice-chat glyph is exported from Paper artboard 7R4-0 (node 7TV-0). */
export function VoiceChatIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 10v4" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" /><path d="M9.7 7.4v9.2" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" /><path d="M14.3 5.6v12.8" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" /><path d="M18.8 9.2v5.6" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" /></svg>;
}
