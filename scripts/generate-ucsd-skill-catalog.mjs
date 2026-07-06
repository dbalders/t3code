import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = process.cwd();
const defaultCatalogBaseUrl = "https://tritonai-skills-catalog.pages.dev";
const catalogBaseUrl = process.env.UCSD_SKILL_CATALOG_BASE_URL ?? defaultCatalogBaseUrl;
const generatedAt = process.env.UCSD_SKILL_CATALOG_GENERATED_AT ?? new Date().toISOString();

const sourceCandidates = [
  process.env.UCSD_SKILLS_LIBRARY,
  NodePath.join(repoRoot, "..", "UCSD-Skills-Library"),
  NodePath.join(repoRoot, "..", "..", "UCSD-Skills-Library"),
].filter(Boolean);

const sourceRoot = sourceCandidates.find((candidate) =>
  NodeFS.existsSync(NodePath.join(candidate, "ideas.json")),
);

if (!sourceRoot) {
  throw new Error(`Could not find UCSD-Skills-Library. Tried: ${sourceCandidates.join(", ")}`);
}

const ideas = JSON.parse(NodeFS.readFileSync(NodePath.join(sourceRoot, "ideas.json"), "utf8"));
const entries = [];
const bundles = {};

function posixPath(...segments) {
  return segments.join("/").replace(/\\/g, "/");
}

function walkFiles(root, prefix = "") {
  const files = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? posixPath(prefix, entry.name) : entry.name;
    const absolute = NodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

for (const idea of ideas) {
  if (!idea?.id || !idea?.name || idea.id === "_template") continue;
  const skillDir = NodePath.join(sourceRoot, "skills", idea.name);
  const skillEntrypoint = NodePath.join(skillDir, "SKILL.md");
  if (!NodeFS.existsSync(skillEntrypoint)) continue;

  const section = idea.tier === "core" ? "recommended" : "community";
  const sourceUrl = `${catalogBaseUrl.replace(/\/+$/u, "")}/skills/${idea.id}.json`;
  entries.push({
    id: idea.id,
    name: idea.name,
    title: idea.title ?? idea.name,
    description: idea.description ?? "No skill description provided.",
    category: idea.category ?? "Uncategorized",
    tier: idea.tier ?? "experimental",
    section,
    owner: idea.owner ?? "AI Tools",
    updated: idea.updated ?? generatedAt.slice(0, 10),
    sourceKind: "cloudflare",
    sourceUrl,
    readmeUrl: `https://github.com/dbalders/UCSD-Skills-Library/tree/main/skills/${idea.name}`,
  });

  bundles[idea.id] = {
    version: 1,
    skillId: idea.id,
    files: walkFiles(skillDir).map((relativePath) => ({
      path: relativePath,
      content: NodeFS.readFileSync(NodePath.join(skillDir, relativePath), "utf8"),
    })),
  };
}

entries.sort(
  (left, right) =>
    left.section.localeCompare(right.section) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id),
);

const catalog = {
  version: 1,
  generatedAt,
  sourceStatus: "remote",
  entries,
};

const publicRoot = NodePath.join(repoRoot, "infra", "skills-catalog", "public");
const publicSkillsRoot = NodePath.join(publicRoot, "skills");
NodeFS.mkdirSync(publicSkillsRoot, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(publicRoot, "catalog.json"),
  `${JSON.stringify(catalog, null, 2)}\n`,
);
for (const [id, bundle] of Object.entries(bundles)) {
  NodeFS.writeFileSync(
    NodePath.join(publicSkillsRoot, `${id}.json`),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
}

const serverDefaultsPath = NodePath.join(
  repoRoot,
  "apps",
  "server",
  "src",
  "provider",
  "skillCatalogDefaults.ts",
);

const serverDefaults = `import type {
  ServerProviderSkillBundle,
  ServerProviderSkillCatalog,
} from "@t3tools/contracts";

export const DEFAULT_UCSD_SKILL_CATALOG_URL = ${JSON.stringify(
  `${catalogBaseUrl.replace(/\/+$/u, "")}/catalog.json`,
)};

export const DEFAULT_UCSD_SKILL_CATALOG = ${JSON.stringify(
  { ...catalog, sourceStatus: "bundled-fallback" },
  null,
  2,
)} satisfies ServerProviderSkillCatalog;

export const DEFAULT_UCSD_SKILL_BUNDLES = ${JSON.stringify(
  bundles,
  null,
  2,
)} satisfies Readonly<Record<string, ServerProviderSkillBundle>>;
`;

NodeFS.writeFileSync(serverDefaultsPath, serverDefaults);
console.log(`Generated ${entries.length} UCSD skill catalog entries from ${sourceRoot}`);
