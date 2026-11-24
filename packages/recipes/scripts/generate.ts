import { recipeJsonSchemaText } from "../src/index";

// Rewrites recipe.schema.json from the `Recipe` Schema. Run it after changing that Schema:
// `bun run --filter @aemeth/recipes generate`. A test fails while the committed file is stale.
const target = new URL("../recipe.schema.json", import.meta.url);
const bytes = await Bun.write(target, recipeJsonSchemaText());
process.stdout.write(`Wrote ${bytes} bytes to ${target.pathname}\n`);
