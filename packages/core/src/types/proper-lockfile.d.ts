declare module 'proper-lockfile' {
  export interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }

  export interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | RetryOptions;
    realpath?: boolean;
    lockfilePath?: string;
    onCompromised?: (error: Error) => void;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: { stale?: number }): Promise<boolean>;

  const defaultExport: {
    lock: typeof lock;
    unlock: typeof unlock;
    check: typeof check;
  };
  export default defaultExport;
}
