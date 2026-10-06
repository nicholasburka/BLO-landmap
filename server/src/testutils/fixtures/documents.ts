import { deflateRawSync } from 'node:zlib'

/**
 * Real document fixtures, built byte by byte (P5-46 text extraction tests).
 *
 * Built rather than checked in because a binary blob in the repo cannot be
 * reviewed: nobody can see what text a committed .pdf claims to hold, and a
 * fixture whose content is invisible is a fixture nobody trusts. These are
 * genuine files — pdf.js and mammoth parse them exactly as they parse Word's
 * and Acrobat's output — and each is a few hundred bytes.
 */

// --- PDF -----------------------------------------------------------------------

/** Escape the four characters that end a PDF literal string early. */
function pdfString(text: string): string {
  return text.replace(/[\\()]/g, c => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')
}

/**
 * A minimal, valid PDF with one page per string of text. Object offsets are
 * measured as the bytes are appended, so the xref table is real — pdf.js
 * reads the cross-reference table before it reads a single page.
 */
export function makePdf(pageTexts: string[]): Buffer {
  const parts: string[] = []
  const offsets: number[] = []
  let length = 0
  const push = (chunk: string): void => {
    parts.push(chunk)
    length += Buffer.byteLength(chunk, 'latin1')
  }
  const obj = (n: number, body: string): void => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }

  // Object numbering: 1 catalog, 2 page tree, 3 font, then a (page, content)
  // pair per page.
  const pageIds = pageTexts.map((_, i) => 4 + i * 2)
  push('%PDF-1.4\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`)
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i]
    const contentId = pageId + 1
    obj(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    )
    const stream = `BT /F1 18 Tf 72 700 Td (${pdfString(text)}) Tj ET\n`
    obj(contentId, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`)
  })

  const count = 4 + pageTexts.length * 2
  const xrefOffset = length
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n < count; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return Buffer.from(parts.join(''), 'latin1')
}

/** Header bytes and nothing else a parser can use — the "encrypted or damaged
 *  file" path, which must produce an `{ error }` record rather than a throw. */
export const BROKEN_PDF = Buffer.from('%PDF-1.4\nthis file is not really a pdf\n%%EOF\n', 'latin1')

// --- DOCX ----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  body: Buffer
}

/** Minimal ZIP writer (deflate). A .docx IS a zip, so building one here beats
 *  pulling in a zip dependency for the sake of a 700-byte test file. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.body)
    const crc = crc32(entry.body)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date (1980-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(entry.body.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, deflated)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(entry.body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + deflated.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A real .docx: the three parts Word needs to open a document, one `<w:p>`
 *  per paragraph. */
export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map(p => `<w:p><w:r><w:t xml:space="preserve">${xmlText(p)}</w:t></w:r></w:p>`)
    .join('')
  return makeZip([
    {
      name: '[Content_Types].xml',
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'word/document.xml',
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body>${body}</w:body></w:document>`,
        'utf8',
      ),
    },
  ])
}

/** A small but genuine RTF document, the shape TextEdit and Word emit:
 *  a font table, a `\*\generator` destination, escapes, and `\par` breaks. */
export function makeRtf(paragraphs: string[]): Buffer {
  const body = paragraphs.join('\\par\n')
  return Buffer.from(
    `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n` +
      `{\\*\\generator Riched20 10.0.0;}\n` +
      `\\pard\\tx720\\f0\\fs24 ${body}\\par\n}`,
    'latin1',
  )
}
