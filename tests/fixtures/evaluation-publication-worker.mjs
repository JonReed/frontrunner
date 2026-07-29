import {
  publishEvaluationArtifacts,
  recoverEvaluationPublications,
} from '../../src/evaluate/evaluation-publication.mjs';

const [mode, rootDir] = process.argv.slice(2);

if (mode === 'publish-crash') {
  await publishEvaluationArtifacts({
    number: 7,
    slug: 'crash-co',
    date: '2026-07-29',
    report: '# crash-safe report\n',
    tracker: '7\t2026-07-29\tCrash Co\tEngineer\tEvaluated\t4.5/5\t❌\t[007](reports/007-crash-co-2026-07-29.md)\tfixture\n',
    mergeTracker: false,
    rootDir,
  }, {
    afterStage(stage) {
      if (stage === 'report') process.exit(86);
    },
  });
} else if (mode === 'recover') {
  await recoverEvaluationPublications({ rootDir });
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
