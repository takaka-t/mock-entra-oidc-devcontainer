import { z } from "zod";
import {
  commitStagedFile,
  discardStagedFile,
  readJsonFile,
  SerialQueue,
  stageJsonFile,
} from "../persistence/json-file.js";
import { resourceSchema, updateResourceSchema } from "./validation.js";
import { defaultResourceAppId, defaultResourceUri, type ApiResourceConfig } from "./types.js";
export class ResourceConflictError extends Error {}
export class ResourceNotFoundError extends Error {}
export const defaultResources = (): ApiResourceConfig[] => [
  {
    resourceAppId: defaultResourceAppId,
    identifierUri: defaultResourceUri,
    scopes: ["access_as_user", "api.read", "api.write"],
    requestedAccessTokenVersion: 2,
    emailOptionalClaim: false,
    groupMembershipClaims: "SecurityGroup",
  },
];
export class ApiResourceStore {
  #resources = new Map<string, ApiResourceConfig>();
  constructor(
    readonly filePath: string,
    private readonly queue = new SerialQueue(),
    private readonly referenced: (id: string) => boolean = () => false,
    private readonly validateReferences: (resources: ApiResourceConfig[]) => void = () => undefined,
  ) {}
  async initialize(): Promise<void> {
    const contents = await readJsonFile(this.filePath);
    const resources = contents.exists ? z.array(resourceSchema).parse(contents.value) : defaultResources();
    this.validate(resources);
    if (!contents.exists) await this.commit(resources);
    else this.#resources = new Map(resources.map((resource) => [resource.resourceAppId, resource]));
  }
  list(): ApiResourceConfig[] {
    return structuredClone([...this.#resources.values()]);
  }
  find(id: string): ApiResourceConfig | undefined {
    const item = this.#resources.get(id);
    return item && structuredClone(item);
  }
  async create(input: unknown): Promise<ApiResourceConfig> {
    const resource = resourceSchema.parse(input);
    return this.queue.run(async () => {
      if (this.#resources.has(resource.resourceAppId)) throw new ResourceConflictError("API ID は登録済みです");
      await this.commit([...this.list(), resource]);
      return structuredClone(resource);
    });
  }
  async update(id: string, input: unknown): Promise<ApiResourceConfig> {
    const update = updateResourceSchema.parse(input);
    return this.queue.run(async () => {
      if (!this.#resources.has(id)) throw new ResourceNotFoundError();
      const resource = { resourceAppId: id, ...update };
      await this.commit(this.list().map((item) => (item.resourceAppId === id ? resource : item)));
      return structuredClone(resource);
    });
  }
  async delete(id: string): Promise<void> {
    return this.queue.run(async () => {
      if (!this.#resources.has(id)) throw new ResourceNotFoundError();
      if (this.referenced(id)) throw new ResourceConflictError("クライアントが参照している API は削除できません");
      await this.commit(this.list().filter((item) => item.resourceAppId !== id));
    });
  }
  async reset(): Promise<ApiResourceConfig[]> {
    return this.queue.run(async () => {
      const defaults = defaultResources();
      if (
        this.list().some(
          (item) =>
            !defaults.some((resource) => resource.resourceAppId === item.resourceAppId) &&
            this.referenced(item.resourceAppId),
        )
      )
        throw new ResourceConflictError("参照中の API はリセットで削除できません");
      await this.commit(defaults);
      return this.list();
    });
  }
  private validate(resources: ApiResourceConfig[]): void {
    if (
      new Set(resources.map((item) => item.resourceAppId)).size !== resources.length ||
      new Set(resources.map((item) => item.identifierUri)).size !== resources.length
    )
      throw new ResourceConflictError("API ID と Application ID URI は重複できません");
    this.validateReferences(resources);
  }
  private async commit(resources: ApiResourceConfig[]): Promise<void> {
    this.validate(resources);
    const staged = await stageJsonFile(this.filePath, resources);
    try {
      await commitStagedFile(staged, this.filePath);
      this.#resources = new Map(resources.map((item) => [item.resourceAppId, item]));
    } finally {
      await discardStagedFile(staged);
    }
  }
}
