#!/usr/bin/env node
import {resolve, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readConfig, DeploymentError, fail} from '../runtime/deploy/config.mjs';
import {createDocker, createStandaloneAdapter} from '../runtime/deploy/docker.mjs';
import {createComposeAdapter} from '../runtime/deploy/compose.mjs';
import {deploy} from '../runtime/deploy/installer.mjs';
try {
  const [action, config, option, module, ...extra] = process.argv.slice(2);
  if (!action || !config || extra.length || option !== undefined && (option !== '--adapter' || !module || !isAbsolute(module))) fail('USAGE');
  const spec = readConfig(resolve(config));
  const docker = createDocker();
  // An adapter is explicitly selected, trusted owning-project CODE, never commands
  // interpreted from deployment data. Its lifecycle/locking contract is documented.
  const adapter = option ? await (await import(pathToFileURL(module))).createAdapter({spec, docker, createComposeAdapter}) : createStandaloneAdapter({spec, docker});
  console.log(JSON.stringify(await deploy(action, spec, {docker, adapter})));
} catch (error) {
  const code = error instanceof DeploymentError ? error.code : 'DEPLOYMENT_FAILED';
  console.error(JSON.stringify({ok: false, code}));
  process.exitCode = 1;
}
