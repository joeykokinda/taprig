import { randomUUID } from "node:crypto";

export interface TakeoverLease {
  id: string;
  deviceId: string;
  expiresAt: string;
}

export class TakeoverLeases {
  readonly #leases = new Map<string, TakeoverLease>();
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #ttlMs: number;

  constructor(now = Date.now, id: () => string = randomUUID, ttlMs = 60_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
      throw new Error("takeover TTL must be from 5 to 300 seconds");
    }
    this.#now = now;
    this.#id = id;
    this.#ttlMs = ttlMs;
  }

  acquire(deviceId: string): TakeoverLease {
    const current = this.#leases.get(deviceId);
    if (current && Date.parse(current.expiresAt) > this.#now()) {
      throw new Error(`device ${deviceId} already has an active takeover lease`);
    }
    const lease = {
      id: this.#id(),
      deviceId,
      expiresAt: new Date(this.#now() + this.#ttlMs).toISOString(),
    };
    this.#leases.set(deviceId, lease);
    return lease;
  }

  renew(deviceId: string, leaseId: string): TakeoverLease {
    this.require(deviceId, leaseId);
    const lease = {
      id: leaseId,
      deviceId,
      expiresAt: new Date(this.#now() + this.#ttlMs).toISOString(),
    };
    this.#leases.set(deviceId, lease);
    return lease;
  }

  release(deviceId: string, leaseId: string): void {
    this.require(deviceId, leaseId);
    this.#leases.delete(deviceId);
  }

  require(deviceId: string, leaseId: string): TakeoverLease {
    const lease = this.#leases.get(deviceId);
    if (!lease || lease.id !== leaseId || Date.parse(lease.expiresAt) <= this.#now()) {
      if (lease && Date.parse(lease.expiresAt) <= this.#now()) this.#leases.delete(deviceId);
      throw new Error("takeover lease is missing, expired, or does not match the device");
    }
    return lease;
  }
}
