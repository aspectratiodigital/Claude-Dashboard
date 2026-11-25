import type { SeoReport } from './types'

// Studio's SEO checks: what a page's search and share details look like, as a
// green tick (sorted), an orange line (could be better) or a red cross (needs
// sorting). Thresholds follow what Google and the social networks show: titles
// are cut at about 60 characters, descriptions at about 155.

export type SeoLevel = 'good' | 'improve' | 'fix'

export interface SeoCheck {
  id: string
  level: SeoLevel
  /** what's being checked, e.g. "Title" */
  label: string
  /** what Studio found, in plain words */
  detail: string
  /** how it gets sorted: a field in the SEO tab, the alt-text list, or Claude */
  fix?: 'title' | 'description' | 'share' | 'alt' | 'claude'
  /** what to ask Claude, when Claude is the fix */
  ask?: string
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

export function seoChecks(r: SeoReport, others: SeoReport[] = []): SeoCheck[] {
  const out: SeoCheck[] = []
  const add = (c: SeoCheck) => out.push(c)
  const title = r.title.trim()
  const desc = (r.description ?? '').trim()

  if (r.status >= 400) add({ id: 'status', level: 'fix', label: 'Page answers', detail: `This address answers with error ${r.status}, so Google drops it. Check the links that lead here.` })

  // title
  if (!title) add({ id: 'title', level: 'fix', label: 'Title', detail: 'No title. Google shows this as the blue headline, so every page needs one.', fix: 'title' })
  else if (title.length < 30) add({ id: 'title', level: 'improve', label: 'Title', detail: `Short at ${title.length} characters. Aim for 30 to 60, with what the page is about and the business name.`, fix: 'title' })
  else if (title.length > 60) add({ id: 'title', level: 'improve', label: 'Title', detail: `Long at ${title.length} characters: Google cuts it off at about 60.`, fix: 'title' })
  else add({ id: 'title', level: 'good', label: 'Title', detail: `${title.length} characters, a good length.` })
  const sameTitle = title && others.filter((o) => o.path !== r.path && o.title.trim() === title).map((o) => o.path)
  if (sameTitle && sameTitle.length) add({ id: 'title-dupe', level: 'improve', label: 'Unique title', detail: `Same title as ${sameTitle.slice(0, 3).join(', ')}${sameTitle.length > 3 ? '…' : ''}. Each page should have its own.`, fix: 'title' })

  // description
  if (!desc) add({ id: 'desc', level: 'fix', label: 'Description', detail: 'No meta description, so Google makes one up from the page text. Write one or two sentences that make people click.', fix: 'description' })
  else if (desc.length < 70) add({ id: 'desc', level: 'improve', label: 'Description', detail: `Short at ${desc.length} characters. Aim for 70 to 155.`, fix: 'description' })
  else if (desc.length > 160) add({ id: 'desc', level: 'improve', label: 'Description', detail: `Long at ${desc.length} characters: Google cuts it off at about 155.`, fix: 'description' })
  else add({ id: 'desc', level: 'good', label: 'Description', detail: `${desc.length} characters, a good length.` })
  const sameDesc = desc && others.filter((o) => o.path !== r.path && (o.description ?? '').trim() === desc).map((o) => o.path)
  if (sameDesc && sameDesc.length) add({ id: 'desc-dupe', level: 'improve', label: 'Unique description', detail: `Same description as ${sameDesc.slice(0, 3).join(', ')}${sameDesc.length > 3 ? '…' : ''}.`, fix: 'description' })

  // headings
  const h1 = r.headings.filter((h) => h.level === 1)
  if (!h1.length) add({ id: 'h1', level: 'fix', label: 'Main heading', detail: 'No H1 heading. Each page needs one main heading saying what it’s about.', fix: 'claude', ask: 'This page has no H1. Make its main heading an H1 (keeping how it looks), or add one that fits the design.' })
  else if (h1.length > 1) add({ id: 'h1', level: 'improve', label: 'Main heading', detail: `${n(h1.length, 'H1 heading')}: “${h1.map((h) => h.text.slice(0, 30)).join('”, “')}”. One is clearer for Google.`, fix: 'claude', ask: `This page has ${h1.length} H1 headings. Keep the main one as the H1 and make the others H2s, without changing how they look.` })
  else add({ id: 'h1', level: 'good', label: 'Main heading', detail: `“${h1[0].text.slice(0, 70)}”` })
  let skip: string | null = null
  for (let i = 1; i < r.headings.length; i++) {
    const a = r.headings[i - 1].level
    const b = r.headings[i].level
    if (b > a + 1) {
      skip = `H${a} to H${b} at “${r.headings[i].text.slice(0, 40)}”`
      break
    }
  }
  if (skip) add({ id: 'order', level: 'improve', label: 'Heading order', detail: `Skips a level (${skip}). Screen readers and Google read headings as an outline.`, fix: 'claude', ask: `The headings on this page skip a level (${skip}). Fix the heading levels so they go in order, without changing how anything looks.` })
  else if (r.headings.length > 1) add({ id: 'order', level: 'good', label: 'Heading order', detail: `${n(r.headings.length, 'heading')} in order.` })

  // images
  const miss = r.images.missingAlt.length
  if (miss) add({ id: 'alt', level: 'fix', label: 'Image alt text', detail: `${n(miss, 'image')} with no alt text. Google and screen readers can’t tell what ${miss === 1 ? 'it shows' : 'they show'}.`, fix: 'alt' })
  else if (r.images.total) add({ id: 'alt', level: 'good', label: 'Image alt text', detail: `All ${n(r.images.total, 'image')} have alt text.` })
  if (r.images.large.length)
    add({ id: 'weight', level: 'improve', label: 'Image sizes', detail: `${n(r.images.large.length, 'image')} over 300 KB (largest ${Math.max(...r.images.large.map((i) => i.kb))} KB), which slows the page down. Smaller WebP or AVIF files would load faster.`, fix: 'claude', ask: `These images on this page are over 300 KB: ${r.images.large.map((i) => i.src.split('/').pop()).join(', ')}. Point the page at smaller versions if the repo already has them (e.g. WebP or AVIF); otherwise say which ones need re-exporting.` })

  // share
  const share = r.og.image
  if (!share) add({ id: 'share', level: 'improve', label: 'Share image', detail: 'No share image, so links on WhatsApp, Facebook or LinkedIn show no picture (or a random one).', fix: 'share' })
  else add({ id: 'share', level: 'good', label: 'Share image', detail: 'Set, so shared links show a picture.' })
  if (!r.og.title || !r.og.description) add({ id: 'og', level: 'improve', label: 'Share title and text', detail: `No ${[!r.og.title && 'og:title', !r.og.description && 'og:description'].filter(Boolean).join(' or ')}: shared links fall back to the page title and whatever text the app finds.`, fix: 'claude', ask: 'Add Open Graph and Twitter card tags (og:title, og:description, og:image, og:url, twitter:card) to this page, matching its title and meta description, the way the site’s other pages do or in its shared head template.' })

  // indexing
  if (r.robots && /noindex/i.test(r.robots)) add({ id: 'index', level: 'improve', label: 'Shown on Google', detail: 'Hidden from Google (noindex). Fine if that’s on purpose, like a draft page.' })
  else add({ id: 'index', level: 'good', label: 'Shown on Google', detail: 'Google is allowed to list this page.' })
  if (!r.canonical) add({ id: 'canonical', level: 'improve', label: 'Canonical address', detail: 'No canonical link, so Google may count the same page under more than one address (with and without www or a trailing slash).', fix: 'claude', ask: 'Add a canonical link to this page (and its siblings through the shared head template if there is one), using the live site address.' })
  else add({ id: 'canonical', level: 'good', label: 'Canonical address', detail: r.canonical })

  // basics
  if (!r.viewport) add({ id: 'viewport', level: 'fix', label: 'Mobile friendly', detail: 'No viewport tag, so phones show the desktop layout shrunk down.', fix: 'claude', ask: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to this page’s head.' })
  if (!r.lang) add({ id: 'lang', level: 'improve', label: 'Language', detail: 'The page doesn’t say what language it’s in (<html lang>).', fix: 'claude', ask: 'Set lang="en-GB" on this page’s <html> element (in the shared layout if there is one).' })
  if (!r.favicon) add({ id: 'favicon', level: 'improve', label: 'Favicon', detail: 'No favicon, so the browser tab and Google results show a blank icon.', fix: 'claude', ask: 'Add a favicon link to this page’s head, using the site’s logo files if there are any.' })
  if (r.words < 150 && r.status < 400) add({ id: 'words', level: 'improve', label: 'Amount of text', detail: `${n(r.words, 'word')}. Pages with very little text are hard for Google to rank.` })
  else if (r.status < 400) add({ id: 'words', level: 'good', label: 'Amount of text', detail: `${r.words} words.` })
  if (r.schema.length) add({ id: 'schema', level: 'good', label: 'Structured data', detail: r.schema.join(', ') })
  else add({ id: 'schema', level: 'improve', label: 'Structured data', detail: 'No structured data. A LocalBusiness or Organization block helps Google show opening hours, address and reviews.', fix: 'claude', ask: 'Add a schema.org JSON-LD block that fits this business (e.g. LocalBusiness or Organization: name, address, phone, URL, logo, opening hours where the site states them) to the site’s shared head, using only facts already on the site.' })

  // links
  if (r.links.broken.length) add({ id: 'links', level: 'fix', label: 'Broken links', detail: `${n(r.links.broken.length, 'link')} on this page go nowhere: ${r.links.broken.slice(0, 4).map((b) => `${b.href} (${b.status})`).join(', ')}.`, fix: 'claude', ask: `These links on this page are broken: ${r.links.broken.map((b) => b.href).join(', ')}. Point each at the right page on the site, or remove it if there isn’t one.` })
  else if (r.links.internal) add({ id: 'links', level: 'good', label: 'Links', detail: `All ${n(r.links.internal, 'link')} to other pages work.` })

  // site
  if (!r.site.sitemap) add({ id: 'sitemap', level: 'improve', label: 'Sitemap', detail: 'The site has no sitemap.xml, which helps Google find every page.', fix: 'claude', ask: 'Add a sitemap.xml listing every page of the live site (for Astro, the @astrojs/sitemap integration; otherwise a static file kept up to date by the build if there is one).' })
  if (!r.site.robots) add({ id: 'robots', level: 'improve', label: 'robots.txt', detail: 'No robots.txt. Not essential, but it’s where Google looks for the sitemap.', fix: 'claude', ask: 'Add a robots.txt that allows everything and points at the sitemap on the live address.' })

  const order: Record<SeoLevel, number> = { fix: 0, improve: 1, good: 2 }
  return out.sort((a, b) => order[a.level] - order[b.level])
}

export function seoScore(checks: SeoCheck[]) {
  return {
    good: checks.filter((c) => c.level === 'good').length,
    improve: checks.filter((c) => c.level === 'improve').length,
    fix: checks.filter((c) => c.level === 'fix').length,
  }
}

/** The address Google would show, from the live URL when there is one. */
export function displayUrl(liveUrl: string | null, path: string) {
  try {
    const base = new URL(liveUrl || 'https://example.com')
    const parts = [base.host.replace(/^www\./, ''), ...path.split('/').filter(Boolean)]
    return parts.join(' › ')
  } catch {
    return path
  }
}
