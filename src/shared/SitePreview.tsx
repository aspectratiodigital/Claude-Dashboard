import { useState } from 'react'
import type { Site } from '../data/mock'
import { useApp } from '../store'
import './preview.css'

// Desktop / mobile preview of a site. "Mock" draws a stand-in page from the
// site's brand colours; "Localhost" iframes the dev server on its port.

export function SitePreview({ site, className = '' }: { site: Site; className?: string }) {
  const device = useApp((s) => s.device)
  const setDevice = useApp((s) => s.setDevice)
  const [live, setLive] = useState(false)
  const url = `http://localhost:${site.port}`

  return (
    <div className={`pv ${className}`} data-device={device}>
      <div className="pv-bar">
        <div className="pv-seg" role="group" aria-label="Device">
          <button aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>
            Desktop
          </button>
          <button aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}>
            Mobile
          </button>
        </div>
        <div className="pv-seg" role="group" aria-label="Source">
          <button aria-pressed={!live} onClick={() => setLive(false)}>
            Mock
          </button>
          <button aria-pressed={live} onClick={() => setLive(true)}>
            :{site.port}
          </button>
        </div>
      </div>
      <div className="pv-stage">
        <div className="pv-device" key={device}>
          <div className="pv-chrome">
            <i />
            <i />
            <i />
            <span>{live ? url : site.domain}</span>
          </div>
          <div className="pv-screen">
            {live ? <iframe title={`${site.name} on ${url}`} src={url} /> : <MockPage site={site} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function MockPage({ site }: { site: Site }) {
  const { bg, fg, accent } = site.brand
  return (
    <div className="mock" style={{ background: bg, color: fg, ['--ac' as string]: accent, ['--bg' as string]: bg }}>
      <div className="mock-nav">
        <b>{site.name}</b>
        <span>Work</span>
        <span>About</span>
        <span className="mock-cta">Book</span>
      </div>
      <div className="mock-hero">
        <h3>{site.tagline}</h3>
        <p>{site.client}</p>
        <div className="mock-btns">
          <span className="mock-cta">Get started</span>
          <span className="mock-ghost">Learn more</span>
        </div>
      </div>
      <div className="mock-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ opacity: 1 - i * 0.18 }} />
        ))}
      </div>
    </div>
  )
}
