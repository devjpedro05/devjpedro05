import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const username = process.env.GITHUB_USERNAME || "devjpedro05";
const isGitHubActions = process.env.GITHUB_ACTIONS === "true";
const localGhToken = (() => {
  if (isGitHubActions) return "";

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
})();
const token =
  process.env.PROFILE_STATS_TOKEN ||
  process.env.GH_TOKEN ||
  localGhToken ||
  process.env.GITHUB_TOKEN ||
  "";
const canReadPrivateRepos = Boolean(
  process.env.PROFILE_STATS_TOKEN || process.env.GH_TOKEN || (!isGitHubActions && localGhToken),
);
const repoLimit = Number(process.env.REPO_LIMIT || 50);
const maxRows = Number(process.env.MAX_LANGUAGE_ROWS || 8);
const rootDir = process.cwd();
const assetsDir = path.join(rootDir, "assets");
const tempDir = path.join(os.tmpdir(), `language-lines-${Date.now()}`);

const extensionMap = new Map([
  [".asm", "Assembly"],
  [".s", "Assembly"],
  [".c", "C"],
  [".h", "C/C++"],
  [".cpp", "C++"],
  [".cc", "C++"],
  [".cxx", "C++"],
  [".hpp", "C++"],
  [".cs", "C#"],
  [".xaml", "XAML"],
  [".java", "Java"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".vue", "Vue"],
  [".py", "Python"],
  [".html", "HTML"],
  [".htm", "HTML"],
  [".css", "CSS"],
  [".scss", "CSS"],
  [".sass", "CSS"],
  [".sql", "SQL"],
  [".ps1", "PowerShell"],
  [".sh", "Shell"],
  [".razor", "Razor"],
  [".cshtml", "Razor"],
]);

const exactNameMap = new Map([
  ["dockerfile", "Dockerfile"],
  ["makefile", "Makefile"],
]);

const ignoredSegments = new Set([
  ".git",
  ".github",
  ".next",
  ".nuxt",
  "bin",
  "build",
  "coverage",
  "debug",
  "dist",
  "node_modules",
  "obj",
  "packages",
  "release",
  "vendor",
]);

const ignoredFiles = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "readme.md",
  "license",
]);

const palette = [
  "#22D3EE",
  "#38BDF8",
  "#8B5CF6",
  "#67E8F9",
  "#A78BFA",
  "#3ECF8E",
  "#F7DF1E",
  "#F97316",
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${username}-profile-language-lines`,
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${url}`);
  }

  return response.json();
}

async function listRepositories() {
  const repos = [];

  for (let page = 1; page <= 5; page += 1) {
    const url = canReadPrivateRepos
      ? `https://api.github.com/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`
      : `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=100&page=${page}`;
    const data = await githubJson(url);
    repos.push(...data);
    if (data.length < 100) break;
  }

  return repos
    .filter((repo) => !repo.owner || repo.owner.login.toLowerCase() === username.toLowerCase())
    .filter((repo) => !repo.fork && !repo.archived)
    .filter((repo) => repo.name.toLowerCase() !== username.toLowerCase())
    .slice(0, repoLimit);
}

function shouldIgnoreFile(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const fileName = normalized.split("/").pop();

  if (!fileName || ignoredFiles.has(fileName)) return true;
  if (normalized.endsWith(".min.js") || normalized.endsWith(".min.css")) return true;

  return normalized
    .split("/")
    .some((segment) => ignoredSegments.has(segment));
}

function languageForFile(filePath) {
  if (shouldIgnoreFile(filePath)) return null;

  const fileName = path.basename(filePath).toLowerCase();
  if (exactNameMap.has(fileName)) return exactNameMap.get(fileName);

  const ext = path.extname(fileName);
  return extensionMap.get(ext) || null;
}

function cloneRepository(repo, destination) {
  const authUrl =
    token && repo.clone_url.startsWith("https://github.com/")
      ? repo.clone_url.replace("https://github.com/", `https://x-access-token:${token}@github.com/`)
      : repo.clone_url;

  const baseArgs = [
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    "--single-branch",
    "--branch",
    repo.default_branch,
    authUrl,
    destination,
  ];

  try {
    run("git", baseArgs);
  } catch {
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", authUrl, destination]);
  }
}

