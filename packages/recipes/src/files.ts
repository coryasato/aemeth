import artifactsPipeline from "../artifacts-pipeline.recipe.json" with { type: "json" };
import environmentCleanup from "../environment-cleanup.recipe.json" with { type: "json" };
import gradualRelease from "../gradual-release.recipe.json" with { type: "json" };
import restoreDrill from "../restore-drill.recipe.json" with { type: "json" };
import schemaMigration from "../schema-migration.recipe.json" with { type: "json" };
import secretRotation from "../secret-rotation.recipe.json" with { type: "json" };

/**
 * The recipe files of this package, as documents: what the engine's Worker is bundled with
 * (M2, "Persistence"). Named one by one so that a bundler needs no glob; a test holds this list
 * to the files in the folder.
 */
export const recipeFiles: ReadonlyArray<{ readonly id: string }> = [
  artifactsPipeline,
  environmentCleanup,
  gradualRelease,
  restoreDrill,
  schemaMigration,
  secretRotation,
];
