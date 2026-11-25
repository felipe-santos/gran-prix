import { writeBundle } from "./bundle.mjs";

const r = await writeBundle();
console.log(`bundle: ${r.path} (${r.bytes} bytes)`);
