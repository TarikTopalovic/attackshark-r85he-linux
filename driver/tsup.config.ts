import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server-node.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  bundle: true,
  external: ["usb", "node-hid"],
});

