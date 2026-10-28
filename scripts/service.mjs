import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSpecification, installService, readSpecification, runService } from '../runtime/service.mjs';

const kitRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const [action = 'foreground', ...args] = process.argv.slice(2);
  if (action === 'run' && args.length === 1) runService(readSpecification(resolve(args[0])));
  else if (action === 'install' && args.length === 1) console.log(JSON.stringify(installService(readSpecification(resolve(args[0])))));
  else if (action === 'install' && args.length === 6) {
    const options = Object.fromEntries([0, 2, 4].map(i => [args[i], args[i + 1]]));
    if (Object.keys(options).length !== 3 || !options['--instance'] || !options['--config'] || !options['--state']) throw new Error('Explicit instance, config and state required');
    console.log(JSON.stringify(installService(defaultSpecification({ instance: options['--instance'],
      configPath: resolve(options['--config']), stateDirectory: resolve(options['--state']), environment: process.env }))));
  }
  else if (action === 'foreground' && !args.length) {
    const configPath = resolve(kitRoot, process.env.BUG_KIT_CONFIG || 'config.local.json');
    const spec = defaultSpecification({ instance: 'foreground', configPath,
      stateDirectory: resolve(kitRoot, process.env.BUG_KIT_SERVICE_STATE || 'data/service'), environment: process.env });
    runService(spec);
  } else throw new Error('Use foreground, run PRIVATE_MANIFEST or install --instance ID --config PATH --state PATH');
} catch {
  // Configuration can contain credentials: never echo parse errors or its bytes.
  console.error('Kit service could not start/install. Check Node>=24, private manifest/config and owned paths.');
  process.exitCode = 1;
}
