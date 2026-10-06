import { describe, it, expect } from 'vitest'

/**
 * P5-61 harvesting. Pure: HTML in, candidates out, no network at all.
 *
 * What is asserted here is the generous half of the ticket — everything that
 * MIGHT be data is collected — plus the three rules that are about safety
 * rather than recall: https only, resolved against the final address, and
 * deduplicated. The judgement (which of these to keep) is `linkPrune`'s, and
 * is tested there.
 */

const { harvestLinks, contextAround, registrableDomain, sameSite, HARVEST_MAX, CONTEXT_MAX, DOCUMENTS_MAX } =
  await import('./linkHarvest.js')
const { AGENCY_PROSE_PAGE, JSONLD_DATASET_PAGE, ALTERNATE_PAGE } = await import('../testutils/fixtures/inspect/index.js')

const base = new URL('https://epd.example.gov/programs/wells/index.html')
const urls = (html: string, at: URL = base) => harvestLinks(html, at).candidates.map(c => c.url)

describe('harvestLinks', () => {
  it('finds the one CSV among forty navigation links, and keeps its sentence', () => {
    const { candidates, total } = harvestLinks(AGENCY_PROSE_PAGE, base)
    const csv = candidates.find(c => c.url.endsWith('well-testing-results-2024.csv'))

    expect(csv).toBeDefined()
    expect(csv!.url).toBe('https://epd.example.gov/files/well-testing-results-2024.csv')
    expect(csv!.kind).toBe('file')
    expect(csv!.via).toBe('anchor')
    expect(csv!.label).toContain('county-level CSV file')
    // The sentence around it is what tells a model this is THE results file.
    expect(csv!.context).toMatch(/full set of results|one row per sampled well/i)
    expect(csv!.context!.length).toBeLessThanOrEqual(CONTEXT_MAX)

    // The forty nav links are not candidates: neither their URLs nor their
    // words look like data. Harvesting is generous, not indiscriminate.
    expect(total).toBeLessThan(10)
    expect(candidates.some(c => c.url.endsWith('/careers'))).toBe(false)
    expect(candidates.some(c => c.url.endsWith('/foia'))).toBe(false)
  })

  it('keeps an anchor whose URL says nothing but whose words say "API"', () => {
    const { candidates } = harvestLinks(AGENCY_PROSE_PAGE, base)
    const docs = candidates.find(c => c.url.endsWith('/developers/wells'))
    expect(docs).toBeDefined()
    // Nothing in "/developers/wells" is a data shape — the LINK TEXT is why
    // it is here, and the model is told which of the two it was.
    expect(docs!.via).toBe('anchor-text')
    expect(docs!.kind).toBeUndefined()
  })

  it('reads schema.org Dataset distributions, with their formats', () => {
    const { candidates } = harvestLinks(JSONLD_DATASET_PAGE, new URL('https://fws.example.gov/wetlands'))
    const found = candidates.filter(c => c.via === 'json-ld')
    expect(found.map(c => c.url)).toEqual([
      'https://data.example.gov/downloads/wetlands.geojson',
      'https://data.example.gov/downloads/wetlands.zip',
    ])
    expect(found[0].label).toBe('Wetlands (GeoJSON)')
    expect(found[0].context).toContain('application/geo+json')
    expect(found[1].kind).toBe('file')
  })

  it('reads <link rel="alternate"> to a data type, and ignores an RSS feed', () => {
    const { candidates } = harvestLinks(ALTERNATE_PAGE, base)
    const alternate = candidates.filter(c => c.via === 'alternate')
    expect(alternate).toHaveLength(1)
    expect(alternate[0].url).toBe('https://epd.example.gov/api/parcels.geojson')
    expect(alternate[0].label).toBe('Parcels as GeoJSON')
  })

  it('resolves a relative URL against the page we ended up at', () => {
    // "../data/parcels.csv" from /programs/wells/index.html is /programs/data/.
    expect(urls(ALTERNATE_PAGE)).toContain('https://epd.example.gov/programs/data/parcels.csv')
    // And follows a redirect: the same page served from somewhere else means
    // the same relative link points somewhere else.
    expect(urls(ALTERNATE_PAGE, new URL('https://gis.example.gov/a/b/page'))).toContain(
      'https://gis.example.gov/a/data/parcels.csv',
    )
  })

  it('drops an http link rather than upgrading it', () => {
    // An agency serving data over plain http is a fact somebody should see,
    // not one we should quietly paper over by rewriting the scheme.
    expect(urls(ALTERNATE_PAGE).some(u => u.includes('legacy.example.gov'))).toBe(false)
    expect(urls(ALTERNATE_PAGE).some(u => u.startsWith('http://'))).toBe(false)
  })

  it('notes the site DCAT catalogue once, as one candidate', () => {
    const { candidates } = harvestLinks(ALTERNATE_PAGE, base)
    const dcat = candidates.filter(c => c.via === 'dcat')
    expect(dcat).toHaveLength(1)
    expect(dcat[0].url).toBe('https://epd.example.gov/data.json')
  })

  it('drops duplicates and fragments, counting each address once', () => {
    const html = `
      <a href="/x/report.csv#top">Download</a>
      <a href="/x/report.csv">Download the CSV</a>
      <a href="/x/report.csv#bottom">Data</a>`
    const { candidates, total } = harvestLinks(html, base)
    expect(candidates.map(c => c.url)).toEqual(['https://epd.example.gov/x/report.csv'])
    expect(total).toBe(1)
  })

  it('caps what it hands on, but counts everything it found', () => {
    const many = Array.from({ length: HARVEST_MAX + 25 }, (_, i) => `<a href="/f/${i}.csv">Download ${i}</a>`).join('\n')
    const { candidates, total } = harvestLinks(many, base)
    expect(candidates).toHaveLength(HARVEST_MAX)
    // The count is of the PAGE: "N other links were left out" has to be true.
    expect(total).toBe(HARVEST_MAX + 25)
  })

  it('refuses an address that is not a public web address', () => {
    const html = `
      <a href="https://localhost/data.csv">Download</a>
      <a href="https://127.0.0.1/data.csv">Download</a>
      <a href="javascript:void(0)">Download data</a>
      <a href="/real.csv">Download</a>`
    expect(urls(html)).toEqual(['https://epd.example.gov/real.csv'])
  })

  it('finds nothing on a page with nothing on it', () => {
    expect(harvestLinks('<html><body><p>Hello.</p></body></html>', base)).toEqual({
      candidates: [],
      documents: [],
      total: 0,
      insecure: false,
    })
  })
})

