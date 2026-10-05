/** The ad the auction served for the running turn. */
export type ServedAd = {
  impressionId: string
  creativeId: string
  format: 'video' | 'text'
  advertiser: string
  headline: string
  body: string
  /** What the spinner says while the ad runs (`Shipping faster with Acme`). */
  spinnerText: string
  ctaLabel: string
  /** The tracked click-through URL on the ad server. */
  clickUrl: string
  /** The terminal frame pack, for video creatives. */
  framesUrl: string | null
  /** Sharp PNG frames for terminals that draw images (Ghostty, kitty, iTerm2, WezTerm); may 404. */
  hdUrl?: string | null
  durationMs: number
  /** What a completed view credits the viewer, in micro-dollars. */
  viewerMicros: number
  /** Poster color shown until frames arrive, 0xRRGGBB. */
  posterColor: number
  /** Sidecar's own ad, shown when no paid ad won: it pays nobody. Absent from older servers. */
  isHouse?: boolean
}

/** Where the viewer's earnings stand. */
export type Wallet = {
  todayMicros: number
  pendingMicros: number
  lifetimeMicros: number
  isClaimed: boolean
  claimUrl: string
}

/**
 * Where the current ad stands: playing while Claude works, `grace` for a few
 * seconds after Claude stops mid-ad, `paused` until the next turn resumes it.
 */
export type Phase = 'idle' | 'playing' | 'grace' | 'paused'

/** The last turn's ad, once played. */
export type LastView = {
  advertiser: string
  creditedMicros: number
  isCredited: boolean
  isHouse?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sidecar: {
      ad: ServedAd | null
      wallet: Wallet | null
      lastView: LastView | null
      isPaused: boolean
      /** Milliseconds of the current ad played so far. */
      playedMs: number
      phase: Phase
      /** A line saying why no ad shows (offline, not linked), or null. */
      notice: string | null
      /**
       * True once the person has gone a while without typing, submitting or
       * pressing anything: the ad freezes, nothing counts, no new ad is asked for.
       */
      isAway: boolean
    }
  }
}
