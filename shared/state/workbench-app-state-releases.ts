/*
 * Exports:
 * - default appStateReleases: append-only named app-state releases and independently sealed fingerprints.
 */
function release<const Version extends number>(version: Version, fingerprint: string | null) {
  return Object.freeze({ version, fingerprint });
}

// Append new releases with a null fingerprint, then run the release inspector.
const appStateReleases = Object.freeze({
  initialAppState: release(1, "e8c5c1e35a21246bfede3342d5f02ee89323c0460bac8ca930be4425647fc40f"),
  globalPreferencesV2: release(2, "5f4b9c4b466237a43921714276f83191a4f5298dc0bd495e8355eebb49b6847c"),
  projectAndGlobalPreferences: release(3, "b5b7fedd329ee6091e90680e32489d2ba2a89edb9aa075e0eb60e89388c6c688"),
  globalPreferencesV4: release(4, "a22de782ffbb6b3408f4aead14f59eb9f6e6d0cb05950378879f90f084fe35ce"),
  globalPreferencesV5: release(5, "4e2db1b10453935cbcc74b42321c7bb1d65bf96ccffbf5b7aa358d93a48225d9"),
  globalPreferencesV6: release(6, "5a7252dedfca527c7f5bcbed0e8c972be225e739b8090a9a8ad9c0778cc36629"),
  modelPreferences: release(7, "22420d589726afbd5c121d4d82c7db498a899c93b927fb53c557702c0a2d7610"),
  providerReferences: release(8, "9dffb8602539ca72cd239d5476e9e0f204c09f1e456bdc28719a451eb94156b8"),
});

export default appStateReleases;
