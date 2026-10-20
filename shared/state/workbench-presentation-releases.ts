/*
 * Exports:
 * - default presentationReleases: sealed release history for shared app presentation state.
 */
const presentationReleases = Object.freeze({
  initialPresentation: Object.freeze({ version: 1, fingerprint: "91969bb006f7130e879f4065cf839c26b5a9f4c6fe263cac1c0f52fbfe48b8e8" }),
  convergedIdentity: Object.freeze({ version: 2, fingerprint: "740760a9ab8a2556e7d0e51099e9cd21dc62abac3c2285b29c3aeefe94d395a0" }),
  draftReferences: Object.freeze({ version: 3, fingerprint: "94facea39fabbf05dc096dc1514242526e1c24f5233a8e6fa3403acfd6b1178e" }),
  hiddenLocations: Object.freeze({ version: 4, fingerprint: "d654f695934d322ca69053f49763ef2ba9ccf0a587ec942140f5a786080084bf" }),
  attachmentOrder: Object.freeze({ version: 5, fingerprint: "093d5ffa35128dd7c2cb284822db6c60202850a25029ba16145e55704cce6698" }),
  threadSnoozes: Object.freeze({ version: 6, fingerprint: "6a6c690655b29e0fe236061fe79022a09cd05746c0e786c06e1633b78ed7ac8f" }),
  threadPins: Object.freeze({ version: 7, fingerprint: "8f0042a48f79483e3396a238846cedd8c032157ee2531e23896dfdac816d9e97" }),
});
export default presentationReleases;
