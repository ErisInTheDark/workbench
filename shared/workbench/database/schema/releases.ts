/*
 * Exports:
 * - default databaseReleases: append-only named orchestrator releases and independently sealed fingerprints.
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
});

export default databaseReleases;
