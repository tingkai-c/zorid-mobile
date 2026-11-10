interface LaunchEnvironment {
  platform: string;
  development: boolean;
  updatesEnabled: boolean;
  embeddedLaunch: boolean;
}

/** A cached app can launch without a host, pairing credentials, or a network. */
export function launchDestination(environment: LaunchEnvironment): 'setup' | 'app' {
  if (environment.development || environment.platform === 'web') return 'app';
  return environment.updatesEnabled && !environment.embeddedLaunch ? 'app' : 'setup';
}
