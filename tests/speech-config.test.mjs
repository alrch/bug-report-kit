import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withSpeechProfile} from '../server/speech-config.mjs';

test('speech image opt-in requires prepared assets and preserves explicit project commands',t=>{
  const root=mkdtempSync(join(tmpdir(),'kit-speech-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config={projects:[{id:'TEST'}]};assert.equal(withSpeechProfile(config,{env:{},rootDir:root}),config);
  const explicit={...config,transcription:{command:['TEST-owned-transcriber']}};
  assert.equal(withSpeechProfile(explicit,{env:{BUG_KIT_SPEECH_ENABLED:'1'},rootDir:root}),explicit);
  assert.throws(()=>withSpeechProfile(config,{env:{BUG_KIT_SPEECH_ENABLED:'1'},rootDir:root}),/prepared/);
  mkdirSync(join(root,'scripts'));mkdirSync(join(root,'model'));writeFileSync(join(root,'python'),'TEST');writeFileSync(join(root,'scripts/transcribe.py'),'TEST');writeFileSync(join(root,'model/model.bin'),'TEST');
  const env={BUG_KIT_SPEECH_ENABLED:'1',BUG_KIT_SPEECH_PYTHON:join(root,'python'),BUG_KIT_SPEECH_MODEL:join(root,'model')};
  const active=withSpeechProfile(config,{env,rootDir:root});assert.deepEqual(active.transcription.command,[env.BUG_KIT_SPEECH_PYTHON,join(root,'scripts/transcribe.py'),'--model',env.BUG_KIT_SPEECH_MODEL,'--language','ru']);assert.equal(config.transcription,undefined);
  assert.equal(withSpeechProfile(config,{env:{...env,BUG_KIT_SPEECH_LANGUAGE:'auto'},rootDir:root}).transcription.command.at(-1),'auto');
  assert.throws(()=>withSpeechProfile(config,{env:{...env,BUG_KIT_SPEECH_LANGUAGE:'ru;TEST'},rootDir:root}),/prepared/);
});
