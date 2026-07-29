import { publishProfileSave } from '../../src/application/profile-transaction.mjs';

const [base, encodedSave, mode = 'save'] = process.argv.slice(2);
const save = JSON.parse(encodedSave);

await publishProfileSave(save, {
  base,
  afterStage(stage, _entry, index) {
    if (mode === 'crash-after-first-target' && stage === 'target' && index === 0) {
      process.exit(73);
    }
  },
});
