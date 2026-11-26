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
  tablet: (p: P) => (
    <S {...p}>
      <rect x="5" y="2.5" width="14" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </S>
  ),
  pointer: (p: P) => (
    <S {...p}>
      <path d="M5 3l14 7-6 2-2 6z" />
    </S>
  ),
  hand: (p: P) => (
    <S {...p}>
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.7-2.3L3.6 14.9a1.5 1.5 0 0 1 2.3-1.9L8 15" />
    </S>
  ),
  rotate: (p: P) => (
    <S {...p}>
      <rect x="4" y="8" width="16" height="10" rx="1.5" />
      <path d="M9 4h6l-2-2M15 4l-2 2" />
    </S>
  ),
  columns: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M12 4v16" />
    </S>
  ),
  studio: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M9 9v11" />
      <path d="m13.5 13 4 1.6-1.7.6-.6 1.7z" />
    </S>
  ),
  magnet: (p: P) => (
    <S {...p}>
      <path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" />
      <path d="M6 8h4M14 8h4" />
    </S>
  ),
  undo: (p: P) => (
    <S {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </S>
  ),
  redo: (p: P) => (
    <S {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </S>
  ),
  image: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </S>
  ),
  link: (p: P) => (
    <S {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </S>
  ),
  text: (p: P) => (
    <S {...p}>
      <path d="M5 6V4h14v2M12 4v16M9 20h6" />
    </S>
  ),
  eyeOff: (p: P) => (
    <S {...p}>
      <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.6 6.6C4.3 8.2 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </S>
  ),
  trash: (p: P) => (
    <S {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </S>
  ),
  arrowUp: (p: P) => (
    <S {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </S>
  ),
  arrowDown: (p: P) => (
    <S {...p}>
      <path d="M12 5v14M6 13l6 6 6-6" />
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
  lock: (p: P) => (
    <S {...p}>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </S>
  ),
  unlock: (p: P) => (
    <S {...p}>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </S>
  ),
  crop: (p: P) => (
    <S {...p}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </S>
  ),
  sliders: (p: P) => (
    <S {...p}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </S>
  ),
  grid: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </S>
  ),
  ruler: (p: P) => (
    <S {...p}>
      <path d="M3 17 17 3l4 4L7 21z" />
      <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
    </S>
  ),
  qr: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v.01M14 21h3M21 18v3h-1" />
    </S>
  ),
  camera: (p: P) => (
    <S {...p}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </S>
  ),
  clock: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </S>
  ),
  history: (p: P) => (
    <S {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </S>
  ),
  rocket: (p: P) => (
    <S {...p}>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M9 18l-3-3c1-4 4-9 12-11-2 8-7 11-11 12z" />
      <circle cx="15" cy="9" r="1.5" />
    </S>
  ),
  calendar: (p: P) => (
    <S {...p}>
      <rect x="3" y="5" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </S>
  ),
  check: (p: P) => (
    <S {...p}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </S>
  ),
  palette: (p: P) => (
    <S {...p}>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10.5" cy="7" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </S>
  ),
  type: (p: P) => (
    <S {...p}>
      <path d="M5 6V4h14v2M12 4v16M9 20h6" />
    </S>
  ),
  alignLeft: (p: P) => (
    <S {...p}>
      <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />
    </S>
  ),
  alignCenter: (p: P) => (
    <S {...p}>
      <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />
    </S>
  ),
  alignRight: (p: P) => (
    <S {...p}>
      <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />
    </S>
  ),
  video: (p: P) => (
    <S {...p}>
      <rect x="3" y="6" width="13" height="12" rx="1.5" />
      <path d="M16 10l5-3v10l-5-3z" />
    </S>
  ),
  plus: (p: P) => (
    <S {...p}>
      <path d="M12 5v14M5 12h14" />
    </S>
  ),
  minus: (p: P) => (
    <S {...p}>
      <path d="M5 12h14" />
    </S>
  ),
  sidebar: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M15 4v16" />
    </S>
  ),
  chevron: (p: P) => (
    <S {...p}>
      <path d="M6 9l6 6 6-6" />
    </S>
  ),
  more: (p: P) => (
    <S {...p}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </S>
  ),
  wand: (p: P) => (
    <S {...p}>
      <path d="M4 20 15 9M14 4v2M19 9h2M17.5 5.5 19 4M18 12l1.5 1.5M10 5.5 8.5 4" />
    </S>
  ),
  globe: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </S>
  ),
  eye: (p: P) => (
    <S {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </S>
  ),
  table: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M3 15h18M9 10v10M15 10v10" />
    </S>
  ),
  list: (p: P) => (
    <S {...p}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </S>
  ),
  bold: (p: P) => (
    <S {...p}>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </S>
  ),
  map: (p: P) => (
    <S {...p}>
      <path d="M12 21s-7-6.3-7-11.5a7 7 0 0 1 14 0C19 14.7 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </S>
  ),
  overview: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </S>
  ),
  paste: (p: P) => (
    <S {...p}>
      <rect x="6" y="4" width="12" height="17" rx="1.5" />
      <path d="M9 4V3h6v1M9 11h6M9 15h4" />
    </S>
  ),
  alert: (p: P) => (
    <S {...p}>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17v.01" />
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
