import type { NoteKind } from '../data/types'

// One small stroke icon set shared by every concept (colour = currentColor).

type P = { size?: number; className?: string }

const S = ({ size = 16, className, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {children}
  </svg>
)

export const Icon = {
  bell: (p: P) => (
    <S {...p}>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </S>
  ),
  gear: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </S>
  ),
  close: (p: P) => (
    <S {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </S>
  ),
  external: (p: P) => (
    <S {...p}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </S>
  ),
  desktop: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </S>
  ),
  mobile: (p: P) => (
    <S {...p}>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </S>
  ),
  expand: (p: P) => (
    <S {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </S>
  ),
  refresh: (p: P) => (
    <S {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </S>
  ),
  github: (p: P) => (
    <S {...p}>
      <path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.9-2.3c3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.5 0C6 1.4 4.9 1.7 4.9 1.7a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.4 8.7c0 5 3 6.2 6 6.5a3 3 0 0 0-.9 2.3V21" />
    </S>
  ),
  claude: (p: P) => (
    <S {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </S>
  ),
  branch: (p: P) => (
    <S {...p}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-8 3-11.5 8" />
    </S>
  ),
  page: (p: P) => (
    <S {...p}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </S>
  ),
  pulse: (p: P) => (
    <S {...p}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </S>
  ),
  search: (p: P) => (
    <S {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </S>
  ),
  terminal: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </S>
  ),
  layers: (p: P) => (
    <S {...p}>
      <path d="M12 3 2 8l10 5 10-5z" />
      <path d="M2 13l10 5 10-5" />
    </S>
  ),
  bag: (p: P) => (
    <S {...p}>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </S>
  ),
  paperclip: (p: P) => (
    <S {...p}>
      <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7" />
    </S>
  ),
  file: (p: P) => (
    <S {...p}>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </S>
  ),
  folder: (p: P) => (
    <S {...p}>
      <path d="M3 6h6l2 2h10v11H3z" />
    </S>
  ),
  download: (p: P) => (
    <S {...p}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </S>
  ),
  copy: (p: P) => (
    <S {...p}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </S>
  ),
  bolt: (p: P) => (
    <S {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </S>
  ),
  speed: (p: P) => (
    <S {...p}>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-6" />
    </S>
  ),
}

/** Icon for each notification kind. */
export function KindIcon({ kind, size = 16 }: { kind: NoteKind; size?: number }) {
  const p = { size }
  switch (kind) {
    case 'build':
      return (
        <S {...p}>
          <path d="M14.5 4.5l5 5-2 2-5-5zM12.5 6.5 4 15l5 5 8.5-8.5" />
        </S>
      )
    case 'build-ok':
    case 'up':
      return (
        <S {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5l2.7 2.7L16.5 9" />
        </S>
      )
    case 'build-fail':
    case 'deploy-fail':
      return (
        <S {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </S>
      )
    case 'deploying':
    case 'deployed':
      return (
        <S {...p}>
          <path d="M12 15c-2-1-3-3-3-3s1-6 6-9c0 0 2 4-1 9 0 0-1 2-2 3z" />
          <path d="M9 12l-3 1-2 4 4-1M12 15l-1 3-4 2 1-4" />
          <circle cx="13.5" cy="8" r="1.2" />
        </S>
      )
    case 'issue':
      return (
        <S {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5v.01" />
        </S>
      )
    case 'pr':
    case 'merged':
      return (
        <S {...p}>
          <circle cx="6" cy="5" r="2" />
          <circle cx="6" cy="19" r="2" />
          <circle cx="18" cy="19" r="2" />
          <path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-3M14 3.5 11.5 6 14 8.5" />
        </S>
      )
    case 'review':
      return (
        <S {...p}>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
          <circle cx="12" cy="12" r="2.5" />
        </S>
      )
    case 'push':
      return (
        <S {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M3 12h6M15 12h6" />
        </S>
      )
    case 'claude':
      return Icon.claude(p)
    case 'down':
      return (
        <S {...p}>
          <path d="M12 3 2 20h20z" />
          <path d="M12 10v4M12 17v.01" />
        </S>
      )
    case 'perf':
      return Icon.speed(p)
    case 'order':
      return Icon.bag(p)
    case 'stock':
      return (
        <S {...p}>
          <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
          <path d="M12 12v4M12 8.5v.01" />
        </S>
      )
  }
}
