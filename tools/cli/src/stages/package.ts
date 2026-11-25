import { join } from "node:path";
import type { Golden, Sha256 } from "@gran-prix/contracts";
import { loadModelPackage } from "@gran-prix/model";
import { defineStage, type StagePlugin } from "../stage.js";
import type { ArtifactHandle } from "../store.js";
import { BUNDLE_JSON, GENERATED_MODULE, SELFTEST, SELFTEST_SOURCE, bundleDoc, generateModule, generatorDigest, runSelfTest } from "./bundle.js";

/**
 * `ts:package.bundle@1.0.0`: ModelPackage -> a deployable bundle (`Bundle`
 * file-set):
 *
 *  - every file of the package (`model.json`, `network_def.json`, `weights.f32le`,
 *    `golden.json`, plus any report that travels with it);
 *  - `model.generated.ts`: the self-contained inference module of
 *    `@gran-prix/infer-ts` (no imports, no WASM, no eval), head taken from `output_spec`;
 *  - `selftest.mjs`: runs `golden.json` through the generated module (normalization,
 *    calibration, output head) and exits 1 on any mismatch;
 *  - `bundle.json`: `model_id`, sha256 and size of every other file, and the self-test result.
 *
 * Deterministic: no timestamps, sorted keys, the generator's output is a pure
 * function of (network_def, weights, head). The package is verified with
 * `loadModelPackage` (9 checks) first, and the self-test is executed on the
 * very files that go into the bundle; a failure fails the stage.
 *
 * `toolDigests` pins the generator: a new `@gran-prix/infer-ts` output re-packages.
 */
export const packageStage: StagePlugin = {
  ...defineStage(
    {
      kind: "package",
      impl: "ts:package.bundle@1.0.0",
      inputs: [{ name: "model", type: "ModelPackage" }],
      outputs: [{ name: "bundle", type: "Bundle" }],
      params_schema: { type: "object", additionalProperties: false },
      runtime: "node+wasm",
      determinism: "pure",
    },
    (ctx) => {
      const model = ctx.inputs["model"] as ArtifactHandle;
      const loaded = loadModelPackage(join(model.dir, "files"));
      const manifest = loaded.manifest;
      const modelId = loaded.modelId;
      loaded.dispose();

      const files: Record<string, Uint8Array | string> = {};
      for (const p of model.files()) files[p] = model.file(p);
      for (const reserved of [GENERATED_MODULE, SELFTEST, BUNDLE_JSON]) {
        if (reserved in files) throw new Error(`the ModelPackage already has a file named ${reserved}, reserved for the bundle`);
      }
      const networkDef = new TextDecoder().decode(model.file(manifest.files.network_def.path));
      files[GENERATED_MODULE] = generateModule(manifest, networkDef, model.file(manifest.files.weights.path));
      files[SELFTEST] = SELFTEST_SOURCE;

      ctx.log(runSelfTest(files));

      const golden = JSON.parse(new TextDecoder().decode(model.file(manifest.files.golden.path))) as Golden;
      files[BUNDLE_JSON] = `${JSON.stringify(bundleDoc(manifest, modelId, files, golden), null, 2)}\n`;
      return { bundle: { files } };
    },
  ),
  toolDigests: (): Record<string, Sha256> => ({ "infer-ts-generator": generatorDigest() }),
};