describe('contextAround', () => {
  it('prefers the sentence the link sits in over an arbitrary cut', () => {
    const html = 'A first sentence entirely about something else. The results are in <a href="/a">this file</a> for 2024. And then more.'
    const at = html.indexOf('<a')
    const context = contextAround(html, at, '<a href="/a">this file</a>'.length)
    expect(context).toContain('The results are in')
    expect(context).toContain('for 2024')
    expect(context).not.toContain('something else')
  })
})

/**
 * Directories, found live on the Census TIGER page.
 *
 * The only route to the shapefiles there is one anchor reading "FTP Archive"
 * pointing at a protocol-relative folder. Neither its URL nor its words were a
 * data shape, so it was never harvested — and the most important link on the
 * page was invisible to the model that was supposed to pick it.
 */
describe('a folder of data files', () => {
  const censusBase = new URL('https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html')

  it('harvests an "FTP Archive" link and resolves it protocol-relative', async () => {
    const { TIGER_DIRECTORY_PAGE } = await import('../testutils/fixtures/inspect/index.js')
    const { candidates } = harvestLinks(TIGER_DIRECTORY_PAGE, censusBase)
    const ftp = candidates.find(c => c.url.includes('www2.census.gov'))

    expect(ftp).toBeDefined()
    // `//www2.census.gov/...` becomes https, not a relative path on this host.
    expect(ftp!.url).toBe('https://www2.census.gov/geo/tiger/TIGER2025/')
    expect(ftp!.via).toBe('directory')
    expect(ftp!.label).toBe('FTP Archive')
    expect(ftp!.context).toMatch(/Access the files/i)
  })

  it('harvests a "web interface" index too, and leaves the navigation alone', async () => {
    const { TIGER_DIRECTORY_PAGE } = await import('../testutils/fixtures/inspect/index.js')
    const { candidates } = harvestLinks(TIGER_DIRECTORY_PAGE, censusBase)
    expect(candidates.some(c => c.url.endsWith('/cgi-bin/geo/shapefiles/index.php'))).toBe(true)
    expect(candidates.some(c => c.url.endsWith('/about.html'))).toBe(false)
    expect(candidates.some(c => c.url.endsWith('/newsroom.html'))).toBe(false)
  })

  it('reads a data folder off its path when nothing in the words says so', () => {
    const html = '<a href="https://www2.census.gov/geo/tiger/TIGER2025/">2025 files</a>'
    expect(harvestLinks(html, censusBase).candidates[0]).toMatchObject({ via: 'directory' })
  })

  it('does not call every trailing slash a data folder', () => {
    const html = '<a href="/about/">About</a><a href="/newsroom/">Newsroom</a>'
    expect(harvestLinks(html, censusBase).candidates).toEqual([])
  })
})

