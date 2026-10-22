import { create } from 'zustand'

// Blueprint's own UI state: whether the selected building is opened up
// ("dissected") and which part of it you're looking at.
//
// Part keys: 'roof' (site speed), 'sign' (SEO), 'foundation' (build quality),
// 'floor:N' (a page of the site), 'hut:N' (a Claude thread).

interface BpState {
  dissect: boolean
  part: string | null
  hoverPart: string | null
  setDissect: (on: boolean) => void
  setPart: (part: string | null) => void
  setHoverPart: (part: string | null) => void
}

export const useBp = create<BpState>((set) => ({
  dissect: false,
  part: null,
  hoverPart: null,
  setDissect: (dissect) => set({ dissect, part: dissect ? 'roof' : null, hoverPart: null }),
  setPart: (part) => set({ part }),
  setHoverPart: (hoverPart) => set({ hoverPart }),
}))

export const PART_NAME: Record<string, string> = {
  roof: 'Roof: site speed',
  sign: 'Sign: SEO',
  foundation: 'Foundation: build quality',
}
