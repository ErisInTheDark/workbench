/*
 * Exports:
 * - default databaseReleases: append-only named daemon releases and independently sealed fingerprints.
 */
function release<const Version extends number>(version: Version, fingerprint: string | null) {
  return Object.freeze({ version, fingerprint });
}

// Append new releases with a null fingerprint, then run the release inspector.
const databaseReleases = Object.freeze({
  initialTranscript: release(1, "f8a353752a0fca6a06d9d6f3872c1895bcca58b77f0a1259bbf55d67600ec86c"),
  codexSandboxNetwork: release(2, "bfad0f465ff37125f00ce162e326cae1b91edf2920802cd72585a20e01c8bf5c"),
  threadStateGlobals: release(3, "ef36ba600a612a4dbdbf21eed45da4371d807015546d627adb48481ec8e77e3d"),
  threadState: release(4, "cae71f4c31afad1a152bd73135782d7d34832a939643aef07199a339959e1d8a"),
  threadStateRelationships: release(5, "d936c0fc9b54319f729d89e74d22556907f8c7345effb942e766609d59931f98"),
  search: release(6, "6b3a38b2880a0c107b30114cba90c144dbb38a917c16e7bdd7bb4b4f3c0e21e1"),
  usage: release(7, "49e0ecff2a6bf7a92a1f9bbd7e69f767c2210b2bb7ee08269ae51837e62f1306"),
  usageImports: release(8, "55d547fac4fdd0e0a6484aed71059ba28255a8092a368cdab9ee853723c84cda"),
  usageAttribution: release(9, "f06f5a83de33fa9acdc32602f74117077bac0fe535425ae17a74db4430370f20"),
  usageImportDetails: release(10, "70ceb29c577b74aeb2f87decd44be62ce66425f2a1c3c7e3e4f8bae1706923a6"),
  composerProfiles: release(11, "b104d0ddeb70647d8d131f5e1f50b4a5969c8005536e34fdffacceb6f6fdaecc"),
  callableTools: release(12, "c1338336a238f9820574a85427b9200317e89882890e70e366d8f8d677d71e0f"),
  toolOutputParts: release(13, "7bd90ce434be398cd6cfb3f904a6ed97533b18006f38f327962e040641ee6c92"),
  fileChangeDetails: release(14, "a680e92c56da153ce7245eea1dd31ee4cd202d63de9f03e3be62f3c24e762574"),
  mixedModelUsage: release(15, "22d3ae583775b2a750353e7d95231722c469c836476e9458ae3667074bf2186a"),
  threadTitleHistory: release(16, "a1ec41a148376ed85aa992c563ea4d1954de23c8f4788bc07661f8630ac8c7cd"),
  threadIdentityOrigin: release(17, "c1e4b5bf96252085c409ada55d317045a1a54283981dbb51ca88232727a955dd"),
  transcriptIdentity: release(18, "5abaa1e0a683b6dcaa373190237370058834e2f72b2724b2d7f279e39b0b7098"),
  userInputKinds: release(19, "586d08df9287fc8c01308a1f5bdf298a226977ae7ca82a56b7584c6da1bd4532"),
  scopedThreadStateRelationships: release(20, "fb49eb5fbd79a16df341ad37d1ef9fa9be677caad02353c49624c112a7327a77"),
  threadContextUsage: release(21, "dfe7da4ce567acdba3107c8490574f10a3ccf06fbf0e37af1e46f8b18f001e87"),
  nativeIdentityLookupIndexes: release(22, "39f98b5d26a877d9b823641be9385407a0577a282a10744652cc8e7cf68c6bcb"),
  relationalThreadState: release(23, "b42b22c4cfc5b4d4dc491931c1fcd37a003c4dd6c23bc4f3cae756f3ac9355f4"),
  profileContextWindows: release(24, "183bc7545fd7b9ea47c17decb5f4bb8c204fb767634f5d7d4888ba69cc187953"),
  threadOwnedLifecycle: release(25, "5489b60ed8e25419cc967cd3fa3543deb52cb65bd1f2a6b78aaa166bd121f2fd"),
  codexTranscriptCursors: release(26, "71a4c1e1180cc8ce17764e20a5d3d13b6bd7397abd8ba3739d72e8d30d12d5c9"),
  profileTurnUsage: release(27, "097a815a7f1c749221ab772c5f06ba3994c2da5e9cca3ce7f38fd89dd5dad18f"),
  gitArcProposalDiffCache: release(28, "54d2dd92aec1de7b9aed3cf337ed2742b13468addef146b8a3bfca1c602efeeb"),
  nativePlanRemoval: release(29, "3512b3f17168a87e195bcbb5abe0dae212fc16d5b0ba82f369a0a5fff106362c"),
  instructionTombstones: release(30, "5fda5dca74274fde0d216a45a4dec4613f2907d89572bb91ff335a837cb7c3c7"),
  providerReferences: release(31, "81716764a09af1f52c187c7b4f29c82293e4f26be482b7f61a2216956afebda0"),
  projectIdentity: release(32, "8f5890cc7e61b832e43c7f6fd3db940397eb8c704ca8f5e3b4548cc3b02b3f42"),
  projectOwnership: release(33, "0071d9975b51bb48603819f151baa51f582eac113dac7ef9d476ef7fc0785ce5"),
  relationalProposalDiffs: release(34, "740b43df33972b1e93368f9275c9ca6bd42506fd510a8b7f10becee73fc376e7"),
  externalCatalogues: release(35, "ae6c9d27e19c5ecf04e9ca906ab169449e03aea815b79a8be67e00d43e73e5c7"),
  retireThreadProjections: release(36, "46e3111f95d723e81760ca587df75f652a6983be7703a8c803d699d54d183c54"),
  captureGapLookup: release(37, "4d952c5e9770cae3329e47c8d1fe444a2aa10db708fe316d9e90ec03f8c1abf5"),
  transcriptAssetContent: release(38, "d6751757edf4434b848cf036de5b1ea9cf8c81cb7fa4c904d08341223c487489"),
  legacyDiffArtifacts: release(39, "3e59f9c345e1ef4f289254fd51cbb1f4d31097dac009a256da9304a8fba756e3"),
  threadGitSelections: release(40, "e9b7b1d65acf1a29a4349d5fb399773413b7c0ab5c0b021a3577b458a92e3334"),
  retireLegacyImportReceipts: release(41, "611dab097b429ab8dc2e3733f4012bf2ac09d1d7c3c3259236d380d33cb9a391"),
  browseProjectOwnership: release(42, "1570bc51bcdc9ff050a5cb6d62d848624f552e65f29769179a49109b92ce200d"),
  stableProjectPreparation: release(43, "a729a7ecd56b325dff985a5176b20393921160b83b1d89152cdcd9ea373df4f6"),
  stableProjectOwnership: release(44, "9e16378a683e1f5aee559f31f70be27006ebf758710128f768ad25f958d2a448"),
});

export default databaseReleases;