/**
 * P5-62: the page's own address is not one of its links.
 *
 * Found by the eval: a Socrata page's "Skip to main content" anchor and an
 * EPA page's own entry in its side navigation both resolve to the page being
 * inspected, and the model kept them — reasonably, since nothing in the
 * candidate list said "you are already here".
 */
describe('a page does not link to itself', () => {
  const SELF = `<html><body>
    <a href="/frs/geospatial-data-download-service">Geospatial Data Download Options</a>
    <a href="https://www.epa.gov/frs/geospatial-data-download-service#main">Skip to main content</a>
    <a href="https://ordsext.epa.gov/FLA/www3/national_frs.kmz">National File</a>
  </body></html>`

  it('drops the candidate that is the page we are reading, fragment and all', () => {
    const { candidates, total } = harvestLinks(SELF, new URL('https://www.epa.gov/frs/geospatial-data-download-service'))
    expect(candidates.map(c => c.url)).toEqual(['https://ordsext.epa.gov/FLA/www3/national_frs.kmz'])
    // And it is not counted among "N other links were left out" either: it was
    // never a link off this page to begin with.
    expect(total).toBe(1)
  })
})

/**
 * P5-81: follow the page's own scheme.
 *
 * `http://www.engaginglandowners.org/` was harvested live and produced zero
 * candidates: every relative link on an http page resolves to http, and http
 * was dropped. The rule was written for agencies serving data over plain http;
 * it also erased every link on a site whose certificate merely expired.
 */
describe('an http page', () => {
  const insecureBase = new URL('http://www.engaginglandowners.org/resources/')
  const html = `
    <a href="/files/parcels.csv">Download the parcels CSV</a>
    <a href="http://files.engaginglandowners.org/wells.csv">Download the wells CSV</a>
    <a href="http://other.example.gov/data.csv">Download their CSV</a>
    <a href="https://data.example.gov/theirs.csv">Download the state CSV</a>`

  it('keeps its own site’s http links, over http, unrewritten', () => {
    const found = urls(html, insecureBase)
    expect(found).toContain('http://www.engaginglandowners.org/files/parcels.csv')
    // A sibling host on the same registrable domain is the same site.
    expect(found).toContain('http://files.engaginglandowners.org/wells.csv')
  })

  it('still refuses plain http to anybody else, and keeps https to anybody', () => {
    const found = urls(html, insecureBase)
    expect(found).not.toContain('http://other.example.gov/data.csv')
    expect(found).toContain('https://data.example.gov/theirs.csv')
  })

  it('says the page was insecure, so the entry can say so', () => {
    expect(harvestLinks(html, insecureBase).insecure).toBe(true)
    expect(harvestLinks(html, base).insecure).toBe(false)
  })

  it('changes nothing about an https page: http links are still dropped', () => {
    const found = urls(html, base)
    expect(found.some(u => u.startsWith('http://'))).toBe(false)
    expect(found).toContain('https://data.example.gov/theirs.csv')
  })
})

