import { create } from 'zustand'

// Blueprint's own UI state: whether the selected building is opened up
// ("dissected") and which part of it you're looking at.
//
// Part keys: 'roof' (site speed), 'sign' (SEO), 'foundation' (build quality),
// 'floor:N' (a page of the site), 'hut:N' (a Claude thread), 'store' (its Shopify store).

interface BpState {
  dissect: boolean
  /** the callout shows Claude for the selected building instead of its details */
  claude: boolean
  part: string | null
  hoverPart: string | null
  setDissect: (on: boolean) => void
  setClaude: (on: boolean) => void
  setPart: (part: string | null) => void
  setHoverPart: (part: string | null) => void
}

export const useBp = create<BpState>((set) => ({
  dissect: false,
  claude: false,
  part: null,
  hoverPart: null,
  setDissect: (dissect) => set({ dissect, claude: false, part: dissect ? 'roof' : null, hoverPart: null }),
  setClaude: (claude) => set({ claude }),
  setPart: (part) => set({ part }),
  setHoverPart: (hoverPart) => set({ hoverPart }),
}))

export const PART_NAME: Record<string, string> = {
  roof: 'Roof: site speed',
  sign: 'Sign: SEO',
  foundation: 'Foundation: build quality',
  store: 'Shopfront: the Shopify store',
}
