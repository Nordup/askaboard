import type { SpaceApi } from '../shared/space-api'

declare global {
  interface Window {
    readonly space: SpaceApi
  }
}

export {}
