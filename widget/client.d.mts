export interface KitReporter { id?: string; name?: string; contact?: string }
export interface KitClientOptions {
  serverUrl?: string;
  projectKey: string;
  reporterAuth?: boolean;
  voiceEnabled?: boolean;
  captureFetchErrors?: boolean;
  appVersion?: string;
  label?: string;
  launcherStyle?: string;
  reporterName?: string;
  reporterContact?: string;
  getReporter?: () => KitReporter;
}
export interface KitLease {
  readonly ready: Promise<unknown>;
  retry(): Promise<unknown>;
  release(): void;
}
export function acquireKit(options: KitClientOptions, settings?: {nonce?: string}): KitLease;
