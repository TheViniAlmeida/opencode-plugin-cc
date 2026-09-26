// Typed errors and exit codes shared by every opc subcommand (spec §4.1).

export const ExitCode = Object.freeze({
  OK: 0,
  USAGE: 2,
  WAITING: 3,
  POLICY: 4,
  CONNECTION: 5,
  WAIT_TIMEOUT: 6,
  JOB_FAILED: 7,
  CANCELLED: 130,
});

export class OpcError extends Error {
  constructor(code, message, { exitCode = ExitCode.JOB_FAILED, details = undefined, cause = undefined } = {}) {
    super(message ?? code, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function subclass(defaultCode, defaultExit) {
  return class extends OpcError {
    constructor(code = defaultCode, message = undefined, opts = {}) {
      super(code, message, { ...opts, exitCode: opts.exitCode ?? defaultExit });
    }
  };
}

export class UsageError extends subclass('USAGE', ExitCode.USAGE) {}
export class PolicyError extends subclass('POLICY_DENIED', ExitCode.POLICY) {}
export class ConnectionError extends subclass('SERVER_DOWN', ExitCode.CONNECTION) {}
export class NotFoundError extends subclass('NOT_FOUND', ExitCode.USAGE) {}
export class RequestError extends subclass('SERVER_ERROR', ExitCode.JOB_FAILED) {}

export function toExitCode(err) {
  if (err instanceof OpcError && Number.isInteger(err.exitCode)) return err.exitCode;
  return ExitCode.JOB_FAILED;
}
