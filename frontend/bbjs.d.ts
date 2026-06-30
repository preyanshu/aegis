declare module "../node_modules/@aztec/bb.js/dest/browser/index.js" {
  export const BarretenbergSync: any;
  export class UltraHonkBackend {
    constructor(...args: any[]);
    generateProof(...args: any[]): Promise<any>;
    destroy?: () => Promise<void> | void;
  }
  export class Fr {
    constructor(value: bigint);
  }
}
