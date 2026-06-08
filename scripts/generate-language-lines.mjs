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
  const width = 860;
  const rowHeight = 54;
  const height = 168 + visibleRows.length * rowHeight;
  const max = Math.max(...visibleRows.map((row) => row.lines), 1);
  const scopeLabel = canReadPrivateRepos
    ? "Repositórios públicos e privados autorizados"
    : "Repositórios públicos";
  const topLanguage = visibleRows[0]?.language || "N/A";
  const topLines = visibleRows[0]?.lines || 0;

  const bars = visibleRows
    .map((row, index) => {
      const y = 142 + index * rowHeight;
      const pct = total ? (row.lines / total) * 100 : 0;
      const barWidth = Math.max(20, Math.round((row.lines / max) * 458));
      const color = palette[index % palette.length];
      const rank = String(index + 1).padStart(2, "0");
      const opacity = index === 0 ? "1" : "0.82";

      return `
  <g opacity="${opacity}">
    <rect x="28" y="${y - 19}" width="804" height="46" rx="14" fill="${index === 0 ? "url(#featuredRow)" : "#111C32"}" opacity="${index === 0 ? "0.75" : "0.34"}"/>
    <text x="48" y="${y + 4}" fill="#64748B" font-size="11" font-weight="700" letter-spacing="1.4">${rank}</text>
    <text x="82" y="${y + 4}" fill="#F8FAFC" font-size="16" font-weight="700">${escapeSvg(row.language)}</text>
    <text x="82" y="${y + 23}" fill="#93C5FD" font-size="12">${compactNumber(row.lines)} linhas adicionadas</text>
    <rect x="252" y="${y - 4}" width="458" height="12" rx="6" fill="#223047" opacity="0.9"/>
    <rect x="252" y="${y - 4}" width="${barWidth}" height="12" rx="6" fill="${color}" filter="${index === 0 ? "url(#barGlow)" : "none"}"/>
    <rect x="730" y="${y - 14}" width="70" height="28" rx="14" fill="#0B1224" stroke="#263853"/>
    <text x="765" y="${y + 4}" fill="#E0F2FE" font-size="12" font-weight="700" text-anchor="middle">${pct.toFixed(1)}%</text>
  </g>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" font-family="Segoe UI, Arial, sans-serif" text-rendering="geometricPrecision">
  <title id="title">Linguagens por linhas criadas</title>
  <desc id="desc">Gráfico com linguagens calculadas por linhas adicionadas nos repositórios autorizados de ${username}.</desc>
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="${width}" y2="${height}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0B1120"/>
      <stop offset="56%" stop-color="#111A2F"/>
      <stop offset="100%" stop-color="#0A1020"/>
    </linearGradient>
    <linearGradient id="cardStroke" x1="0" y1="0" x2="${width}" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#22D3EE" stop-opacity="0.5"/>
      <stop offset="48%" stop-color="#334155" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="featuredRow" x1="28" y1="0" x2="832" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#22D3EE" stop-opacity="0.12"/>
      <stop offset="42%" stop-color="#1E293B" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.12"/>
    </linearGradient>
    <radialGradient id="cornerGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(700 36) rotate(138) scale(220 170)">
      <stop stop-color="#22D3EE" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="#38BDF8" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#38BDF8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="violetGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(804 78) rotate(143) scale(190 150)">
      <stop stop-color="#8B5CF6" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/>
    </radialGradient>
    <filter id="barGlow" x="-20%" y="-240%" width="140%" height="580%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.13 0 0 0 0 0.83 0 0 0 0 0.93 0 0 0 0.55 0" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <pattern id="grid" width="38" height="38" patternUnits="userSpaceOnUse">
      <path d="M 38 0 L 0 0 0 38" fill="none" stroke="#38BDF8" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" rx="24" fill="url(#cardBg)"/>
  <rect width="${width}" height="${height}" rx="24" fill="url(#grid)"/>
  <rect width="${width}" height="${height}" rx="24" fill="url(#cornerGlow)"/>
  <rect width="${width}" height="${height}" rx="24" fill="url(#violetGlow)"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="23" stroke="url(#cardStroke)" stroke-opacity="0.72"/>
  <rect x="28" y="28" width="112" height="28" rx="14" fill="#0B1224" stroke="#263853"/>
  <text x="84" y="46" fill="#67E8F9" font-size="11" font-weight="800" letter-spacing="1.8" text-anchor="middle">MÉTRICA</text>
  <text x="28" y="88" fill="#F8FAFC" font-size="27" font-weight="800">Linguagens por linhas criadas</text>
  <text x="28" y="114" fill="#94A3B8" font-size="13">${scopeLabel}</text>
  <rect x="586" y="30" width="246" height="76" rx="20" fill="#0B1224" fill-opacity="0.72" stroke="#263853"/>
  <text x="610" y="58" fill="#94A3B8" font-size="12" font-weight="600">Principal</text>
  <text x="610" y="86" fill="#F8FAFC" font-size="24" font-weight="800">${escapeSvg(topLanguage)}</text>
  <text x="808" y="84" fill="#67E8F9" font-size="13" font-weight="800" text-anchor="end">${compactNumber(topLines)} linhas</text>
  <text x="808" y="112" fill="#93C5FD" font-size="12" font-weight="700" text-anchor="end">${compactNumber(total)} linhas no total</text>
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
