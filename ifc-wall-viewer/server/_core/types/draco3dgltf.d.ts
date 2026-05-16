declare module "draco3dgltf" {
  interface EncoderModule {
    EncodeToDracoBuffer: (...args: any[]) => any;
    [key: string]: any;
  }
  interface DecoderModule {
    [key: string]: any;
  }
  function createEncoderModule(config?: Record<string, any>): Promise<EncoderModule>;
  function createDecoderModule(config?: Record<string, any>): Promise<DecoderModule>;
  export default { createEncoderModule, createDecoderModule };
}