describe('the site a hostname belongs to', () => {
  it('is the registrable domain, not the last two labels of anything', () => {
    expect(registrableDomain('www.engaginglandowners.org')).toBe('engaginglandowners.org')
    expect(registrableDomain('data.gis.county.ny.us')).toBe('county.ny.us')
    expect(registrableDomain('epa.gov.uk')).toBe('epa.gov.uk')
    expect(registrableDomain('EPD.example.GOV.')).toBe('example.gov')
  })

  it('never makes two agencies under one country code the same site', () => {
    expect(sameSite('a.epa.gov.uk', 'b.epa.gov.uk')).toBe(true)
    expect(sameSite('a.epa.gov.uk', 'b.defra.gov.uk')).toBe(false)
    expect(sameSite('files.epd.example.gov', 'www.example.gov')).toBe(true)
    expect(sameSite('example.gov', 'example.org')).toBe(false)
    expect(sameSite('', 'example.gov')).toBe(false)
  })
})

/**
 * P5-80: the documents on a page, as one list.
 *
 * The data candidates keep a PDF only when its link text says "download", so
 * thirty landowner profiles labelled by content were invisible. This list is
 * by shape alone — same site, a document extension — and the person decides
 * which of them come in.
 */
describe('documents on the page', () => {
  const html = `
    <p>Each landowner wrote up their own place.</p>
    <a href="/profiles/jones-farm.pdf">The Jones farm, 2024</a>
    <a href="/profiles/smith-woodlot.PDF?download=1">Smith woodlot</a>
    <a href="/handbook.docx">Handbook</a>
    <a href="/minutes.rtf">Minutes</a>
    <a href="/budget.xlsx">Budget</a>
    <a href="https://elsewhere.example.org/theirs.pdf">Their report</a>
    <a href="/programs/wells">Wells program</a>
    <a href="/profiles/jones-farm.pdf">The Jones farm again</a>`

  it('lists this site’s documents by shape, whatever the link says', () => {
    const { documents } = harvestLinks(html, base)
    expect(documents.map(d => d.url)).toEqual([
      'https://epd.example.gov/profiles/jones-farm.pdf',
      'https://epd.example.gov/profiles/smith-woodlot.PDF?download=1',
      'https://epd.example.gov/handbook.docx',
      'https://epd.example.gov/minutes.rtf',
      'https://epd.example.gov/budget.xlsx',
    ])
    expect(documents[0].label).toBe('The Jones farm, 2024')
    expect(documents[0].context).toMatch(/wrote up their own place/)
  })

  it('leaves another site’s documents, and this site’s pages, alone', () => {
    const { documents } = harvestLinks(html, base)
    expect(documents.some(d => d.url.includes('elsewhere.example.org'))).toBe(false)
    expect(documents.some(d => d.url.endsWith('/programs/wells'))).toBe(false)
  })

  it('names a document by its file when the anchor says nothing', () => {
    const { documents } = harvestLinks('<a href="/profiles/2024%20Jones%20Farm.pdf"><img src="/i.png"></a>', base)
    expect(documents[0].label).toBe('2024 Jones Farm.pdf')
  })

  it('offers a document that is also a data candidate on both lists', () => {
    const { candidates, documents } = harvestLinks('<a href="/tables/wells.xlsx">Download</a>', base)
    expect(candidates.map(c => c.url)).toEqual(['https://epd.example.gov/tables/wells.xlsx'])
    expect(documents.map(d => d.url)).toEqual(['https://epd.example.gov/tables/wells.xlsx'])
  })

  it('caps the collection, and never lists one document twice', () => {
    const many = Array.from({ length: DOCUMENTS_MAX + 12 }, (_, i) => `<a href="/p/${i}.pdf">Profile ${i}</a>`).join('\n')
    const { documents } = harvestLinks(`${many}\n<a href="/p/0.pdf">Profile 0 again</a>`, base)
    expect(documents).toHaveLength(DOCUMENTS_MAX)
    expect(new Set(documents.map(d => d.url)).size).toBe(DOCUMENTS_MAX)
  })

  it('collects an http page’s own documents too', () => {
    const insecureBase = new URL('http://www.engaginglandowners.org/resources/')
    const { documents } = harvestLinks('<a href="/profiles/jones.pdf">Jones</a>', insecureBase)
    expect(documents.map(d => d.url)).toEqual(['http://www.engaginglandowners.org/profiles/jones.pdf'])
  })
})
