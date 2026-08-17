/// <reference path="../../node_modules/@jsquash/webp/emscripten-types.d.ts" />

declare const __BUNDLED_WEBP_WASM__: boolean;

declare module "*.wasm" {
  const base64: string;
  export default base64;
}
