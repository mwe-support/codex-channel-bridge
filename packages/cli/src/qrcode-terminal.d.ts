declare module "qrcode-terminal" {
  interface GenerateOptions {
    readonly small?: boolean;
  }

  interface QrCodeTerminal {
    generate(
      value: string,
      options: GenerateOptions,
      callback: (rendered: string) => void
    ): void;
  }

  const qrcode: QrCodeTerminal;
  export default qrcode;
}
