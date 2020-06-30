/**
 * Our own internal value instance that collects environment variable values
 */
interface BuildkiteEnvironment {
  branch: string;
  commit: string;
  defaultBranch: string;
  source: string;
  org: string;
  pipeline: string;
}

/**
 * As returned for a build from the Buildkite REST API
 */
interface BuildkiteBuild {
  id: string;
  web_url: string;
  commit: string;
  [others: string]: unknown;
}

interface Step {
  depends_on?: string | string[];
  key?: string;
  label?: string;
  plugins?: Record<string, unknown>[];
  [others: string]: unknown;
}

interface CommandStep extends Step {
  command: string;
}