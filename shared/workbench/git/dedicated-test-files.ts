/*
 * Exports:
 * - dedicatedTestFilePatterns: known dedicated-test basename suffixes and paired prefix/extension conventions.
 * - isDedicatedTestFile: identify dedicated test filenames without inspecting source content.
 */

export const dedicatedTestFilePatterns = {
  suffixes: [
    ...["test", "spec"].flatMap(marker => (
      ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "rs"]
        .map(extension => `.${marker}.${extension}`)
    )),
    "_test.go", "_test.py", "_test.rb", "_spec.rb", "_test.dart", "_test.exs",
    "_test.clj", "_test.cljs", "_test.cljc",
    "Test.java", "Tests.java", "TestCase.java", "Test.kt", "Tests.kt",
    "Test.cs", "Tests.cs", "Tests.swift", "Test.php", "Test.scala", "Spec.scala",
  ],
  prefixSuffixPairs: [{ prefix: "test_", suffix: ".py" }],
} as const;

export function isDedicatedTestFile (path: string): boolean {
  const basename = path.split(/[\\/]/u).at(-1) ?? "";
  return dedicatedTestFilePatterns.suffixes.some(suffix => basename.endsWith(suffix))
    || dedicatedTestFilePatterns.prefixSuffixPairs.some(({ prefix, suffix }) => (
      basename.startsWith(prefix) && basename.endsWith(suffix)
    ));
}
