/* Default export: QRCode creates a local QR module matrix without DOM or network work. */
declare module "qrcode" {
  const QRCode: {
    create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): {
      modules: { size: number; get(row: number, column: number): number };
    };
  };
  export default QRCode;
}
