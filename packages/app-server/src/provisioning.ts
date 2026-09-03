/**
 * Install and doctor, injected rather than imported.
 *
 * `claude-workflow-kit` (the installer package) already depends on the server
 * packages, so importing it back here would close a dependency cycle. Instead
 * the CLI hands its own `install` / `doctor` / `listPresets` to
 * `createAppServer`, and a build without them answers 501 instead of pretending
 * the buttons work.
 */
import { HttpError } from '@claude-workflow-kit/monitor-server';

export interface InstallRequest {
  projectRoot: string;
  preset?: string;
  runtimeDir?: string;
  monitorPort?: number;
  hooks?: boolean;
  claudeMd?: boolean;
  mode?: 'init' | 'update';
  dryRun?: boolean;
}

export interface InstallOutcome {
  written: string[];
  skipped: string[];
  backups: string[];
  conflicts: string[];
  projectRoot: string;
  config: { runtimeDir: string; preset?: string; monitorPort: number };
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * Structural, not nominal: the installer's own `install`/`doctor` satisfy this
 * without app-server ever importing their types.
 */
export interface ProvisioningHooks {
  install(request: InstallRequest): InstallOutcome;
  doctor(request: { projectRoot: string; runtimeDir?: string; monitorUrl?: string }): Promise<DoctorCheck[]>;
  listPresets(): string[];
  kitVersion?(): string;
}

export function requireProvisioning(hooks?: ProvisioningHooks): ProvisioningHooks {
  if (!hooks) {
    throw new HttpError(
      'this build of the app server has no installer attached; run `cw app` from the claude-workflow-kit CLI',
      501,
    );
  }
  return hooks;
}
