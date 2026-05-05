import { execFileSync } from 'node:child_process';
import process from 'node:process';

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const AUTO_REPOSITORY_VALUES = new Set(['auto']);

export function githubRepoValues(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRepository(owner, repo) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '')
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '');
  const repository = `${normalizedOwner}/${normalizedRepo}`;
  return GITHUB_REPOSITORY_PATTERN.test(repository) ? repository : null;
}

export function isAutoGitHubRepository(value) {
  return AUTO_REPOSITORY_VALUES.has(String(value || '').trim().toLowerCase());
}

export function parseGitHubRepository(remoteUrl) {
  let value = String(remoteUrl || '').trim();
  if (!value) return null;
  value = value.replace(/^git\+/, '');

  const scpLike = value.match(/^(?:[^@/\s]+@)?github\.com:([^/\s:]+)\/(.+)$/i);
  if (scpLike) {
    const repoPart = scpLike[2].replace(/\/+$/g, '');
    if (repoPart.includes('/')) return null;
    return normalizeRepository(scpLike[1], repoPart);
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return normalizeRepository(parts[0], parts[1]);
  } catch {
    return null;
  }
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return '';
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function discoverGitHubRepositoryFromGit({ cwd = process.cwd() } = {}) {
  const remoteNames = unique(runGit(['remote'], cwd).split('\n').map((item) => item.trim()));
  if (!remoteNames.length) {
    throw new Error(`Could not resolve GitHub repository from git remotes in ${cwd}. Run from a GitHub checkout or use --github-repo owner/repo.`);
  }

  const candidates = [];
  for (const remote of remoteNames) {
    const urls = runGit(['remote', 'get-url', '--all', remote], cwd)
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const url of urls) {
      const repository = parseGitHubRepository(url);
      if (repository) candidates.push({ remote, url, repository });
    }
  }

  const origin = candidates.find((candidate) => candidate.remote === 'origin');
  if (origin) return origin;

  const repositories = unique(candidates.map((candidate) => candidate.repository));
  if (repositories.length === 1) {
    return candidates.find((candidate) => candidate.repository === repositories[0]);
  }
  if (repositories.length > 1) {
    throw new Error(`Could not auto-select a GitHub repository from multiple git remotes in ${cwd}: ${repositories.join(', ')}. Use --github-repo owner/repo.`);
  }

  throw new Error(`Could not resolve GitHub repository from git remotes in ${cwd}. Run from a GitHub checkout or use --github-repo owner/repo.`);
}

export function resolveGitHubRepositories(values = [], { cwd = process.cwd() } = {}) {
  const inputValues = Array.isArray(values) ? values : [values];
  const tokens = inputValues.flatMap(githubRepoValues);
  const repositories = [];
  let discovered = null;

  for (const token of tokens) {
    if (isAutoGitHubRepository(token)) {
      discovered ||= discoverGitHubRepositoryFromGit({ cwd }).repository;
      repositories.push(discovered);
      continue;
    }
    if (!GITHUB_REPOSITORY_PATTERN.test(token)) {
      throw new Error(`Invalid GitHub repository "${token}". Use owner/repo or "auto" from a GitHub checkout, for example AmirTlinov/gpt-pro-cli.`);
    }
    repositories.push(token);
  }

  return unique(repositories);
}
