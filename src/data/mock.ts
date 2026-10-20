// Placeholder data for the shell. Every concept reads from here, so swapping in
// real GitHub / deploy / Claude data later only touches this layer.

export type SiteStatus = 'live' | 'building' | 'attention'

export interface Commit {
  sha: string
  message: string
  author: string
  ago: string
}

export interface Site {
  id: string
  name: string
  client: string
  domain: string
  repo: string
  branch: string
  framework: string
  status: SiteStatus
  port: number
  /** brand colours used by the mock preview and 3D nodes */
  brand: { bg: string; fg: string; accent: string }
  visitors7d: number
  uptime: number
  lighthouse: number
  openPRs: number
  branches: number
  commitsThisWeek: number
  /** 14 days of visitor counts, oldest first */
  traffic: number[]
  commits: Commit[]
  tagline: string
}

function series(seed: number, base: number, swing: number): number[] {
  const out: number[] = []
  let s = seed
  for (let i = 0; i < 14; i++) {
    s = (s * 9301 + 49297) % 233280
    const r = s / 233280
    out.push(Math.round(base + Math.sin(i / 2 + seed) * swing * 0.5 + r * swing))
  }
  return out
}

export const SITES: Site[] = [
  {
    id: 'ard',
    name: 'Aspect Ratio Digital',
    client: 'In-house',
    domain: 'aspectratio.digital',
    repo: 'aspectratiodigital/ard-site',
    branch: 'main',
    framework: 'Next.js',
    status: 'live',
    port: 3000,
    brand: { bg: '#0d0d12', fg: '#f2f2f7', accent: '#7c5cff' },
    visitors7d: 4820,
    uptime: 99.99,
    lighthouse: 98,
    openPRs: 2,
    branches: 4,
    commitsThisWeek: 17,
    traffic: series(3, 560, 260),
    tagline: 'Websites framed for growth',
    commits: [
      { sha: 'a41f9c2', message: 'Case study grid: lazy-load hero video', author: 'dylan', ago: '2h' },
      { sha: '9be03d1', message: 'Tighten nav spacing on tablet', author: 'dylan', ago: '1d' },
      { sha: '33c7a10', message: 'Add Kiln Coffee to portfolio', author: 'claude', ago: '2d' },
    ],
  },
  {
    id: 'kiln',
    name: 'Kiln Coffee Roasters',
    client: 'Kiln Coffee Co.',
    domain: 'kilncoffee.co.uk',
    repo: 'aspectratiodigital/kiln-coffee',
    branch: 'feature/subscriptions',
    framework: 'Shopify Hydrogen',
    status: 'building',
    port: 3001,
    brand: { bg: '#2b1a12', fg: '#f6e7d6', accent: '#e0873f' },
    visitors7d: 12940,
    uptime: 99.95,
    lighthouse: 91,
    openPRs: 3,
    branches: 6,
    commitsThisWeek: 24,
    traffic: series(7, 1600, 700),
    tagline: 'Small-batch, roasted Tuesday',
    commits: [
      { sha: 'f00d1e5', message: 'Subscription picker: monthly / fortnightly', author: 'claude', ago: '18m' },
      { sha: '2ad9b77', message: 'Fix cart drawer focus trap', author: 'dylan', ago: '5h' },
      { sha: '7c1e0f4', message: 'Origin pages pull from metafields', author: 'dylan', ago: '1d' },
    ],
  },
  {
    id: 'northfield',
    name: 'Northfield Dental',
    client: 'Northfield Dental Practice',
    domain: 'northfielddental.com',
    repo: 'aspectratiodigital/northfield-dental',
    branch: 'main',
    framework: 'Astro',
    status: 'live',
    port: 4321,
    brand: { bg: '#f3f8fb', fg: '#0f2a3a', accent: '#1aa6b7' },
    visitors7d: 2310,
    uptime: 100,
    lighthouse: 100,
    openPRs: 0,
    branches: 1,
    commitsThisWeek: 3,
    traffic: series(11, 300, 120),
    tagline: 'Gentle care, Saturday appointments',
    commits: [
      { sha: 'be11e09', message: 'Update holiday opening hours', author: 'dylan', ago: '3d' },
      { sha: '0a4c2f8', message: 'Booking widget: add hygienist type', author: 'claude', ago: '6d' },
    ],
  },
  {
    id: 'volt',
    name: 'Volt Gyms',
    client: 'Volt Fitness Ltd',
    domain: 'voltgyms.fit',
    repo: 'aspectratiodigital/volt-gyms',
    branch: 'fix/timetable-tz',
    framework: 'Next.js',
    status: 'attention',
    port: 3002,
    brand: { bg: '#0b0b0b', fg: '#ffffff', accent: '#d4ff3a' },
    visitors7d: 8650,
    uptime: 98.71,
    lighthouse: 84,
    openPRs: 4,
    branches: 7,
    commitsThisWeek: 31,
    traffic: series(5, 1100, 600),
    tagline: 'Open 24/7. No excuses.',
    commits: [
      { sha: 'dead0b1', message: 'Timetable renders in UTC on Safari', author: 'dylan', ago: '40m' },
      { sha: 'c0ffee2', message: 'Class booking API retries', author: 'claude', ago: '3h' },
      { sha: '5ca1ab1', message: 'New Leeds location page', author: 'dylan', ago: '1d' },
    ],
  },
  {
    id: 'marlow',
    name: 'Marlow Estates',
    client: 'Marlow & Finch',
    domain: 'marlowestates.co.uk',
    repo: 'aspectratiodigital/marlow-estates',
    branch: 'main',
    framework: 'Remix',
    status: 'live',
    port: 3003,
    brand: { bg: '#f4f1ec', fg: '#1d2b22', accent: '#3d6b4f' },
    visitors7d: 6120,
    uptime: 99.97,
    lighthouse: 95,
    openPRs: 1,
    branches: 3,
    commitsThisWeek: 9,
    traffic: series(13, 820, 300),
    tagline: 'Homes along the Thames',
    commits: [
      { sha: '1e57a7e', message: 'Listing map clusters at low zoom', author: 'claude', ago: '7h' },
      { sha: '8f3b2c1', message: 'Valuation form copy pass', author: 'dylan', ago: '2d' },
    ],
  },
  {
    id: 'harbour',
    name: 'Harbour Yoga',
    client: 'Harbour Yoga Studio',
    domain: 'harbouryoga.studio',
    repo: 'aspectratiodigital/harbour-yoga',
    branch: 'redesign/2026',
    framework: 'SvelteKit',
    status: 'building',
    port: 5174,
    brand: { bg: '#eaf0ef', fg: '#203735', accent: '#e86f5a' },
    visitors7d: 1480,
    uptime: 99.9,
    lighthouse: 97,
    openPRs: 2,
    branches: 2,
    commitsThisWeek: 14,
    traffic: series(17, 190, 90),
    tagline: 'Breathe by the water',
    commits: [
      { sha: 'aa77bb8', message: 'Redesign: new class cards', author: 'claude', ago: '1h' },
      { sha: '4d4d4d1', message: 'Teacher bios from CMS', author: 'dylan', ago: '1d' },
    ],
  },
  {
    id: 'ferrous',
    name: 'Ferrous Works',
    client: 'Ferrous Fabrication',
    domain: 'ferrousworks.co',
    repo: 'aspectratiodigital/ferrous-works',
    branch: 'main',
    framework: 'WordPress',
    status: 'live',
    port: 8080,
    brand: { bg: '#1c1f22', fg: '#e9e6e1', accent: '#ff5a1f' },
    visitors7d: 980,
    uptime: 99.8,
    lighthouse: 88,
    openPRs: 0,
    branches: 1,
    commitsThisWeek: 1,
    traffic: series(19, 130, 60),
    tagline: 'Structural steel, made in Sheffield',
    commits: [{ sha: '6b6b6b2', message: 'Plugin updates', author: 'dylan', ago: '5d' }],
  },
  {
    id: 'dashboard',
    name: 'Claude Dashboard',
    client: 'In-house',
    domain: 'localhost:5173',
    repo: 'aspectratiodigital/Claude-Dashboard',
    branch: 'claude/project-thread-8px3pt',
    framework: 'Vite + R3F',
    status: 'building',
    port: 5173,
    brand: { bg: '#03070d', fg: '#e8fbff', accent: '#4fe3ff' },
    visitors7d: 1,
    uptime: 100,
    lighthouse: 0,
    openPRs: 1,
    branches: 2,
    commitsThisWeek: 1,
    traffic: series(23, 1, 1),
    tagline: 'This very app',
    commits: [{ sha: '0000001', message: 'Build the 3D shell with four concepts', author: 'claude', ago: 'now' }],
  },
]