function countAddedLines(repoDir, totals, repoName) {
  let output = "";

  try {
    output = run("git", ["-C", repoDir, "log", "--numstat", "--pretty=format:", "--no-renames"]);
  } catch {
    return;
  }

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match || match[1] === "-") continue;

    const added = Number(match[1]);
    if (!Number.isFinite(added) || added <= 0) continue;

    const language = languageForFile(match[3]);
    if (!language) continue;

    const current = totals.get(language) || { lines: 0, repos: new Set() };
    current.lines += added;
    current.repos.add(repoName);
    totals.set(language, current);
  }
}

function escapeSvg(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function createSvg(rows) {
  const total = rows.reduce((sum, row) => sum + row.lines, 0);
  const visibleRows = rows.slice(0, maxRows);
  const width = 760;
  const rowHeight = 46;
  const height = 124 + visibleRows.length * rowHeight;
  const max = Math.max(...visibleRows.map((row) => row.lines), 1);

  const bars = visibleRows
    .map((row, index) => {
      const y = 102 + index * rowHeight;
      const pct = total ? (row.lines / total) * 100 : 0;
      const barWidth = Math.max(18, Math.round((row.lines / max) * 430));
      const color = palette[index % palette.length];

      return `
  <g>
    <text x="34" y="${y + 15}" fill="#E2E8F0" font-size="15" font-weight="600">${escapeSvg(row.language)}</text>
    <text x="34" y="${y + 34}" fill="#94A3B8" font-size="12">${compactNumber(row.lines)} linhas adicionadas</text>
    <rect x="220" y="${y + 4}" width="430" height="12" rx="6" fill="#1E293B" opacity="0.95"/>
    <rect x="220" y="${y + 4}" width="${barWidth}" height="12" rx="6" fill="${color}"/>
    <text x="676" y="${y + 15}" fill="#CBD5E1" font-size="13" text-anchor="end">${pct.toFixed(1)}%</text>
  </g>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Linguagens por linhas criadas</title>
  <desc id="desc">Grafico com linguagens calculadas por linhas adicionadas nos repositorios publicos de ${username}.</desc>
  <rect width="${width}" height="${height}" rx="18" fill="#0F172A"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="17" stroke="#334155" opacity="0.65"/>
  <circle cx="638" cy="38" r="118" fill="#22D3EE" opacity="0.08"/>
  <circle cx="704" cy="74" r="96" fill="#8B5CF6" opacity="0.08"/>
  <text x="34" y="42" fill="#F8FAFC" font-size="22" font-weight="700">Linguagens por linhas criadas</text>
  <text x="34" y="68" fill="#94A3B8" font-size="13">Baseado em linhas adicionadas nos commits dos repositorios publicos</text>
  <text x="726" y="68" fill="#67E8F9" font-size="13" font-weight="600" text-anchor="end">${compactNumber(total)} linhas</text>
${bars}
</svg>
`;
}

function writeFallbackSvg() {
  const fallbackRows = [
    { language: "JavaScript", lines: 1 },
    { language: "C#", lines: 1 },
    { language: "Vue", lines: 1 },
  ];

  writeFileSync(path.join(assetsDir, "languages-by-lines.svg"), createSvg(fallbackRows));
  writeFileSync(
    path.join(assetsDir, "languages-by-lines.json"),
    JSON.stringify({ rows: fallbackRows, fallback: true }, null, 2),
  );
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  const totals = new Map();

  try {
    const repos = await listRepositories();

    for (const repo of repos) {
      const repoDir = path.join(tempDir, repo.name);
      try {
        cloneRepository(repo, repoDir);
        countAddedLines(repoDir, totals, repo.name);
      } catch (error) {
        console.warn(`Skipping ${repo.full_name}: ${error.message}`);
      }
    }
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const rows = Array.from(totals.entries())
    .map(([language, data]) => ({
      language,
      lines: data.lines,
      repositories: Array.from(data.repos).sort(),
    }))
    .sort((a, b) => b.lines - a.lines);

  if (rows.length === 0) {
    writeFallbackSvg();
    return;
  }

  writeFileSync(path.join(assetsDir, "languages-by-lines.svg"), createSvg(rows));
  writeFileSync(
    path.join(assetsDir, "languages-by-lines.json"),
    JSON.stringify({ username, rows }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
