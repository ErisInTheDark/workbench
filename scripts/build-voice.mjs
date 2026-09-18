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
const voice = path.join(root, "daemon", "voice");
const cache = path.join(root, ".workbench", "native-voice");
const lockPath = path.join(voice, "native-dependencies.json");
const args = new Set(process.argv.slice(2));
const modes = ["--pin", "--pin-model", "--prepare", "--build", "--test"];
if (args.size !== 1 || !modes.some(mode => args.has(mode))) {
  throw new Error(`Use node scripts/build-voice.mjs ${modes.join(" | ")}`);
}
const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
const modelFiles = [lock.model.encoder, lock.model.decoder, lock.model.joiner, lock.model.tokens, "README.md"];
if (!/^[a-f0-9]{40}$/.test(lock.model.revision ?? "")
  || !/^[\w.-]+\/[\w.-]+$/.test(lock.model.repository ?? "")
  || modelFiles.some(file => typeof file !== "string" || !/^[\w.-]+$/.test(file))) {
  throw new Error("Model repository, revision and filenames must be explicitly pinned.");
}
const pinModel = args.has("--pin") || args.has("--pin-model");
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
  if (lock.sherpa.commit || lock.sherpa.sha256) {
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
  || !/^[a-f0-9]{64}$/.test(lock.sherpa.sha256 ?? "")) {
  throw new Error("Dependencies are not pinned; the maintainer must explicitly run --pin first.");
}
if (pinModel && Object.keys(lock.model.sha256 ?? {}).length) {
  throw new Error("Model digests already pinned. Review an explicit lock edit before repinning.");
}
if (!pinModel && modelFiles.some(file => !/^[a-f0-9]{64}$/.test(lock.model.sha256?.[file] ?? ""))) {
  throw new Error("Model digests are not pinned; run --pin-model after reviewing the model revision.");
}

const sourceArchive = path.join(cache, `sherpa-${lock.sherpa.commit}.tar.gz`);
lock.sherpa.sha256 = await download(
  `https://github.com/k2-fsa/sherpa-onnx/archive/${lock.sherpa.commit}.tar.gz`,
  sourceArchive, lock.sherpa.sha256,
);
const modelDirectory = path.join(cache, `model-${lock.model.revision}`, lock.model.name);
for (const file of modelFiles) {
  lock.model.sha256[file] = await download(
    `https://huggingface.co/${lock.model.repository}/resolve/${lock.model.revision}/${file}`,
    path.join(modelDirectory, file), lock.model.sha256[file],
  );
}
if (pinModel) {
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

async function publishRuntime(profile, files, modelDirectory) {
  const id = randomUUID();
  const candidate = path.join(cache, `publish-${id}`);
  const retired = path.join(cache, `retired-${id}`);
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const destination = path.join(voice, "bin", platform);
  const receipt = path.join(candidate, "runtime.json");
  await fs.mkdir(candidate);
  await fs.mkdir(retired);
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) await fs.copyFile(path.join(profile, file), path.join(candidate, file));
  const executableName = process.platform === "win32" ? "workbench-voice.exe" : "workbench-voice";
  // Loading the actual candidate verifies its platform, libraries, model and patched API.
  await run(path.join(candidate, executableName), [], {
    cwd: candidate, env: { ...env, WORKBENCH_VOICE_MODEL_DIR: modelDirectory },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await fs.writeFile(receipt, `${JSON.stringify({
    version: 1, platform: process.platform, arch: process.arch,
    executable: path.join(destination, executableName), modelDirectory,
  }, null, 2)}\n`);
  const replaced = [];
  const published = [];
  try {
    for (const file of files) {
      try {
        await fs.rename(path.join(destination, file), path.join(retired, file));
        replaced.push(file);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.rename(path.join(candidate, file), path.join(destination, file));
      published.push(file);
    }
    await fs.rename(receipt, path.join(cache, "runtime.json"));
  } catch (error) {
    const failures = [error];
    for (const file of [...published].reverse()) {
      try { await fs.rename(path.join(destination, file), path.join(candidate, file)); }
      catch (recoveryError) { failures.push(recoveryError); }
    }
    for (const file of [...replaced].reverse()) {
      try { await fs.rename(path.join(retired, file), path.join(destination, file)); }
      catch (recoveryError) { failures.push(recoveryError); }
    }
    throw new AggregateError(failures, "Voice publication failed; candidate and retirement evidence retained.");
  }
  for (const file of replaced) {
    try { await fs.unlink(path.join(retired, file)); }
    catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
      console.warn(`Retained running voice image: ${path.join(retired, file)}`);
    }
  }
  console.log(`Published voice runtime: ${path.join(destination, executableName)}`);
}

const sourceRoot = `sherpa-onnx-${lock.sherpa.commit}`;
const original = await unpack(sourceArchive, path.join(cache, `source-cmake-${lock.sherpa.sha256}`), sourceRoot);
if (pinModel || args.has("--prepare")) {
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
  if (args.has("--test")) {
    const fixture = lock.testFixture;
    if (!/^[a-f0-9]{64}$/.test(fixture?.sha256 ?? "")) throw new Error("Test fixture must be pinned.");
    const archive = path.join(cache, `${fixture.directory}.tar.bz2`);
    await download(fixture.url, archive, fixture.sha256);
    nativeEnv.WORKBENCH_VOICE_TEST_DIR = await unpack(
      archive, path.join(cache, `model-cmake-${fixture.sha256}`), fixture.directory,
    );
  }
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
  if (!args.has("--test")) {
    await publishRuntime(profile, [
      ...runtimeFiles, process.platform === "win32" ? "workbench-voice.exe" : "workbench-voice",
    ], modelDirectory);
  }
}
