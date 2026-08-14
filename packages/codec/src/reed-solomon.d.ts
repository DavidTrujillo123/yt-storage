declare module '@ronomon/reed-solomon' {
  export interface Context {
    readonly k: number;
    readonly m: number;
  }

  export interface ReedSolomonModule {
    MAX_K: number;
    MAX_M: number;
    create(k: number, m: number): Context;
    encode(
      context: Context,
      sources: number,
      targets: number,
      buffer: Buffer,
      bufferOffset: number,
      bufferSize: number,
      parity: Buffer,
      parityOffset: number,
      paritySize: number,
      callback: (error: Error | null) => void,
    ): void;
  }

  const ReedSolomon: ReedSolomonModule;
  export default ReedSolomon;
}
