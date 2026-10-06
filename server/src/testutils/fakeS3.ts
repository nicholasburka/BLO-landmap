/**
 * In-memory fake S3 client for tests: an object map keyed by object key.
 * The real code constructs genuine @aws-sdk/client-s3 command objects, so
 * the fake dispatches on the command's constructor name — the same shape an
 * injected real client would see. Inject via initLibraryBucket().
 */
export class FakeS3 {
  objects = new Map<string, Buffer>()
  /** Per-key LastModified, as real S3 reports in listings. seed() stamps
   *  "now" unless given a date — or null to omit the field entirely. */
  modified = new Map<string, Date>()
  /** Per-key Content-Type as stored, so tests can assert what label the
   *  bucket would hand back on download. */
  contentTypes = new Map<string, string>()
  failNext = false
  calls: string[] = []

  seed(key: string, body: string | Buffer, lastModified: Date | null = new Date()): void {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body))
    if (lastModified) this.modified.set(key, lastModified)
    else this.modified.delete(key)
  }

  async send(cmd: any): Promise<any> {
    const name = cmd.constructor.name
    this.calls.push(`${name}:${cmd.input?.Key ?? cmd.input?.Prefix ?? ''}`)
    if (this.failNext) {
      this.failNext = false
      throw new Error('bucket down')
    }
    switch (name) {
      case 'PutObjectCommand': {
        const body = cmd.input.Body
        if (body && typeof body.pipe === 'function') {
          // Streaming upload (P5-10): consume the stream like real S3 would.
          const chunks: Buffer[] = []
          for await (const chunk of body) chunks.push(Buffer.from(chunk))
          this.objects.set(cmd.input.Key, Buffer.concat(chunks))
        } else {
          this.objects.set(cmd.input.Key, Buffer.from(body))
        }
        this.modified.set(cmd.input.Key, new Date())
        if (cmd.input.ContentType) this.contentTypes.set(cmd.input.Key, cmd.input.ContentType)
        return {}
      }
      case 'GetObjectCommand': {
        const body = this.objects.get(cmd.input.Key)
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } }
      }
      case 'DeleteObjectCommand': {
        this.objects.delete(cmd.input.Key)
        this.modified.delete(cmd.input.Key)
        this.contentTypes.delete(cmd.input.Key)
        return {}
      }
      case 'ListObjectsV2Command': {
        const prefix = cmd.input.Prefix ?? ''
        const Contents = [...this.objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([Key, buf]) => ({
            Key,
            Size: buf.length,
            ...(this.modified.has(Key) ? { LastModified: this.modified.get(Key) } : {}),
          }))
        return { Contents, IsTruncated: false }
      }
      default:
        throw new Error(`FakeS3: unhandled command ${name}`)
    }
  }

  destroy(): void {}
}
