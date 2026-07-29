import { cacheProviderDescriptions } from '../../src/scan/jd-cache.mjs';

const [outDir, indexRaw] = process.argv.slice(2);
const index = Number(indexRaw);

await cacheProviderDescriptions([{
  url: `https://jobs.example/roles/${index}`,
  company: `Company ${index}`,
  title: `Platform Engineer ${index}`,
  location: 'Remote',
  description: `Durable cache description ${index}.`,
}], { outDir });
