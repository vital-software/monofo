import { promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import debug from 'debug';
import globAsync from 'glob';
import { load as loadYaml } from 'js-yaml';
import _ from 'lodash';
import minimatch from 'minimatch';
import toposort from 'toposort';
import { getBuildkiteInfo } from './buildkite/config';
import ConfigFile, { strings } from './config-file';
import { FileHasher } from './hash';
import { count } from './util';

const log = debug('monofo:config');
const glob = promisify(globAsync);

// Glob caching
const symlinks = {};
const statCache = {};
const realpathCache = {};
const cache = {};

interface MonorepoConfig {
  name: string;
  expects: string[];
  produces: string[];
  matches: string[] | boolean;
  depends_on: string[];
  excluded_steps: Record<string, unknown>[];
  excluded_env: Record<string, string>;
  pure: boolean;
}

const EMPTY_CONFIG: MonorepoConfig = {
  depends_on: [],
  excluded_env: {},
  excluded_steps: [],
  expects: [],
  matches: false,
  produces: [],
  pure: false,
  name: 'empty',
};

const KNOWN_CONFIG_PROPERTIES = Object.keys(EMPTY_CONFIG);

const FALLBACK_CHANGES = ['fallback'];

/**
 * Value object representing a parsed YAML pipeline configuration, with associated metadata and decision information
 */
export default class Config {
  /**
   * @protected Is constructed by Config.read(configFile), try Config.getAll() instead
   */
  protected constructor(
    public readonly file: ConfigFile,
    public readonly monorepo: MonorepoConfig,
    public steps: Step[],
    public readonly env: Record<string, string>
  ) {}

  /**
   * Base build we're comparing against, if one can be found. If one can't, we'll enter fallback mode and run
   * everything.
   */
  public buildId?: string;

  /**
   * Set of files, with changes that match the configuration
   */
  public changes: string[] = [];

  /**
   * Whether this config is currently considered for inclusion in the final pipeline output
   */
  public included?: boolean = false;

  /**
   * Reason for inclusion/exclusion
   *
   * Should fit into the sentence: "Foo has been included/excluded because it has {REASON}"
   */
  public reason = 'no matching changes';

  /**
   * Memoized list of files that match this config
   */
  private matchingFiles?: string[] = undefined;

  public envVarName(): string {
    return this.monorepo.name.toLocaleUpperCase().replace(/-/g, '_');
  }

  public decide(included: boolean, reason: string): void {
    this.included = included;
    this.reason = reason;
  }

  public mapSteps(mapFn: (s: Step) => Step): void {
    this.steps = this.steps.map(mapFn);
  }

  public useFallback(): void {
    this.changes = FALLBACK_CHANGES;
    this.buildId = undefined;
  }

  public setBuildId(buildId: string): void {
    this.buildId = buildId;
  }

  public async getContentHash(hasher: FileHasher): Promise<string> {
    log(`Getting content hash for ${this.monorepo.name}`);
    return hasher.hashMany(await this.getMatchingFiles());
  }

  /**
   * Used as a key in global namespaces
   */
  public getComponent(): string {
    const { pipeline } = getBuildkiteInfo();
    return `${pipeline}/${this.monorepo.name}`;
  }

  /**
   * The list of matches for the config
   *
   * Includes this file
   */
  private matchPatterns(): string[] {
    if (typeof this.monorepo.matches === 'boolean') {
      return this.monorepo.matches ? ['**/*'] : [];
    }

    return [...this.monorepo.matches, this.file.path];
  }

  /**
   * Returns all files that match the pipeline, whether they have changes or not
   */
  public async getMatchingFiles(): Promise<string[]> {
    if (!this.matchingFiles) {
      log(`Getting matching files for ${this.monorepo.name}`);
      const patterns = this.matchPatterns();

      this.matchingFiles = await Promise.all(
        patterns.map(async (pattern) =>
          glob(pattern, {
            matchBase: true,
            dot: true,
            nodir: true,
            cache,
            symlinks,
            statCache,
            realpathCache,
          })
        )
      ).then((r) => {
        const flat = [...new Set(r.flat())];
        log(`Found ${count(flat, 'matching file')}`);
        return flat;
      });
    }

    return this.matchingFiles || [];
  }

  /**
   * Given a set of changed files, updates the changes property to have the subset
   * of the changed files that also match the globs for this config
   *
   * @param changedFiles
   */
  public updateMatchingChanges(changedFiles: string[]): void {
    const patterns = this.matchPatterns();

    if (!changedFiles || changedFiles.length < 1) {
      this.changes = [];
      return;
    }

    this.changes = [
      ...new Set(
        patterns.flatMap((pattern) =>
          minimatch.match(changedFiles, pattern, {
            matchBase: true,
            dot: true,
          })
        )
      ),
    ];
  }

  private static async readYaml(file: ConfigFile): Promise<Config> {
    const buffer = await fs.readFile(join(file.basePath, file.path));

    try {
      const result = loadYaml(buffer.toString());

      if (typeof result !== 'object') {
        log(`Expected object for pipeline configuration in ${file.path}, got ${typeof result}, skipping`);
        return {} as unknown as Config;
      }

      return result as unknown as Config;
    } catch (err) {
      log(`Could not load YAML from ${file.path}, skipping`);
      return {} as unknown as Config;
    }
  }

  private static logUnknownProperties(monorepo: MonorepoConfig): void {
    const unknown = _.difference(Object.keys(monorepo), KNOWN_CONFIG_PROPERTIES);

    if (unknown.length > 0) {
      log(`Found unknown properties on monorepo configuration, continuing anyway: ${JSON.stringify(unknown)}`);
    }
  }

  public static async read(file: ConfigFile): Promise<Config | undefined> {
    const { monorepo, steps, env } = await Config.readYaml(file);

    if (_.isArray(env)) {
      // Fail noisily rather than missing the merge of the env vars
      throw new Error('TODO: monofo cannot cope with env being an array yet (split to object)');
    }

    const name = monorepo?.name || file.nameFromFilename();

    if (!name) {
      log(`Skipping ${file.path} because it has no pipeline name`);
      return Promise.resolve(undefined);
    }

    if (!monorepo || typeof monorepo !== 'object') {
      log(`Skipping ${name} because it has no monorepo configuration`);
      return undefined;
    }

    Config.logUnknownProperties(monorepo);

    return new Config(
      file,
      {
        ...monorepo,
        name,
        expects: strings(monorepo.expects),
        produces: strings(monorepo.produces),
        matches: typeof monorepo.matches === 'boolean' ? monorepo.matches : strings(monorepo.matches),
        depends_on: strings(monorepo.depends_on),
        excluded_steps: monorepo.excluded_steps || [],
        excluded_env: monorepo.excluded_env || {},
        pure: monorepo.pure || false,
      },
      steps,
      env
    );
  }

  /**
   * Indexes the configs by the artifacts each produces, and the depends_on list, and sorts them into dependency order
   *
   * We presort by name (which might not just come from the file name any longer). This makes toposort tie-breaker order
   * independent of location on the filesystem
   */
  public static sort(configs: Config[]): Config[] {
    function thrw<T>(e: Error): T {
      throw e;
    }

    const byName = Object.fromEntries(configs.map((c) => [c.monorepo.name, c]));
    const byProducerOf = Object.fromEntries(configs.flatMap((c) => c.monorepo.produces.map((p) => [p, c])));

    const sorted = toposort.array(
      Object.keys(byName).sort(),
      configs.flatMap((c) => {
        // The constraints on ordering are:
        return [
          // the producer of an expected artifact must happen before the current config
          ...c.monorepo.expects.map((expected): [string, string] => {
            return byProducerOf[expected]
              ? [byProducerOf[expected].monorepo.name, c.monorepo.name]
              : thrw(new Error(`Could not find a component that produces "${expected}"`));
          }),
          // configs we depend_on must happen before the current config
          ...c.monorepo.depends_on.map((dependency): [string, string] => {
            return byName[dependency]
              ? [dependency, c.monorepo.name]
              : thrw(new Error(`Could not find a config named "pipeline.${dependency}.yml"`));
          }),
        ];
      })
    );

    log(`Will apply pipelines in order: [${sorted.join(', ')}]`);
    return sorted.map((name) => byName[name]);
  }

  /**
   * Reads all the config files that can be read, and ignores any that can't be read
   */
  private static async readAll(cwd: string): Promise<Config[]> {
    return (await Promise.all((await ConfigFile.search(cwd)).map((f) => Config.read(f)))).reduce<Config[]>(
      (acc, curr) => (curr ? [...acc, curr] : acc),
      []
    );
  }

  /**
   * Reads pipeline.foo.yml files from .buildkite/*, parses them, and returns them as Config objects in the right order
   * to be processed
   */
  public static async getAll(cwd: string): Promise<Config[]> {
    const results = await Config.readAll(cwd);
    return Config.sort(results.filter((c) => c));
  }

  public static async getOne(cwd: string, component: string): Promise<Config | undefined> {
    const results = await Config.readAll(cwd);
    return results.find((c) => c?.monorepo.name === component);
  }

  /**
   * Mutates the given configs to a fallback configuration
   * @param _e An error that caused the fallback, if there is one? Unused
   * @param configs
   */
  public static configureFallback(_e: Error, configs: Config[]): void {
    return configs.forEach((c) => c.useFallback());
  }
}
