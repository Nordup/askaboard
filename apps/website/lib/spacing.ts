/**
 * The page's spacing between sections, in one place (the founder, 2026-11-07: "Can you please make
 * sure that that never changes and never breaks whatever we change inside those sections ... I
 * don't want to keep repeating myself.").
 *
 * RULE: a gap is the empty board the visitor sees between the last content of one section and the
 * first content of the next (board items' boxes with their size, scale and turn, and the page-text
 * blocks), in design units (--u). These GAPS are the only spacing values. A section's height and
 * offsets are derived from its content (sectionBox below); never set a section's height or margin
 * by hand. Move, add, resize or remove items inside a section freely: the gaps stay the same.
 * Content that is sized only in the browser counts too: on a phone the app shell's chat window
 * hangs under the shell, and AppShell.tsx measures its overhang (--shell-overhang) for the agent
 * section's margin (Sections.module.css).
 */
import { PHONE, SPRITES, type Place } from '@/components/hero/layout'

type Pair = { desk: number; phone: number }

/** The approved gaps (design units), measured on the page the founder approved. */
export const GAPS: Record<'heroToShell' | 'shellToAgents' | 'agentsToDownload' | 'downloadToFooter', Pair> = {
  heroToShell: { desk: 41, phone: 41 },
  shellToAgents: { desk: 199, phone: 99 },
  agentsToDownload: { desk: 172, phone: 108 },
  downloadToFooter: { desk: 279, phone: 110 }
}

/** A vertical extent in design units: top and bottom. */
export interface Extent {
  top: number
  bottom: number
}

/** The vertical extent of a board item at a place: its box turned by r and scaled by s. */
function itemExtent(w: number, h: number, p: Place): Extent {
  const a = (Math.abs(p.r) * Math.PI) / 180
  const half = (p.s * (w * Math.sin(a) + h * Math.cos(a))) / 2
  return { top: p.y - half, bottom: p.y + half }
}

/** The extent of the board items with this anchor (none: the hero's own items), with any page-text blocks. */
function contentExtent(anchor: string | null, layout: 'desk' | 'phone', text: Extent[] = []): Extent {
  let top = Infinity
  let bottom = -Infinity
  for (const def of SPRITES) {
    if (def.step || (def.anchor ?? null) !== anchor) continue
    const place = layout === 'desk' ? (def.deskOff ? undefined : def.desk) : def.phone
    if (!place) continue
    const e = itemExtent(def.w, def.h, place)
    top = Math.min(top, e.top)
    bottom = Math.max(bottom, e.bottom)
  }
  for (const e of text) {
    top = Math.min(top, e.top)
    bottom = Math.max(bottom, e.bottom)
  }
  return { top, bottom }
}

/** The hero's content bottom below its frame's origin (its centre on a desktop, its top on a phone). */
export const HERO_BOTTOM: Pair = { desk: contentExtent(null, 'desk').bottom, phone: contentExtent(null, 'phone').bottom }
/**
 * The app shell section's top padding (design units): its window's top sits GAPS.heroToShell below
 * the hero's content. Desktop: the hero is --hero-h tall with its origin at its centre, so the CSS
 * subtracts half of --hero-h (AppShell.module.css). Phone: the hero is PHONE.h units from its top.
 */
export const SHELL_PAD: Pair = {
  desk: GAPS.heroToShell.desk + HERO_BOTTOM.desk,
  phone: GAPS.heroToShell.phone + HERO_BOTTOM.phone - PHONE.h
}

/**
 * A section placed from an anchor: its content's extent from the anchor (the section's top), and
 * the CSS values that put its content `gapBefore` below the previous section's content and end the
 * section at its content's bottom (plus `gapAfter`, for the last section before the footer).
 * Values are in design units; the caller multiplies by --u.
 */
export function sectionBox(anchor: string, text: { desk: Extent[]; phone: Extent[] }, gapBefore: Pair, gapAfter: Pair = { desk: 0, phone: 0 }) {
  const desk = contentExtent(anchor, 'desk', text.desk)
  const phone = contentExtent(anchor, 'phone', text.phone)
  return {
    /** The margin above the section, less what the previous section's content leaves below its box (the caller adds that). */
    marginDesk: gapBefore.desk - desk.top,
    marginPhone: gapBefore.phone - phone.top,
    heightDesk: desk.bottom + gapAfter.desk,
    heightPhone: phone.bottom + gapAfter.phone
  }
}
