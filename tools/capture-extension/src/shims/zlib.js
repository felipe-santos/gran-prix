// `node:zlib` stand-in: the collect code the bundle reuses (flatten.js, set-readers.js) imports gzip/gunzip for
// functions the extension never calls (it gzips with CompressionStream). Calling them fails loudly.
const unavailable = (name) => () => {
  throw new Error(`zlib shim: ${name} is not available in the extension`);
};
export const gzipSync = unavailable("gzipSync");
export const gunzipSync = unavailable("gunzipSync");
