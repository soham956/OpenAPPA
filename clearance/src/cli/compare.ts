// `npm run compare <runA> <runB>` or `npm run compare -- --expected <run>`.
import { runCompareCli } from '../log/compare';

process.exit(runCompareCli(process.argv.slice(2)));
