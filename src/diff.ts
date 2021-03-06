import debug from 'debug';
import _ from 'lodash';
import BuildkiteClient from './buildkite/client';
import Config from './config';
import { mergeBase, revList, revParse } from './git';
import { count, filterAsync } from './util';

const log = debug('monofo:diff');

/**
 * Finds the most recent build of the given branch where:
 *
 *   1. There is an associated Buildkite build that is successful, fully applied, and not blocked, for the base build's
 *       commit
 *   2. The commit was an ancestor of the integration branch (i.e. the commit was at or before the currently building
 *       commit on the branch)
 *
 * This is the more conservative algorithm compared to getMostRecentBranchBuild below
 */
async function getSuitableBranchBuildAtOrBeforeCommit(
  info: BuildkiteEnvironment,
  commit: string,
  branch: string
): Promise<BuildkiteBuild> {
  const client = new BuildkiteClient(info);

  const builds: Promise<BuildkiteBuild[]> = client.getBuilds({
    'branch[]': [branch],
    state: 'passed',
    per_page: 50,
  });

  const gitCommits: Promise<string[]> = revList('--first-parent', '-n', '100', commit);
  const buildkiteCommits: Promise<string[]> = builds.then((all) =>
    all.filter((build) => !build.blocked).map((build) => build.commit)
  );

  return Promise.all([gitCommits, buildkiteCommits]).then((commitLists: string[][]) => {
    const intersection = _.intersection<string>(...commitLists);

    if (intersection.length < 1) {
      throw new Error('Could not find any matching successful builds');
    }

    log(`Found ${intersection[0]} as latest successful build of default branch from ${commit} or earlier`);
    return builds.then((b: BuildkiteBuild[]) => {
      const build = _.find(b, (v: BuildkiteBuild) => v.commit === intersection[0]);

      if (!build) {
        return Promise.reject(new Error(`Cannot find build ${intersection[0]}`));
      }

      return Promise.resolve(build);
    });
  });
}

/**
 * Finds the most recent build of the given branch where:
 *
 *   1. There is an associated Buildkite build that is successful, fully applied, and not blocked, for the base build's
 *       commit
 *
 * That's the only guarantee. The commit of that build might be quite topolgoically distant. It will exist though (we
 * check with rev-parse)
 */
async function getMostRecentBranchBuild(
  info: BuildkiteEnvironment,
  branch: string
): Promise<BuildkiteBuild | undefined> {
  const client = new BuildkiteClient(info);

  const builds: BuildkiteBuild[] = await client.getBuilds({
    'branch[]': [branch],
    state: 'passed',
    per_page: 10,
  });

  const successful = builds.filter((build) => !build.blocked);

  const withExistingCommits = await filterAsync(successful, async (build) => {
    return revParse(build.commit)
      .then(() => true)
      .catch(() => false);
  });

  return withExistingCommits.pop();
}

/**
 * If we are on the default (i.e. main) branch, we look for the previous successful build of it that matches in git
 *
 * This is a two-pronged lookup, where we look for the intersection of successful default branch builds and commits on
 * the default branch in git, and pick the most topologically recent.
 */
async function getBaseBuildForDefaultBranch(info: BuildkiteEnvironment): Promise<BuildkiteBuild> {
  return getSuitableBranchBuildAtOrBeforeCommit(info, info.commit, info.defaultBranch).catch((e) => {
    log(`Failed to find successful build for default branch (${info.branch}) via Buildkite API`, e);
    throw e;
  });
}

/**
 * If we are on an integration branch, we look for the previous successful build of it
 *
 * This is a more risky single-pronged lookup, where we just take Buildkite's word for what the current state of the
 * environment is, even if the most recently applied commit is topologically distant (because e.g. someone reset back in
 * time, or to a completely different branch of development).
 *
 * So, we look for the most recent successful build of the integration branch, grab its commit, and validate it still
 * exists on the remote. If this process fails, we fall back to getBaseBuildForDefaultBranch
 */
async function getBaseBuildForIntegrationBranch(
  info: BuildkiteEnvironment,
  integrationBranch: string
): Promise<BuildkiteBuild> {
  return getMostRecentBranchBuild(info, integrationBranch)
    .then((result) => result || getBaseBuildForDefaultBranch(info))
    .catch((e) => {
      log(`Failed to find successful build for integration branch (${info.branch}) via Buildkite API`, e);
      throw e;
    });
}

/**
 * If we are on a feature branch, we look for the previous successful build of the default branch on or before the merge-base of the feature branch
 *
 * This is a two-pronged lookup, where we look for the intersection of successful default branch builds and commits on
 * the default branch in git, and pick the most topologically recent.
 */
async function getBaseBuildForFeatureBranch(info: BuildkiteEnvironment): Promise<BuildkiteBuild> {
  return mergeBase(`origin/${info.defaultBranch}`, info.commit, info.defaultBranch).then((commit) => {
    log(`Found merge base of ${commit} for current feature branch`);
    return getSuitableBranchBuildAtOrBeforeCommit(info, commit, info.defaultBranch).catch((e) => {
      log(
        `Failed to find successful build for merge base (${commit}) of feature branch (${info.branch}) via Buildkite API, will use fallback mode. Try bringing your branch up-to-date with ${info.defaultBranch}, if it isn't already?`,
        e
      );
      throw e;
    });
  });
}

/**
 * The base commit is the commit used to compare a build with
 *
 * When resolved, will always be a commit on the main branch. It will also be a commit with a successful build (so we
 * can snarf artifacts)
 */
export async function getBaseBuild(info: BuildkiteEnvironment): Promise<BuildkiteBuild> {
  if (info.branch === info.defaultBranch) {
    return getBaseBuildForDefaultBranch(info);
  }

  if (info.branch === info.integrationBranch) {
    return getBaseBuildForIntegrationBranch(info, info.integrationBranch);
  }

  return getBaseBuildForFeatureBranch(info);
}

export function matchConfigs(buildId: string, configs: Config[], changedFiles: string[]): void {
  log(`Found ${count(changedFiles, 'changed file')}: ${changedFiles.join(', ')}`);

  configs.forEach((config) => {
    config.setBuildId(buildId);
    config.updateMatchingChanges(changedFiles);

    if (config.changes.length > 1) {
      log(`Found ${count(config.changes, 'matching change')} for ${config.monorepo.name}`);
    }
  });
}
