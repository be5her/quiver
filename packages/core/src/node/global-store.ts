import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultGlobalConfig } from '../defaults';
import type { GlobalConfig } from '../types';

/** Shallow merge with the nested sections merged one level deeper, so a partial `mcp` or `teleport` patch keeps the other keys. */
function mergeConfig(base: GlobalConfig, patch: Partial<GlobalConfig>): GlobalConfig {
  return {
    ...base,
    ...patch,
    mcp: { ...base.mcp, ...(patch.mcp ?? {}) },
    teleport: { ...base.teleport, ...(patch.teleport ?? {}) },
  };
}

/** Global, per-user configuration stored as one JSON file in the app data folder. */
export class GlobalStore {
  private config: GlobalConfig = defaultGlobalConfig();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onChange: (config: GlobalConfig) => void = () => {},
  ) {}

  async load(): Promise<GlobalConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<GlobalConfig>;
      this.config = mergeConfig(defaultGlobalConfig(), raw);
    } catch {
      this.config = defaultGlobalConfig();
    }
    return this.config;
  }

  get(): GlobalConfig {
    return this.config;
  }

  async update(patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
    this.config = mergeConfig(this.config, patch);
    const snapshot = JSON.stringify(this.config, null, 2) + '\n';
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.file);
    });
    await this.writing;
    this.onChange(this.config);
    return this.config;
  }
}
