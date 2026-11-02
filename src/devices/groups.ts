import type { StoredDeviceGroup, TapRigStore } from "../persistence/store.ts";

const groupName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

export class DeviceGroupService {
  readonly #store: TapRigStore;
  readonly #now: () => string;

  constructor(store: TapRigStore, now = () => new Date().toISOString()) {
    this.#store = store;
    this.#now = now;
  }

  set(name: string, deviceIds: readonly string[]): StoredDeviceGroup {
    if (!groupName.test(name)) {
      throw new Error("group name must use 1 to 64 letters, numbers, dashes, or underscores");
    }
    if (
      !Array.isArray(deviceIds) ||
      deviceIds.length < 1 ||
      deviceIds.length > 100 ||
      deviceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 300)
    ) {
      throw new Error("group must contain from 1 to 100 valid device IDs");
    }
    const unique = [...new Set(deviceIds.map((id) => id.trim()))];
    if (unique.length !== deviceIds.length) throw new Error("group device IDs must be unique");
    const existing = this.#store.getDeviceGroup(name);
    const at = this.#now();
    const group: StoredDeviceGroup = {
      name,
      deviceIds: unique,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.#store.saveDeviceGroup(group);
    return group;
  }

  get(name: string): StoredDeviceGroup | undefined {
    return this.#store.getDeviceGroup(name);
  }

  list(): StoredDeviceGroup[] {
    return this.#store.listDeviceGroups();
  }

  delete(name: string): boolean {
    if (!groupName.test(name)) throw new Error("invalid group name");
    return this.#store.deleteDeviceGroup(name);
  }
}
