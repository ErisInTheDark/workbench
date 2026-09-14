/*
 * No exports.
 * Own pinned native voice dependencies, patch application, builds and Cargo tests.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voice = path.join(root, "app", "voice");
const cache = path.join(root, ".workbench", "native-voice");
const lockPath = path.join(voice, "native-dependencies.json");
const args = new Set(process.argv.slice(2));
const modes = ["--pin", "--prepare", "--build", "--test"];
if (args.size !== 1 || !modes.some(mode => args.has(mode))) {
  throw new Error(`Use node scripts/build-voice.mjs ${modes.join(" | ")}`);
}
const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
const env = {
  ...process.env,
  CARGO_HOME: path.join(cache, "cargo"),
  CARGO_TARGET_DIR: path.join(voice, "target"),
  GIT_CEILING_DIRECTORIES: cache,
};

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: root, env, stdio: "inherit", windowsHide: true, ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "workbench-native-voice-build" } });
  if (!response.ok) throw new Error(`Dependency metadata HTTP ${response.status}: ${url}`);
  return response.json();
}

async function download(url, file, expectedHash) {
  if (await exists(file)) {
    const hash = await digest(file);
    if (expectedHash && hash !== expectedHash) throw new Error(`Cached dependency digest mismatch: ${file}`);
    return hash;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Dependency download HTTP ${response.status}: ${url}`);
  const temporary = `${file}.${randomUUID()}.partial`;
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }),
    createWriteStream(temporary, { flags: "wx" }),
  );
  const actualHash = hash.digest("hex");
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`Downloaded dependency digest mismatch; rejected file retained at ${temporary}`);
  }
  await fs.rename(temporary, file);
  return actualHash;
}

await fs.mkdir(cache, { recursive: true });
if (args.has("--pin")) {
  if (lock.sherpa.commit || lock.sherpa.sha256 || lock.model.sha256) {
    throw new Error("Dependency identities already pinned. Review an explicit lock edit before repinning.");
  }
  const ref = await getJson(`https://api.github.com/repos/k2-fsa/sherpa-onnx/git/ref/tags/v${lock.sherpa.version}`);
  const object = ref.object.type === "tag"
    ? (await getJson(ref.object.url)).object
    : ref.object;
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) {
    throw new Error("Sherpa release tag did not resolve to a commit.");
  }
  lock.sherpa.commit = object.sha;
} else if (!/^[a-f0-9]{40}$/.test(lock.sherpa.commit ?? "")
  || !/^[a-f0-9]{64}$/.test(lock.sherpa.sha256 ?? "")
  || !/^[a-f0-9]{64}$/.test(lock.model.sha256 ?? "")) {
  throw new Error("Dependencies are not pinned; the maintainer must explicitly run --pin first.");
}

const sourceArchive = path.join(cache, `sherpa-${lock.sherpa.commit}.tar.gz`);
lock.sherpa.sha256 = await download(
  `https://github.com/k2-fsa/sherpa-onnx/archive/${lock.sherpa.commit}.tar.gz`,
  sourceArchive, lock.sherpa.sha256,
);
const modelArchive = path.join(cache, `${lock.model.name}.tar.bz2`);
lock.model.sha256 = await download(lock.model.url, modelArchive, lock.model.sha256);
if (args.has("--pin")) {
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log("Pinned dependency identities. Subsequent preparation/builds verify these hashes.");
}

async function unpack(archive, target, directory) {
  if (await exists(path.join(target, ".unpacked"))) return path.join(target, directory);
  if (await exists(target)) throw new Error(`Incomplete dependency extraction retained at ${target}`);
  await fs.mkdir(target, { recursive: true });
  console.log(`Extracting ${path.basename(archive)}`);
  await run("cmake", ["-E", "tar", "xf", archive], { cwd: target });
  if (!await exists(path.join(target, directory))) throw new Error("Dependency archive root is missing");
  await fs.writeFile(path.join(target, ".unpacked"), "complete\n");
  return path.join(target, directory);
}

const sourceRoot = `sherpa-onnx-${lock.sherpa.commit}`;
const original = await unpack(sourceArchive, path.join(cache, `source-cmake-${lock.sherpa.sha256}`), sourceRoot);
const modelDirectory = await unpack(modelArchive, path.join(cache, `model-cmake-${lock.model.sha256}`), lock.model.name);
if (args.has("--pin") || args.has("--prepare")) {
  console.log(`Source: ${original}\nModel: ${modelDirectory}`);
} else {
  const patch = path.join(voice, "patches", `sherpa-onnx-v${lock.sherpa.version}.patch`);
  const patchHash = await digest(patch);
  const key = createHash("sha256")
    .update(`${lock.sherpa.commit}-${patchHash}-${process.platform}-${process.arch}`)
    .digest("hex").slice(0, 16);
  const extracted = path.join(cache, `p-${key}`);
  const source = path.join(extracted, sourceRoot);
  if (!await exists(path.join(source, ".patched"))) {
    await unpack(sourceArchive, extracted, sourceRoot);
    const patchEnv = { ...env, GIT_CEILING_DIRECTORIES: cache };
    await run("git", ["apply", "--check", patch], { cwd: source, env: patchEnv });
    await run("git", ["apply", patch], { cwd: source, env: patchEnv });
    await fs.writeFile(path.join(source, ".patched"), `${patchHash}\n`);
  }
  const generator = process.env.CMAKE_GENERATOR
    ?? (process.platform === "win32" ? "Visual Studio 17 2022" : "Unix Makefiles");
  const generatorKey = createHash("sha256").update(generator).digest("hex").slice(0, 8);
  const build = path.join(cache, `b-${key}-${generatorKey}`);
  const install = path.join(cache, `i-${key}-${generatorKey}`);
  await run("cmake", [
    "-S", source, "-B", build, "-G", generator,
    ...(generator.startsWith("Visual Studio") ? ["-A", process.arch === "arm64" ? "ARM64" : "x64"] : []),
    "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${install}`,
    "-DBUILD_SHARED_LIBS=ON", "-DSHERPA_ONNX_ENABLE_C_API=ON",
    "-DSHERPA_ONNX_ENABLE_TTS=OFF", "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
    "-DSHERPA_ONNX_ENABLE_TESTS=OFF", "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
    "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF", "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
    "-DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF",
    "-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF",
  ]);
  await run("cmake", ["--build", build, "--config", "Release", "--parallel", "2"]);
  await run("cmake", ["--install", build, "--config", "Release"]);
  const profile = path.join(voice, "target", args.has("--test") ? "debug" : "release");
  const runtimeFiles = (await fs.readdir(path.join(install, "lib")))
    .filter(file => file.endsWith(".dll") || file.endsWith(".dylib") || /\.so(?:\.\d+)*$/.test(file));
  // Cargo's test executables live in deps, not beside the normal binary.
  for (const destination of [profile, path.join(profile, "deps")]) {
    await fs.mkdir(destination, { recursive: true });
    for (const file of runtimeFiles) {
      await fs.copyFile(path.join(install, "lib", file), path.join(destination, file));
    }
  }
  const nativeEnv = {
    ...env,
    SHERPA_ONNX_LIB_DIR: path.join(install, "lib"),
    WORKBENCH_VOICE_MODEL_DIR: modelDirectory,
  };
  if (process.platform === "linux" || process.platform === "darwin") {
    const existingFlags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
      : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
    const origin = process.platform === "darwin" ? "@loader_path" : "$ORIGIN";
    nativeEnv.CARGO_ENCODED_RUSTFLAGS = [
      ...existingFlags, "-C", `link-arg=-Wl,-rpath,${origin}`,
    ].join("\x1f");
  }
  await run("cargo", [
    args.has("--test") ? "test" : "build",
    "--manifest-path", path.join(voice, "Cargo.toml"), "--features", "native", "--locked",
    ...(args.has("--test") ? ["--", "--nocapture"] : ["--release"]),
  ], { env: nativeEnv });
}
