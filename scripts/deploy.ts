/**
 * Single-shot deploy entry point.
 *
 * Builds a v2 `ReleaseSpec` (migrations + RLS expose + functions + site +
 * subdomain) and ships it via `r.deploy.apply()` in one call. The CAS
 * content service uploads only the bytes the gateway hasn't seen on a
 * prior release — re-deploying an unchanged tree issues no S3 PUTs.
 *
 * Migrated from `apps.bundleDeploy()` (which is now a deprecated compat
 * shim emitting a stale `expose.tables` shape the gateway rejects). See
 * the friction note in `docs/run402-feedback.md`.
 *
 * Usage:
 *   npx tsx scripts/deploy.ts                                # production deploy
 *   npx tsx scripts/deploy.ts --dry-run                      # assemble + log, no API call
 *   RUN402_PROJECT_ID=prj_xxx SUBDOMAIN=eagles \
 *     SEED_FILE=demo/eagles/seed.sql \
 *     EXCLUDE_FUNCTIONS=check-expirations,reset-demo \
 *     npx tsx scripts/deploy.ts                              # demo deploy
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { run402 } from "@run402/sdk/node";

import {
  buildAstro,
  collectFunctionsMap,
  EXPOSE_TABLES,
  fileSetFromDir,
  injectEnvJs,
  isDryRun,
  prettyPrintError,
  readMigrations,
  resolveDeployTarget,
  sha256Hex,
  type ReleaseSpec,
} from "./_lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = isDryRun(process.argv);

async function main(): Promise<void> {
  const r = run402();
  const target = await resolveDeployTarget(r);

  buildAstro();

  const distDir = join(ROOT, "dist");
  injectEnvJs(distDir, target.anonKey);

  const sql = readMigrations(ROOT);
  const migrationId = `kychon_${sha256Hex(sql).slice(0, 16)}`;

  const fileSet = await fileSetFromDir(distDir);
  const fileCount = Object.keys(fileSet).length;

  const functionsMap = await collectFunctionsMap(join(ROOT, "functions"));
  const fnNames = Object.keys(functionsMap);
  const scheduledFns = fnNames.filter((n) => functionsMap[n]?.schedule);

  // Type cast: SDK `ExposeManifest.tables` is `Array<Record<string, unknown>>`
  // matching the published manifest schema, but the gateway runtime validator
  // currently requires `string[]`. Probe-verified on 2026-04-29.
  const expose = {
    version: "1",
    tables: EXPOSE_TABLES,
  } as unknown as ReleaseSpec["database"] extends infer D
    ? D extends { expose?: infer E }
      ? E
      : never
    : never;

  const spec: ReleaseSpec = {
    project: target.projectId,
    database: {
      migrations: [{ id: migrationId, sql }],
      expose,
    },
    site: { replace: fileSet },
    subdomains: { set: [target.subdomain] },
  };
  if (fnNames.length > 0) {
    spec.functions = { replace: functionsMap };
  }

  console.log(
    `Deploying to ${target.projectId} (subdomain: ${target.subdomain})\n` +
      `  ${fileCount} site files (lazy-streamed from ${distDir})\n` +
      `  ${fnNames.length} functions (${scheduledFns.length} scheduled)\n` +
      `  ${sql.length} migration bytes (id: ${migrationId})`,
  );

  if (dryRun) {
    console.log("\n[dry-run] Would call deploy.apply with:");
    const summary = {
      projectId: target.projectId,
      subdomain: target.subdomain,
      filesCount: fileCount,
      functionsCount: fnNames.length,
      functionsWithSchedule: scheduledFns.map(
        (n) => `${n}=${functionsMap[n]?.schedule}`,
      ),
      migrationsBytes: sql.length,
      migrationId,
      exposeTables: EXPOSE_TABLES.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const startedAt = Date.now();
  const result = await r.deploy.apply(spec);
  const elapsedMs = Date.now() - startedAt;

  console.log(`\nDeploy successful in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  Release id: ${result.release_id}`);
  console.log(`  Operation id: ${result.operation_id}`);
  for (const [k, v] of Object.entries(result.urls)) {
    console.log(`  ${k}: ${v}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(await prettyPrintError(err));
  process.exit(1);
}
