'use client'

import { useEffect, useRef } from 'react'
import { attachInk } from '@/lib/ink'
import { makePieces } from './board/pieces'
import { mountBoard } from './board/stage'

/** The hero board and the visitor's ink: two canvases over the hero, which takes the presses. */
export function Board({ boardClass, inkClass }: { boardClass: string; inkClass: string }) {
  const boardRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const board = boardRef.current
    const ink = inkRef.current
    const host = board?.parentElement
    if (!board || !ink || !host) return
    const stage = mountBoard(host, board, makePieces())
    const detach = attachInk(host, ink, { grab: stage.grab, hover: stage.hover })
    return () => {
      detach()
      stage.stop()
    }
  }, [])
  return (
    <>
      <canvas ref={boardRef} className={boardClass} aria-hidden="true" />
      <canvas ref={inkRef} className={inkClass} aria-hidden="true" />
    </>
  )
}
