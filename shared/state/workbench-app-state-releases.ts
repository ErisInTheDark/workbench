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
  projectAliases: release(9, "07d88a8a4a529b75a97a80a3474b675ccc380dac13a732778985ec32c3aa666d"),
  privateNetworking: release(10, "fd0ba1ebb1fbd4d72302d4757b84b8db0c461adb9be52a172a10ee1c148c3fcd"),
  networkModes: release(11, "d613aaa087d4ba1701e3b5909bfb34a5c89c68ffc8839d235820209bdd6b7237"),
  networkGroups: release(12, "76e73d35f255405ed42e3aa461214a53342d4c6182f75c32aa776aa6af39984e"),
  voiceInputEnabled: release(13, "93d7f16abf2f83c17a099780dc0a5624013239863433245e35ee7f57d06454bf"),
  threadCodeDetails: release(14, "ce63bff82b2e4dfae3ac5db5d250431f9472f2380a32c2c254ffe81d36372146"),
});

export default appStateReleases;