export interface Project {
  id: string
  title: string
  siteId: string
  kind: 'Claude Code' | 'Claude Project'
  updated: string
  summary: string
}

export const PROJECTS: Project[] = [
  { id: 'p1', title: 'Kiln subscriptions', siteId: 'kiln', kind: 'Claude Code', updated: '18m ago', summary: 'Building the subscribe-and-save flow on Hydrogen.' },
  { id: 'p2', title: 'Volt timetable bug', siteId: 'volt', kind: 'Claude Code', updated: '40m ago', summary: 'Safari shows class times in UTC.' },
  { id: 'p3', title: 'Harbour redesign brief', siteId: 'harbour', kind: 'Claude Project', updated: '1h ago', summary: 'Moodboard, copy and IA for the 2026 refresh.' },
  { id: 'p4', title: 'ARD case studies', siteId: 'ard', kind: 'Claude Project', updated: '2d ago', summary: 'Writing up Kiln and Marlow as portfolio pieces.' },
  { id: 'p5', title: 'Marlow map clustering', siteId: 'marlow', kind: 'Claude Code', updated: '7h ago', summary: 'Supercluster on the listings map.' },
]

export const totals = {
  visitors7d: SITES.reduce((a, s) => a + s.visitors7d, 0),
  openPRs: SITES.reduce((a, s) => a + s.openPRs, 0),
  live: SITES.filter((s) => s.status === 'live').length,
  building: SITES.filter((s) => s.status === 'building').length,
  attention: SITES.filter((s) => s.status === 'attention').length,
}

export const siteById = (id: string | null) => SITES.find((s) => s.id === id) ?? null

export const STATUS_LABEL: Record<SiteStatus, string> = {
  live: 'Live',
  building: 'Building',
  attention: 'Needs attention',
}
