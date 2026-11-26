// `Buffer` stand-in (esbuild `inject`): the reused flatten.js only calls `Buffer.byteLength(text, "utf8")` (in
// htmlFileRef) and `Buffer.from` inside gzipHtml, which the extension never calls.
export const Buffer = {
  byteLength(text, encoding = "utf8") {
    if (encoding !== "utf8") throw new Error("Buffer shim: only utf8 is available");
    return new TextEncoder().encode(text).length;
  },
  from() {
    throw new Error("Buffer shim: Buffer.from is not available in the extension");
  },
};
