/* eslint-disable @typescript-eslint/no-explicit-any -- CDN module without published types */
declare module "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.bundle.min.js" {
  const ort: any;
  export default ort;
  export const InferenceSession: any;
  export const Tensor: any;
  export const env: any;
}
