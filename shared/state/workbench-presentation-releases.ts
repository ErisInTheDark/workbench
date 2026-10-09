/*
 * Exports:
 * - default presentationReleases: sealed release history for shared app presentation state.
 */
const presentationReleases = Object.freeze({
  initialPresentation: Object.freeze({ version: 1, fingerprint: "91969bb006f7130e879f4065cf839c26b5a9f4c6fe263cac1c0f52fbfe48b8e8" }),
  convergedIdentity: Object.freeze({ version: 2, fingerprint: "740760a9ab8a2556e7d0e51099e9cd21dc62abac3c2285b29c3aeefe94d395a0" }),
  draftReferences: Object.freeze({ version: 3, fingerprint: "94facea39fabbf05dc096dc1514242526e1c24f5233a8e6fa3403acfd6b1178e" }),
});
export default presentationReleases;
