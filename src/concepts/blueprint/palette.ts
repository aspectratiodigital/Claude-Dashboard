import { useApp, type Theme } from '../../store'

// Colours for the 3D plan in each theme. The page's own colours are CSS
// variables in blueprint.css; these are the WebGL side of the same themes.

export interface Palette {
  paper: string
  line: string
  mark: string
  alert: string
  go: string
  fill: string
  fillAlert: string
  hut: string
  /** the crane over a running build: yellow in every theme */
  crane: string
  /** the drone over a building Claude is working on: purple in every theme */
  drone: string
  /** grid lines on the ground, as 0..1 RGB */
  grid: [number, number, number]
  /** how strongly the grid shows */
  gridAlpha: number
}

export const PALETTES: Record<Theme, Palette> = {
  blueprint: { paper: '#164a86', line: '#dce9ff', mark: '#ffd23f', alert: '#ff6b6b', go: '#7dffb0', fill: '#2a6bb8', fillAlert: '#7a2f52', hut: '#1d5ea6', crane: '#ffd23f', drone: '#c79bff', grid: [0.86, 0.91, 1], gridAlpha: 1 },
  light: { paper: '#f3f1ec', line: '#55524d', mark: '#1b1a18', alert: '#c4473b', go: '#2e8a58', fill: '#e2ded6', fillAlert: '#f0cfc9', hut: '#d6d1c7', crane: '#e0a800', drone: '#7c4dff', grid: [0.2, 0.19, 0.18], gridAlpha: 0.7 },
  dark: { paper: '#171716', line: '#b9b6b0', mark: '#f2f0eb', alert: '#ff7b6e', go: '#84d8a6', fill: '#2a2a28', fillAlert: '#4c2724', hut: '#33332f', crane: '#ffd23f', drone: '#b48cff', grid: [0.92, 0.91, 0.88], gridAlpha: 0.7 },
  // Mini draws its own city (concepts/mini); this is for the page around it
  mini: { paper: '#efe9de', line: '#4a463f', mark: '#2b2925', alert: '#e8574a', go: '#4fae69', fill: '#e6dfd2', fillAlert: '#f2cdc6', hut: '#dcd4c6', crane: '#f2bd3d', drone: '#8f63d6', grid: [0.3, 0.28, 0.25], gridAlpha: 0.5 },
}

export const usePalette = () => PALETTES[useApp((s) => s.theme)]
