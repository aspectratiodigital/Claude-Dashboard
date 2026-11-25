// Can a page be shown live inside the dashboard? Used by the phone previews on
// an app's floors before they load it, so a blank frame comes with a reason:
// the address doesn't exist yet, nothing is running on localhost, or the page
// refuses to be framed (X-Frame-Options / CSP frame-ancestors).
//
// The desktop app removes those two headers from pages shown inside it
// (electron/main.cjs sets globalThis.blueprintFramesAllowed), so there only
// reachability matters.

export interface FrameCheck {
  /** the page answered */
  ok: boolean
  code: number | null
  /** why the page can't be shown inside the dashboard, when it can't */
  blocked: string | null
  /** why the page couldn't be reached */
  error: string | null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) JarvisDashboard/1.0 Safari/537.36'
const g = globalThis as { blueprintFramesAllowed?: boolean }

/** What a response's headers say about being shown in another site's frame. */
export function frameBlock(xfo: string | null, csp: string | null): string | null {
  if (xfo && /deny|sameorigin/i.test(xfo)) return `It sends X-Frame-Options: ${xfo.trim().toUpperCase()}`
  const fa = csp
    ?.split(/[;,]/)
    .map((d) => d.trim())
    .find((d) => /^frame-ancestors\b/i.test(d))
  if (fa) {
    const sources = fa.split(/\s+/).slice(1)
    // our page is served from localhost; '*' or an explicit localhost source lets it in
    if (!sources.some((s) => s === '*' || /localhost|127\.0\.0\.1/.test(s))) return `Its Content-Security-Policy says ${fa}`
  }
  return null
}

function why(e: unknown): string {
  const code = (e as { cause?: { code?: string } }).cause?.code ?? ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That address doesn’t exist (no DNS record yet)'
  if (code === 'ECONNREFUSED') return 'Nothing is running at that address'
  if ((e as Error).name === 'TimeoutError') return 'It took too long to answer'
  if (/CERT|SSL|TLS/i.test(code)) return 'Its HTTPS certificate isn’t valid'
  return (e as Error).message || 'It couldn’t be reached'
}

export async function checkFrame(url: string): Promise<FrameCheck> {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(10_000) })
    res.body?.cancel().catch(() => {})
    const blocked = g.blueprintFramesAllowed ? null : frameBlock(res.headers.get('x-frame-options'), res.headers.get('content-security-policy'))
    return { ok: res.status < 500, code: res.status, blocked, error: res.status >= 500 ? `It answered ${res.status}` : null }
  } catch (e) {
    return { ok: false, code: null, blocked: null, error: why(e) }
  }
}
