declare module "subset-font" {
  interface SubsetFontOptions {
    targetFormat?: "truetype" | "woff" | "woff2";
    preserveNameIds?: string[] | boolean;
    variationAxes?: Array<{ tag: string; min: number; max: number; def: number }>;
    noLayoutClosure?: boolean;
  }
  type SubsetFont = (
    source: string | Buffer | Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ) => Promise<Buffer>;
  const subsetFont: SubsetFont;
  export default subsetFont;
}