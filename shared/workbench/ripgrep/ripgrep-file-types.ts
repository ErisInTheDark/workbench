/*
 * Exports:
 * - RIPGREP_FILE_TYPES: named file-type globs for wb rg -t/-T filters.
 * - formatRipgrepTypeList: render the --type-list output.
 */

export const RIPGREP_FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  c: ["*.c", "*.h"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.c++", "*.hpp", "*.hh", "*.hxx", "*.h", "*.inl"],
  cs: ["*.cs", "*.csx"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  go: ["*.go"],
  html: ["*.html", "*.htm", "*.xhtml"],
  java: ["*.java"],
  js: ["*.js", "*.jsx", "*.cjs", "*.mjs", "*.vue"],
  json: ["*.json", "*.jsonc", "*.json5", "*.jsonl"],
  kotlin: ["*.kt", "*.kts"],
  lua: ["*.lua"],
  markdown: ["*.md", "*.markdown", "*.mdx"],
  md: ["*.md", "*.markdown", "*.mdx"],
  php: ["*.php"],
  ps: ["*.ps1", "*.psm1", "*.psd1"],
  py: ["*.py", "*.pyi"],
  ruby: ["*.rb", "*.rake", "Gemfile"],
  rust: ["*.rs"],
  sh: ["*.sh", "*.bash", "*.zsh", "*.fish"],
  sql: ["*.sql"],
  svelte: ["*.svelte"],
  swift: ["*.swift"],
  toml: ["*.toml"],
  ts: ["*.ts", "*.tsx", "*.cts", "*.mts"],
  txt: ["*.txt"],
  vue: ["*.vue"],
  xml: ["*.xml", "*.xsd", "*.xsl", "*.svg"],
  yaml: ["*.yaml", "*.yml"],
};

export function formatRipgrepTypeList() {
  return Object.keys(RIPGREP_FILE_TYPES)
    .sort()
    .map(name => `${name}: ${RIPGREP_FILE_TYPES[name]!.join(", ")}\n`)
    .join("");
}
