import { addModelsToBlacklist } from '../../src/evaluate/model-blacklist.mjs';

const [file, index] = process.argv.slice(2);
await addModelsToBlacklist(file, [`provider/model-${index}:free`]);
