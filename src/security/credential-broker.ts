import { randomUUID } from "node:crypto";

export interface SecretRef {
  id: string;
}

export interface SecretScope {
  deviceId: string;
  purpose: string;
}

export interface SecretOptions {
  expiresAt?: string;
  oneTime?: boolean;
}

export interface SecretAuditEvent {
  secretId: string;
  action: "stored" | "accessed" | "denied" | "revoked";
  at: string;
  deviceId: string;
  purpose: string;
  reason?: "scope" | "expired" | "consumed" | "revoked" | "missing";
}

interface SecretRecord {
  value: string;
  scope: SecretScope;
  expiresAt?: string;
  oneTime: boolean;
  consumed: boolean;
  revoked: boolean;
}

export class CredentialBroker {
  readonly #secrets = new Map<string, SecretRecord>();
  readonly #audit: SecretAuditEvent[] = [];
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  store(value: string, scope: SecretScope, options: SecretOptions = {}): SecretRef {
    if (value.length === 0) throw new Error("secret must not be empty");
    if (!scope.deviceId || !scope.purpose) throw new Error("secret scope must be complete");

    const id = randomUUID();
    this.#secrets.set(id, {
      value,
      scope: { ...scope },
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      oneTime: options.oneTime ?? false,
      consumed: false,
      revoked: false,
    });
    this.#record(id, "stored", scope);
    return { id };
  }

  access(ref: SecretRef, scope: SecretScope): string {
    const secret = this.#secrets.get(ref.id);
    const reason = this.#denialReason(secret, scope);
    if (reason) {
      this.#record(ref.id, "denied", scope, reason);
      throw new Error(`secret access denied: ${reason}`);
    }

    if (!secret) throw new Error("secret access denied: missing");
    const value = secret.value;
    if (secret.oneTime) {
      secret.consumed = true;
      secret.value = "";
    }
    this.#record(ref.id, "accessed", scope);
    return value;
  }

  revoke(ref: SecretRef): void {
    const secret = this.#secrets.get(ref.id);
    if (!secret) return;
    secret.revoked = true;
    secret.value = "";
    this.#record(ref.id, "revoked", secret.scope);
  }

  audit(): readonly SecretAuditEvent[] {
    return this.#audit.map((event) => ({ ...event }));
  }

  #denialReason(
    secret: SecretRecord | undefined,
    scope: SecretScope,
  ): SecretAuditEvent["reason"] | undefined {
    if (!secret) return "missing";
    if (secret.revoked) return "revoked";
    if (secret.scope.deviceId !== scope.deviceId || secret.scope.purpose !== scope.purpose) {
      return "scope";
    }
    if (secret.expiresAt !== undefined && secret.expiresAt <= this.#now()) return "expired";
    if (secret.consumed) return "consumed";
    return undefined;
  }

  #record(
    secretId: string,
    action: SecretAuditEvent["action"],
    scope: SecretScope,
    reason?: SecretAuditEvent["reason"],
  ): void {
    this.#audit.push({
      secretId,
      action,
      at: this.#now(),
      deviceId: scope.deviceId,
      purpose: scope.purpose,
      ...(reason ? { reason } : {}),
    });
  }
}
