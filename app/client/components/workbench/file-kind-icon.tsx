/*
 * Exports:
 * - default FileKindIcon: the glyph for a file by extension: text documents, syntax-highlighted code, images, or a
 *   plain file for everything else.
 */
"use client";

import type { ComponentType } from "react";
import type { IconProps } from "./OutlinedIcon";
import { FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon } from "./workbench-icons";

const TEXT_EXTENSIONS = ["md", "markdown", "mdx", "txt", "text"];

const IMAGE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff"];

const CODE_EXTENSIONS = [
  // web
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl",
  "vue", "svelte", "astro", "graphql", "gql", "wasm", "wat",
  // data and config
  "json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "xml",
  "xsd", "xsl", "plist", "csv", "tsv", "lock", "editorconfig", "gitignore", "gitattributes", "npmrc", "prettierrc",
  "eslintrc", "babelrc", "browserslistrc", "dockerignore", "dockerfile", "containerfile", "makefile", "mk", "cmake",
  "gradle", "bazel", "bzl", "nix", "tf", "tfvars", "hcl", "proto", "prisma", "sql", "psql",
  // shells and scripting
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "psd1", "bat", "cmd", "awk", "sed", "py", "pyi", "pyw", "ipynb", "rb", "erb",
  "rake", "gemspec", "pl", "pm", "php", "lua", "r", "jl", "tcl", "vim",
  // compiled
  "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "ino", "m", "mm", "cs", "csx", "fs", "fsi", "fsx", "vb", "java", "kt",
  "kts", "scala", "sc", "groovy", "go", "rs", "swift", "dart", "zig", "nim", "v", "d", "odin", "hx",
  // functional and other
  "hs", "lhs", "elm", "ml", "mli", "re", "rei", "res", "resi", "clj", "cljs", "cljc", "edn", "ex", "exs", "erl", "hrl",
  "lisp", "el", "scm", "rkt", "purs", "gleam", "sol", "move", "cairo",
  // markup and templates
  "tex", "sty", "cls", "bib", "rst", "adoc", "org", "pug", "jade", "hbs", "handlebars", "mustache", "njk", "liquid", "twig",
  "ejs", "haml", "slim", "jinja", "j2",
  // shaders and misc
  "glsl", "vert", "frag", "hlsl", "wgsl", "metal", "shader", "cu", "asm", "s", "diff", "patch", "http", "rest", "log",
];

const ICONS_BY_EXTENSION = new Map<string, ComponentType<IconProps>>([
  ...CODE_EXTENSIONS.map((extension) => [extension, FileCodeIcon] as const),
  ...TEXT_EXTENSIONS.map((extension) => [extension, FileTextIcon] as const),
  ...IMAGE_EXTENSIONS.map((extension) => [extension, FileImageIcon] as const),
]);

/** Extension-less config files are named, not suffixed: `Dockerfile`, `.gitignore`. */
function fileExtension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(dot + 1);
}

export default function FileKindIcon({ path, ...props }: IconProps & { path: string }) {
  const Icon = ICONS_BY_EXTENSION.get(fileExtension(path)) ?? FileIcon;
  return <Icon {...props} />;
}
