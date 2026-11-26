import {
  ArchiveBucket,
  CiToken,
  currentStage,
  EngineWorker,
  Index,
  SampleDatabase,
} from "@aemeth/engine/cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

/**
 * Everything Aemeth deploys, as one stack with three kinds of stage: `staging`, `production`,
 * and `pr-<number>` for a pull request or a test (M2, "Deployment"). Every resource carries its
 * stage in its name. Deployment state is kept on the account, shared by CI and by whoever
 * deploys by hand (M2 decision 6); deploying by hand with the same command is the out-of-band
 * path of decision 0008.
 *
 * The Worker brings its own resources with it: the cluster's Durable Object classes, the index
 * database with its migrations, the archive bucket, and the Access application in front. A stage
 * that is thrown away also has the seeded sample database the restore drill is run against.
 */
export default Alchemy.Stack(
  "Aemeth",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const engine = yield* EngineWorker;
    const token = yield* CiToken;
    const index = yield* Index;
    const archive = yield* ArchiveBucket;
    const sample =
      (yield* currentStage) === "ThrownAway" ? (yield* SampleDatabase).databaseId : undefined;
    return {
      url: engine.url,
      // What a caller that is not a person presents to Access. The secret is redacted in the
      // output and in the state; the integration tests read it from the deploy they make.
      ciClientId: token.clientId,
      ciClientSecret: token.clientSecret,
      // The id the restore drill is given as its `production` on this stage, if it has one.
      sampleId: sample,
      // What the drill of Aemeth's own index is given to drill this stage: the index's id as its
      // `production`, and the archive bucket's name as its `archive` (M2 Part E).
      indexId: index.databaseId,
      archiveBucket: archive.bucketName,
    };
  }),
);
