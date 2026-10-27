import {existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

// The speech image opts in. An explicit project command always wins.
export function withSpeechProfile(config, {env=process.env,rootDir}={}) {
  if (env.BUG_KIT_SPEECH_ENABLED !== '1' || config.transcription !== undefined) return config;
  const python=env.BUG_KIT_SPEECH_PYTHON || '/opt/bug-kit/speech/bin/python';
  const model=env.BUG_KIT_SPEECH_MODEL || '/opt/bug-kit/models/small';
  const language=env.BUG_KIT_SPEECH_LANGUAGE || 'ru';
  if (!rootDir || !isAbsolute(python) || !isAbsolute(model) || !/^(auto|[a-z]{2,3})$/.test(language)
      || !existsSync(python) || !existsSync(join(model,'model.bin')) || !existsSync(join(rootDir,'scripts/transcribe.py'))) {
    throw new Error('Speech profile requires its prepared Python, model and transcriber');
  }
  return {...config,transcription:{command:[python,join(rootDir,'scripts/transcribe.py'),'--model',model,'--language',language]}};
}
