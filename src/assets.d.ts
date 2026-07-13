// Font bytes bundled into the Worker via the wrangler `rules` Data module
// (wrangler.jsonc) — imported as raw ArrayBuffers, fed to takumi as fonts.
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
