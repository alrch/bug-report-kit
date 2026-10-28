import {init} from './loader-core.js';

const embed = document.currentScript;
window.BugReportKitLoader = {...window.BugReportKitLoader, init};
if (embed?.dataset.projectKey) {
  const data = embed.dataset;
  init({serverUrl:data.serverUrl || new URL(embed.src).origin, projectKey:data.projectKey,
    label:data.label, launcherStyle:data.launcherStyle,
    appVersion:data.appVersion || document.querySelector('meta[name="app-version"]')?.content || '',
    captureFetchErrors:data.captureFetchErrors === 'true', reporterAuth:data.reporterAuth === 'true',
    voiceEnabled:data.voiceEnabled === 'true',
    reporterName:data.reporterName || '', reporterContact:data.reporterContact || '',
    getReporter:() => window.__BUG_REPORT_KIT_REPORTER_PROVIDER__?.() || {}}, embed.nonce);
}
