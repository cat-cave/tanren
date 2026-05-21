export interface SecretValue {
  ref: string;
  value: string;
}

export interface SecretStore {
  put(secret: SecretValue): Promise<void>;
  get(ref: string): Promise<SecretValue | undefined>;
  delete(ref: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async put(secret: SecretValue): Promise<void> {
    this.values.set(secret.ref, secret.value);
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.values.get(ref);
    return value === undefined ? undefined : { ref, value };
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

export class FakeSecretStore extends InMemorySecretStore {}
