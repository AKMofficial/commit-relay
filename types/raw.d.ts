/** Vite's `?raw` suffix, which is how fixtures reach the Workers pool as text:
 *  there is no filesystem there, and `with { type: 'json' }` would hand back a
 *  parsed object that only re-serialisation could turn back into bytes (15.5). */
declare module '*?raw' {
  const content: string;
  export default content;
}
