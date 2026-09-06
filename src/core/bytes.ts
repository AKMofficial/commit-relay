export const UTF8_ENCODER = new TextEncoder();

/** UTF-8 bytes. Not Buffer.byteLength, Buffer does not exist on Workers. */
export function byteLength(s: string): number {
  return UTF8_ENCODER.encode(s).length;
}

/** The bytes Basecamp actually receives: the JSON envelope, not the bare HTML. */
export function contentBytes(html: string): number {
  return byteLength(JSON.stringify({ content: html }));
}

/** Cancels the moment the byte budget is crossed. `null` means budget exceeded. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0) as Uint8Array<ArrayBuffer>;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out as Uint8Array<ArrayBuffer>;
}

/** The ceiling every glob subject and every ref name is checked against (7.6).
 *  Lives beside byteLength so the ref classifier does not have to reach into
 *  src/config/ for a byte bound. */
export const MAX_SUBJECT_BYTES = 512;

export function subjectTooLong(subject: string): boolean {
  if (subject.length > MAX_SUBJECT_BYTES) return true;
  return byteLength(subject) > MAX_SUBJECT_BYTES;
}
